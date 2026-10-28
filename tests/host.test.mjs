// Multiplayer test: browser-hosted rooms over an in-memory broker that behaves like MQTT
// (retained messages, wildcards, last-will). Run: node tests/host.test.mjs
import { MemoryBroker, T, randomId } from "../docs/net.js";
import { RoomHost, pickFreeCode } from "../docs/host.js";
import { templateNarration } from "../docs/engine.js";

let failed = 0;
const ok = (c, m) => { if (c) console.log("ok  ", m); else { failed++; console.error("FAIL", m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const broker = new MemoryBroker();

/** A headless player: the same protocol the page speaks. */
function player(name, cls, { idle = false } = {}) {
  const bus = broker.connect();
  const p = { bus, name, cls, cid: randomId(), seat: null, code: null, state: null, res: [], nar: [], acks: new Map(), list: new Map() };
  bus.subscribe(T.client(p.cid));
  bus.subscribe(T.listAll());
  bus.on("message", (t, o) => {
    if (t.startsWith(T.list(""))) { const code = t.split("/").pop(); o ? p.list.set(code, o) : p.list.delete(code); return; }
    if (t === T.client(p.cid) && o) { const r = p.acks.get(o.nonce); if (r) { p.acks.delete(o.nonce); r(o); } return; }
    if (p.code && t === T.state(p.code)) { p.state = o; if (!idle) act(p); return; }
    if (p.code && t === T.events(p.code) && o) { if (o.t === "res") p.res.push(o.res); if (o.t === "nar") p.nar.push(o); }
  });
  return p;
}
function send(p, msg, timeout = 1000) {
  const nonce = randomId(6);
  return new Promise((resolve) => {
    p.acks.set(nonce, resolve);
    p.bus.publish(T.input(p.code), { ...msg, cid: p.cid, nonce, pid: p.seat?.pid, token: p.seat?.token });
    setTimeout(() => { if (p.acks.delete(nonce)) resolve({ ok: false, error: "timeout" }); }, timeout);
  });
}
async function join(p, code, seat) {
  p.code = code;
  p.bus.subscribe(T.state(code));
  p.bus.subscribe(T.events(code));
  if (seat) p.seat = seat;
  const r = await send(p, { t: "join", name: p.name, cls: p.cls });
  if (r.ok) p.seat = { pid: r.pid, token: r.token };
  return r;
}
function act(p) {
  const st = p.state;
  if (!st || st.closed || st.phase !== "COMMIT" || !p.seat) return;
  const me = st.entities.find((e) => e.id === p.seat.pid);
  const mem = st.members.find((m) => m.id === p.seat.pid);
  if (!me || me.hp <= 0 || !mem || mem.locked || p.sentRound === st.round) return;
  p.sentRound = st.round;
  const foe = st.entities.find((e) => e.kind === "monster" && e.hp > 0);
  send(p, { t: "action", round: st.round, type: me.cls === "wizard" ? "spell" : "attack", targetId: foe?.id });
}

const narrate = async (ctx) => ({ text: ctx.intro || templateNarration(ctx), source: "built-in" });
async function makeRoom(creator, visibility, opts = {}) {
  const code = await pickFreeCode(creator.bus, 50);
  const hostBus = broker.connect({ will: { topic: T.state(code), payload: { closed: true, code } } });
  const host = new RoomHost(hostBus, { code, visibility, creatorCid: creator.cid, narrate, commitMs: 400, endMs: 300, ...opts });
  host.start();
  await wait(60);
  return { code, host, hostBus };
}

// ---------- create rooms ----------
const A = player("Aldric", "fighter"), Z = player("Zara", "wizard"), I = player("Idle", "cleric", { idle: true });
const H = player("Hidden", "rogue"), F = player("Friend", "cleric"), V = player("Viewer", "rogue");

const pub = await makeRoom(A, "public");
ok(/^\d{4}$/.test(pub.code) && pub.code !== "5467", `public room gets its own code ${pub.code}`);
const priv = await makeRoom(H, "private");
ok(priv.code !== pub.code, `private room gets a different code ${priv.code}`);
ok((await pickFreeCode(V.bus, 50)) !== pub.code, "code picker avoids live rooms");

ok((await join(A, pub.code)).ok, "creator joins their own room");
ok((await join(H, priv.code)).ok, "private creator joins");
await wait(60);
ok(V.list.has(pub.code), "public room appears in the server browser");
ok(!V.list.has(priv.code), "private room is hidden from the server browser");
ok(V.list.get(pub.code)?.host === "Aldric", "browser shows the host name");
ok((await join(F, priv.code)).ok, "private room joinable by code");
const ghost = player("Ghost", "rogue");
ghost.code = "0000"; ghost.bus.subscribe(T.state("0000"));
ok((await send(ghost, { t: "join", name: "Ghost", cls: "rogue" }, 300)).error === "timeout", "unknown code gets no answer (page shows 'no room')");

// ---------- lobby rules ----------
ok((await join(Z, pub.code)).ok, "second player joins public room");
ok((await join(I, pub.code)).ok, "third player joins public room");
const dup = player("aldric", "rogue");
ok(!(await join(dup, pub.code)).ok, "duplicate name rejected");
const bad = player("", "rogue");
ok(!(await join(bad, pub.code)).ok, "empty name rejected");
const badCls = player("Bard", "bard");
ok(!(await join(badCls, pub.code)).ok, "unknown class rejected");
await wait(60);
ok(V.list.get(pub.code)?.players === 3, "browser shows the player count");
ok(!(await send(Z, { t: "start" })).ok, "only the creator can start");

// ---------- spoofing ----------
const spoof = player("Spoof", "rogue");
spoof.code = pub.code; spoof.seat = { pid: Z.seat.pid, token: "wrong" };
ok(!(await send(spoof, { t: "start" })).ok, "forged token is rejected");

// ---------- battle ----------
ok((await send(A, { t: "start" })).ok, "creator starts the battle");
await wait(80);
const late = player("Late", "rogue");
ok(!(await join(late, pub.code)).ok, "late joiner rejected mid-battle");
ok(V.list.get(pub.code)?.joinable === false, "browser marks the room as in battle");
const st = A.state;
const dbl = await send(A, { t: "action", round: st.round, type: "defend" });
ok(dbl.ok === false && /already/i.test(dbl.error), "second action in a round is refused (lock-in)");
ok(!(await send(Z, { t: "action", round: 999, type: "attack" })).ok, "stale round number refused");

for (let i = 0; i < 200 && A.state?.phase !== "ENDED"; i++) await wait(50);
ok(A.state.phase === "ENDED", `battle ends: ${A.state.outcome} after ${A.res.length} rounds`);
ok(A.res.some((r) => r.events.some((e) => e.kind === "timeout")), "idle player auto-defends on timeout (no deadlock)");
ok(A.nar.some((n) => n.round === 0), "scene intro narrated");
ok(A.nar.filter((n) => n.round > 0).length === A.res.length, "every round narrated");
const allSeeSame = JSON.stringify(A.res) === JSON.stringify(Z.res) && JSON.stringify(Z.res) === JSON.stringify(I.res);
ok(allSeeSame, "every player saw identical results");
await wait(450);
ok(A.state.phase === "LOBBY", "room returns to its lobby");
ok(A.state.depth === (A.state.outcome === null && A.res.at(-1).outcome === "victory" ? 2 : 1), `depth advances on victory (depth ${A.state.depth})`);

// ---------- disconnect mid-round does not stall ----------
ok((await send(A, { t: "start" })).ok, "second battle starts");
await wait(50);
const before = A.res.length;
I.bus.end(); // idle player vanishes
await wait(1200);
ok(A.res.length > before, "fight continues after a player disappears");

// ---------- reconnect with seat token ----------
const Z2 = player("Zara", "wizard");
const back = await join(Z2, pub.code, { pid: Z.seat.pid, token: Z.seat.token });
ok(back.ok && back.pid === Z.seat.pid, "player reconnects to the same seat mid-battle");
Z.bus.end();

// ---------- host loses connection: last will closes the room ----------
pub.hostBus.drop();
await wait(60);
ok(A.state?.closed === true, "host disconnect publishes 'closed' (last will)");

// ---------- normal close clears the listing ----------
priv.host.close();
await wait(60);
ok(F.state?.closed === true && F.state.final === true, "closing a room tells everyone");
const pub2 = await makeRoom(V, "public");
await join(V, pub2.code);
await wait(60);
ok(F.list.has(pub2.code), "new public room listed");
pub2.host.close();
await wait(60);
ok(!F.list.has(pub2.code), "closed public room disappears from the browser");

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nhost: all checks passed");
process.exit(0);
