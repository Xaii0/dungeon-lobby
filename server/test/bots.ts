// Smoke test for the entry code, public/private rooms, server browser, lock-in, timeouts and combat.
// Run the server first:  COMMIT_SECONDS=3 npm start    then:  npm run test:bots
import { io } from "socket.io-client";

const URL = process.env.URL || "http://localhost:3000";
const ENTRY = "5467";
const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  ", m); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (s: any, ev: string, p: any) => new Promise<any>((r) => s.emit(ev, p, r));

function client(name: string, cls: string, idle = false) {
  const s = io(URL, { forceNew: true });
  const b: any = { s, name, cls, id: "", state: null, resolutions: [], narrations: [], rooms: [] };
  s.on("rooms", (l) => (b.rooms = l));
  s.on("resolution", (r) => b.resolutions.push(r));
  s.on("narration", (n) => b.narrations.push(n));
  s.on("state", (st) => {
    b.state = st;
    const me = st.entities.find((e: any) => e.id === b.id);
    const mem = st.members.find((m: any) => m.id === b.id);
    if (idle || st.phase !== "COMMIT" || !me || me.hp <= 0 || mem?.locked) return;
    const foe = st.entities.find((e: any) => e.kind === "monster" && e.hp > 0);
    const hurt = st.entities.find((e: any) => e.kind === "player" && e.hp > 0 && e.hp < e.maxHp * 0.5);
    const type = me.cls === "cleric" && hurt ? "heal" : me.cls === "wizard" ? "spell" : "attack";
    s.emit("action", { roomCode: st.code, round: st.round, type, targetId: type === "heal" ? hurt.id : foe?.id }, () => {});
  });
  return b;
}
const enter = (b: any, code = ENTRY) => call(b.s, "enter", { entryCode: code, name: b.name, cls: b.cls });

// --- entry code gate ---
const gate = client("Nope", "rogue");
assert(!(await enter(gate, "1111")).ok, "wrong entry code rejected");
assert(!(await call(gate.s, "create", { visibility: "public" })).ok, "cannot create a room before entering");
assert((await enter(gate)).ok, "entry code 5467 accepted");

// --- host creates a PUBLIC room, another a PRIVATE one ---
const host = client("Aldric", "fighter"); await enter(host);
const pub = await call(host.s, "create", { visibility: "public" });
assert(pub.ok && /^\d{4}$/.test(pub.code) && pub.code !== ENTRY, `public room created with own code ${pub.code}`);
host.id = pub.playerId;

const hid = client("Hidden", "rogue"); await enter(hid);
const priv = await call(hid.s, "create", { visibility: "private" });
assert(priv.ok && priv.code !== pub.code, `private room created with its own code ${priv.code}`);

await wait(500);
const listed = (await call(gate.s, "browse", {})).rooms.map((r: any) => r.code);
assert(listed.includes(pub.code), "public room appears in server browser");
assert(!listed.includes(priv.code), "private room is hidden from server browser");

// --- join by code (private works with the code) ---
const friend = client("Friend", "cleric"); await enter(friend);
const j = await call(friend.s, "join", { code: priv.code });
assert(j.ok, "private room joinable with its code");
assert(!(await call(friend.s, "join", { code: "9999" })).ok || priv.code === "9999", "unknown room code rejected");

// --- fill the public room: wizard + idle cleric (idle exercises the timeout path) ---
const z = client("Zara", "wizard"); await enter(z); z.id = (await call(z.s, "join", { code: pub.code })).playerId;
const idle = client("Idle", "cleric", true); await enter(idle); idle.id = (await call(idle.s, "join", { code: pub.code })).playerId;
const dup = client("aldric", "rogue"); await enter(dup);
assert(!(await call(dup.s, "join", { code: pub.code })).ok, "duplicate name rejected in the same room");
await wait(300);

assert(!(await call(z.s, "start", {})).ok, "non-host cannot start");
assert((await call(host.s, "start", {})).ok, "host starts battle");
await wait(300);
const late = client("Late", "rogue"); await enter(late);
assert(!(await call(late.s, "join", { code: pub.code })).ok, "late joiner rejected mid-battle");

// --- lock-in: second action in a round is refused ---
const st = host.state;
await call(host.s, "action", { roomCode: pub.code, round: st.round, type: "defend" });
const dbl = await call(host.s, "action", { roomCode: pub.code, round: st.round, type: "attack" });
assert(!dbl.ok, "second action in the same round rejected (lock-in)");

const deadline = Date.now() + 90_000;
while (host.state?.phase !== "ENDED" && Date.now() < deadline) await wait(200);
assert(host.state.phase === "ENDED", `battle ended: ${host.state.outcome} after ${host.resolutions.length} rounds`);
assert(host.resolutions.some((r: any) => r.events.some((e: any) => e.kind === "timeout")), "idle player auto-defended on timeout (no deadlock)");
await wait(500);
assert(host.narrations.length > 0, `narration received (${host.narrations[0]?.source})`);
console.log("sample narration:", host.narrations[0]?.text);

// --- room returns to its lobby, then host leaves and the room list updates ---
await wait(21_000);
assert(host.state.phase === "LOBBY", "room returns to lobby after the battle");
process.exit(0);
