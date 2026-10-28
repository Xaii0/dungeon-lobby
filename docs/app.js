// Page logic: entry code -> hub (server browser, create, join) -> room (lobby, combat, story).
import { CLASSES } from "./engine.js";
import { T, connectBus, randomId } from "./net.js";
import { RoomHost, ENTRY_CODE, pickFreeCode } from "./host.js";
import { narrate, narratorMode, stats as narratorStats } from "./narrator.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};
const ss = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
  del: (k) => { try { sessionStorage.removeItem(k); } catch {} },
};

const NET = new URLSearchParams(location.search).get("net") === "local" ? "local" : "mqtt";
const cid = ss.get("dl:cid") || randomId();
ss.set("dl:cid", cid);

const app = {
  bus: null, profile: null, cls: ls.get("dl:cls") || "fighter", vis: "public",
  rooms: new Map(), // code -> listing
  me: null,         // { code, pid, token, visibility }
  state: null, rid: null, v: 0, receivedAt: 0,
  host: null, hostBus: null,
  acks: new Map(),
  target: null, mode: "attack",
  closedTimer: null, pingIv: null,
  logRounds: new Set(), narRounds: new Set(),
};

// ---------------- screens & small UI helpers ----------------
function show(which) { for (const s of ["entry", "hub", "room"]) $(s).classList.toggle("hidden", s !== which); }
function flash(id, msg) { $(id).textContent = msg || ""; }
function busy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = label; }
function setNet(status) {
  const b = app.bus ? app.bus.broker : "";
  $("netStatus").textContent = status === "online" ? `Online${b && b !== "local" ? " · " + b : b === "local" ? " · local test mode" : ""}`
    : status === "reconnecting" ? "Reconnecting…" : status === "offline" ? "Offline: retrying…" : status;
  $("netDot").className = "dot " + (status === "online" ? "on" : "off");
}

// ---------------- entry ----------------
$("classes").innerHTML = Object.entries(CLASSES).map(([k, c]) => `<button type="button" data-c="${k}"><b>${c.label}</b><span>${c.blurb}</span></button>`).join("");
function paintClass() { document.querySelectorAll("#classes button").forEach((b) => b.classList.toggle("sel", b.dataset.c === app.cls)); }
$("classes").onclick = (e) => { const b = e.target.closest("button"); if (b) { app.cls = b.dataset.c; paintClass(); } };
paintClass();
$("name").value = ls.get("dl:name") || "";
const hashCode = () => (location.hash.match(/^#(\d{4})$/) || [])[1] || null;
if (hashCode()) $("inviteNote").textContent = `You were invited to room ${hashCode()}. Enter the entry code to join.`;

$("entryForm").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("name").value.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 20);
  if (!name) return flash("entryErr", "Enter a name.");
  if ($("entryCode").value.trim() !== ENTRY_CODE) return flash("entryErr", "That entry code is not right.");
  flash("entryErr", "");
  app.profile = { name, cls: app.cls };
  ls.set("dl:name", name); ls.set("dl:cls", app.cls); ss.set("dl:entered", "1");
  await goOnline();
};

async function goOnline() {
  const btn = $("btnEnter");
  busy(btn, true, "Connecting…");
  try {
    if (!app.bus) {
      app.bus = await connectBus(NET);
      app.bus.on("message", onMessage);
      app.bus.on("status", (s) => { setNet(s); if (s === "online" && app.me) ping(); });
      app.bus.subscribe(T.client(cid));
      app.bus.subscribe(T.listAll());
      setNet("online");
    }
    $("hello").textContent = `${app.profile.name} the ${CLASSES[app.profile.cls].label}`;
    show("hub");
    renderRooms();
    const resume = hashCode() || ss.get("dl:room");
    if (resume) await joinRoom(resume, { quiet: !hashCode() });
  } catch (err) {
    show("entry");
    flash("entryErr", err.message || String(err));
  } finally {
    busy(btn, false, "Enter");
  }
}

// ---------------- network messages ----------------
function onMessage(topic, o) {
  if (topic.startsWith(T.list(""))) {
    const code = topic.slice(T.list("").length);
    if (o && o.code === code) app.rooms.set(code, o); else app.rooms.delete(code);
    return renderRoomsSoon();
  }
  if (topic === T.client(cid)) {
    if (o && o.nonce && app.acks.has(o.nonce)) { const r = app.acks.get(o.nonce); app.acks.delete(o.nonce); r(o); }
    return;
  }
  const code = app.me?.code || app.joining;
  if (!code) return;
  if (topic === T.state(code)) return onState(o);
  if (topic === T.events(code) && o && app.me) {
    if (o.t === "res") addResolution(o.res);
    if (o.t === "nar") addNarration(o);
  }
}

function sendInput(code, msg, timeout = 8000) {
  const nonce = randomId(8);
  return new Promise((resolve) => {
    app.acks.set(nonce, resolve);
    const seat = app.me && app.me.code === code ? { pid: app.me.pid, token: app.me.token } : {};
    app.bus.publish(T.input(code), { ...msg, ...seat, ...(msg.pid ? { pid: msg.pid, token: msg.token } : {}), cid, nonce });
    setTimeout(() => { if (app.acks.delete(nonce)) resolve({ ok: false, error: "The room's host is not responding." }); }, timeout);
  });
}
function ping() { if (app.me) app.bus.publish(T.input(app.me.code), { t: "ping", pid: app.me.pid, token: app.me.token, cid }); }

// ---------------- hub: server browser ----------------
let roomsTimer = null;
function renderRoomsSoon() { clearTimeout(roomsTimer); roomsTimer = setTimeout(renderRooms, 150); }
function renderRooms() {
  const now = Date.now();
  const list = [...app.rooms.values()]
    .filter((r) => Math.abs(now - r.ts) < 90000)
    .sort((a, b) => Number(b.joinable) - Number(a.joinable) || b.ts - a.ts);
  const q = $("search").value.trim();
  const shown = q ? list.filter((r) => r.code.includes(q) || String(r.host).toLowerCase().includes(q.toLowerCase())) : list;
  $("roomCount").textContent = list.length ? `${list.length} open` : "";
  $("roomList").innerHTML = shown.length ? shown.map((r) => `
    <div class="room-card">
      <div class="rc-top"><span class="rcode">${esc(r.code)}</span><span class="tag ${r.joinable ? "ok" : ""}">${r.joinable ? "waiting" : r.phase === "LOBBY" ? "full" : "in battle"}</span></div>
      <div class="mute">Host: ${esc(r.host)} · ${r.players}/${r.max} players · depth ${r.depth || 1}</div>
      <button data-join="${esc(r.code)}" ${r.joinable ? "" : "disabled"}>${r.joinable ? "Join" : "Unavailable"}</button>
    </div>`).join("")
    : `<div class="empty">${q ? "No public room matches that." : "No public rooms right now. Create one, or join a private room with its code."}</div>`;
}
setInterval(() => { if (!$("hub").classList.contains("hidden")) renderRooms(); }, 5000);
$("search").oninput = renderRooms;
$("roomList").onclick = (e) => { const b = e.target.closest("button[data-join]"); if (b && !b.disabled) joinRoom(b.dataset.join); };
$("joinForm").onsubmit = (e) => { e.preventDefault(); joinRoom($("joinCode").value.trim()); };
$("vis").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  app.vis = b.dataset.v;
  document.querySelectorAll("#vis button").forEach((x) => x.classList.toggle("sel", x === b));
  $("visHelp").textContent = app.vis === "public" ? "Listed in the server browser. Anyone can join." : "Hidden. Only people you give the code to can join.";
};

// ---------------- create a room (this browser becomes its host) ----------------
$("btnCreate").onclick = async () => {
  const btn = $("btnCreate");
  flash("hubErr", "");
  busy(btn, true, "Creating…");
  try {
    if (app.me) await leaveRoom(true);
    const code = await pickFreeCode(app.bus);
    app.hostBus = await connectBus(NET, { will: { topic: T.state(code), payload: { closed: true, code } } });
    app.host = new RoomHost(app.hostBus, { code, visibility: app.vis, creatorCid: cid, narrate, narratorMode });
    app.host.start();
    ss.set("dl:hosting", code);
    await joinRoom(code);
  } catch (err) {
    flash("hubErr", err.message || String(err));
    stopHosting();
  } finally {
    busy(btn, false, "Create room");
  }
};
function stopHosting() {
  if (app.host) app.host.close();
  if (app.hostBus) setTimeout(((b) => () => b.end())(app.hostBus), 500);
  app.host = null; app.hostBus = null;
  ss.del("dl:hosting");
}
addEventListener("beforeunload", (e) => { if (app.host && !app.host.closed) { e.preventDefault(); e.returnValue = ""; } });

// ---------------- join / leave ----------------
async function joinRoom(code, { quiet = false } = {}) {
  flash("hubErr", "");
  if (!/^\d{4}$/.test(code || "")) return flash("hubErr", "Room codes are 4 digits.");
  if (code === ENTRY_CODE) return flash("hubErr", "5467 is the entry code. Ask your friend for their room's code.");
  if (app.me && app.me.code === code) return show("room");
  if (app.me) await leaveRoom(true);
  app.joining = code;
  app.state = null; app.rid = null; app.v = 0;
  app.bus.subscribe(T.state(code));
  app.bus.subscribe(T.events(code));
  $("joinBtn").disabled = true;
  try {
    // A live room always has a retained state message.
    for (let i = 0; i < 40 && !app.state; i++) await new Promise((r) => setTimeout(r, 100));
    if (!app.state) throw new Error(`No room with code ${code}.`);
    if (app.state.closed) throw new Error(`Room ${code} has closed.`);
    const saved = JSON.parse(ss.get("dl:seat:" + code) || "null");
    const r = await sendInput(code, { t: "join", name: app.profile.name, cls: app.profile.cls, ...(saved ? { pid: saved.pid, token: saved.token } : {}) });
    if (!r.ok) throw new Error(r.error || "Could not join.");
    app.me = { code, pid: r.pid, token: r.token, visibility: r.visibility };
    ss.set("dl:seat:" + code, JSON.stringify({ pid: r.pid, token: r.token }));
    ss.set("dl:room", code);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    enterRoomView();
  } catch (err) {
    app.bus.unsubscribe(T.state(code));
    app.bus.unsubscribe(T.events(code));
    app.state = null;
    ss.del("dl:room");
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    if (!quiet) flash("hubErr", err.message || String(err));
    show("hub");
  } finally {
    app.joining = null;
    $("joinBtn").disabled = false;
  }
}

function enterRoomView() {
  $("roomCode").textContent = app.me.code;
  const priv = app.me.visibility === "private";
  $("visTag").textContent = priv ? "private" : "public";
  $("visTag").className = "tag " + (priv ? "gold" : "ok");
  $("shareHelp").textContent = priv ? "Private room: share this code. It is not listed in the server browser." : "Public room: it is listed in the server browser, or share the code.";
  $("log").innerHTML = ""; $("story").innerHTML = "";
  for (const id of ["enemies", "party", "actions", "lobbyMembers"]) $(id).__html = null;
  app.logRounds.clear(); app.narRounds.clear();
  $("hostNote").classList.toggle("hidden", !app.host);
  clearInterval(app.pingIv);
  app.pingIv = setInterval(ping, 8000);
  show("room");
  render();
}

async function leaveRoom(silent = false) {
  if (!app.me) return;
  const code = app.me.code;
  if (!silent && app.host && !confirm("You are hosting this room. Leaving closes it for everyone. Leave?")) return;
  app.bus.publish(T.input(code), { t: "leave", pid: app.me.pid, token: app.me.token, cid });
  if (app.host && app.host.code === code) stopHosting();
  clearInterval(app.pingIv);
  clearTimeout(app.closedTimer);
  app.bus.unsubscribe(T.state(code));
  app.bus.unsubscribe(T.events(code));
  ss.del("dl:seat:" + code); ss.del("dl:room");
  app.me = null; app.state = null;
  $("closedBanner").classList.add("hidden");
  show("hub");
  renderRooms();
}
$("btnLeave").onclick = () => leaveRoom(false);
$("btnCopy").onclick = async () => {
  const link = `${location.origin}${location.pathname}#${app.me.code}`;
  try { await navigator.clipboard.writeText(link); $("btnCopy").textContent = "Link copied!"; }
  catch { prompt("Copy this invite link:", link); }
  setTimeout(() => ($("btnCopy").textContent = "Copy invite link"), 1600);
};
$("btnStart").onclick = async () => {
  busy($("btnStart"), true);
  const r = await sendInput(app.me.code, { t: "start" });
  if (!r.ok) flash("lobbyNote", r.error);
  busy($("btnStart"), false);
};

// ---------------- room state ----------------
function onState(o) {
  if (!o) return;
  if (o.rid && o.rid === app.rid && o.v <= app.v && !o.closed) return; // stale
  if (o.closed) {
    if (app.rid && o.rid && o.rid !== app.rid) return; // closure of an older room with this code
    app.state = app.state && !app.state.closed ? app.state : o;
    if (app.me && !app.host) {
      $("closedBanner").classList.remove("hidden");
      $("closedBanner").textContent = o.final ? "The host closed this room." : "The host lost connection. Waiting for them to come back…";
      clearTimeout(app.closedTimer);
      app.closedTimer = setTimeout(() => { if (app.me) { leaveRoom(true); flash("hubErr", "The room closed because its host left."); } }, o.final ? 3000 : 60000);
    } else if (!app.me) app.state = o;
    return;
  }
  clearTimeout(app.closedTimer);
  $("closedBanner").classList.add("hidden");
  app.rid = o.rid; app.v = o.v; app.state = o; app.receivedAt = Date.now();
  if (app.me) render();
}

const COND = (e) => (e.hp <= 0 ? "down" : `${e.hp}/${e.maxHp} HP`);
/** Only touch the DOM when markup really changed, so a tap is never lost to a re-render. */
function setHTML(el, html) { if (el.__html !== html) { el.innerHTML = html; el.__html = html; } }
function hpCard(e, extra = "", lock = "") {
  const pct = Math.max(0, Math.round((100 * e.hp) / e.maxHp));
  const you = app.me && e.id === app.me.pid ? '<span class="tag gold">you</span>' : "";
  const sub = e.kind === "player" ? CLASSES[e.cls].label : "Enemy";
  return `<div class="card ${e.kind === "monster" ? "monster" : ""} ${e.hp <= 0 ? "dead" : ""} ${extra}" data-id="${esc(e.id)}">
    <div class="card-top"><b>${esc(e.name)}</b>${you}${lock}</div>
    <div class="mute">${sub} · AC ${e.ac} · init ${e.initiative}</div>
    <div class="bar"><i style="width:${pct}%"></i></div><div class="mute">${COND(e)}</div></div>`;
}

function render() {
  const s = app.state;
  if (!s || !app.me || s.closed) return;
  const lobby = s.phase === "LOBBY";
  $("lobby").classList.toggle("hidden", !lobby);
  $("combat").classList.toggle("hidden", lobby);
  $("sceneLine").textContent = lobby ? `Next battle: depth ${s.depth}` : `Depth ${s.depth} · ${s.scene}`;
  $("narratorTag").textContent = { free: "Free AI narrator", claude: "Claude narrator", off: "Built-in narrator" }[s.narrator] || "";
  const isHost = s.hostPid === app.me.pid;
  if (lobby) {
    setHTML($("lobbyMembers"), s.members.map((m) => `<div class="card"><div class="card-top"><b>${esc(m.name)}</b>${m.id === s.hostPid ? '<span class="tag gold">host</span>' : ""}${m.id === app.me.pid ? '<span class="tag">you</span>' : ""}</div><div class="mute">${CLASSES[m.cls].label} · ${m.connected ? "here" : "away"}</div></div>`).join(""));
    $("btnStart").classList.toggle("hidden", !isHost);
    flash("lobbyNote", isHost ? (s.members.length < 2 ? "You can start alone, or wait for friends to join with your code." : "Start when everyone is in.") : "Waiting for the host to start the battle…");
    return;
  }
  const ents = s.entities, mine = ents.find((e) => e.id === app.me.pid);
  const enemies = ents.filter((e) => e.kind === "monster"), party = ents.filter((e) => e.kind === "player");
  const healing = app.mode === "heal";
  const valid = healing ? party.filter((e) => e.hp > 0) : enemies.filter((e) => e.hp > 0);
  if (!valid.find((e) => e.id === app.target)) app.target = healing ? app.me.pid : (valid[0] || {}).id;
  const lockTag = (e) => {
    if (s.phase !== "COMMIT" || e.hp <= 0) return "";
    const m = s.members.find((x) => x.id === e.id);
    return m && m.locked ? '<span class="tag ok">ready</span>' : m && m.connected ? '<span class="tag">choosing…</span>' : '<span class="tag">away</span>';
  };
  setHTML($("enemies"), enemies.map((e) => hpCard(e, (!healing && e.hp > 0 ? "pick " : "") + (!healing && e.id === app.target ? "sel" : ""))).join(""));
  setHTML($("party"), party.map((e) => hpCard(e, (healing && e.hp > 0 ? "pick " : "") + (healing && e.id === app.target ? "sel" : ""), lockTag(e))).join(""));
  $("roundTitle").textContent = s.phase === "ENDED" ? (s.outcome === "victory" ? "Victory!" : "Defeat") : `Round ${s.round}`;
  const locked = s.members.find((m) => m.id === app.me.pid)?.locked;
  const canAct = s.phase === "COMMIT" && mine && mine.hp > 0 && !locked;
  const k = mine ? CLASSES[mine.cls] : null;
  const btn = (t, label, primary) => `<button data-t="${t}" class="${primary ? "primary" : ""}" ${canAct ? "" : "disabled"}>${label}</button>`;
  let html = "";
  if (healing) html = btn("heal", "Heal selected ally", true) + btn("cancel", "Back");
  else {
    html = btn("attack", "Attack", true);
    if (k && k.spell) html += btn("spell", k.spell.name, true);
    if (k && k.heal) html += btn("healmode", "Heal…");
    html += btn("defend", "Defend");
  }
  setHTML($("actions"), html);
  $("flavor").disabled = !canAct;
  $("actionNote").textContent = s.phase === "ENDED" ? "Back to the room lobby in a few seconds…"
    : !mine || mine.hp <= 0 ? "You are down. Your allies fight on."
    : locked ? "Locked in. Waiting for the others…"
    : healing ? "Tap an ally card, then heal." : "Tap an enemy card to target it, then choose an action. Defend gives +4 AC this round.";
  $("endPanel").classList.toggle("hidden", s.phase !== "ENDED");
  $("endPanel").textContent = s.outcome === "victory" ? "The enemies are beaten. The next battle goes one level deeper."
    : s.outcome === "defeat" ? "The party has fallen. The next battle starts again at depth 1." : "";
}

document.addEventListener("click", async (e) => {
  if (!app.me || !app.state || $("room").classList.contains("hidden")) return;
  const card = e.target.closest(".card.pick");
  if (card) { app.target = card.dataset.id; return render(); }
  const b = e.target.closest("#actions button");
  if (!b || b.disabled) return;
  const t = b.dataset.t;
  if (t === "healmode") { app.mode = "heal"; app.target = app.me.pid; return render(); }
  if (t === "cancel") { app.mode = "attack"; app.target = null; return render(); }
  const s = app.state;
  if (app.sending) return;
  app.sending = true;
  document.querySelectorAll("#actions button").forEach((x) => (x.disabled = true));
  const r = await sendInput(app.me.code, {
    t: "action", round: s.round, type: t, targetId: t === "defend" ? undefined : app.target,
    flavorText: $("flavor").value.trim() || undefined,
  });
  app.sending = false;
  $("actions").__html = null; // buttons were disabled by hand; force a fresh render
  if (!r.ok) { render(); $("actionNote").textContent = r.error; }
  else { $("flavor").value = ""; app.mode = "attack"; render(); }
});

function addResolution(res) {
  if (app.logRounds.has(res.round)) return;
  app.logRounds.add(res.round);
  const box = document.createElement("div");
  box.className = "round-log";
  box.dataset.round = res.round;
  box.innerHTML = `<div class="ev head">Round ${res.round}${res.outcome === "victory" ? " · Victory!" : res.outcome === "defeat" ? " · Defeat" : ""}</div>` +
    res.events.map((e) => `<div class="ev">${esc(e.text)}</div>`).join("");
  insertByRound($("log"), box, res.round);
}
function addNarration(n) {
  if (app.narRounds.has(n.round)) return;
  app.narRounds.add(n.round);
  const d = document.createElement("div");
  d.className = "nar";
  d.dataset.round = n.round;
  const src = { claude: "Claude", "free-ai": "AI", "built-in": "built-in" }[n.source] || n.source;
  d.innerHTML = `<div class="mute">${n.round === 0 ? "The scene" : "Round " + n.round} <span class="src">${esc(src)}</span></div>${esc(n.text)}`;
  insertByRound($("story"), d, n.round);
}
function insertByRound(container, el, round) {
  const after = [...container.children].find((c) => Number(c.dataset.round) < round);
  container.insertBefore(el, after || null);
}

setInterval(() => {
  const s = app.state;
  if (!s || s.phase !== "COMMIT" || !app.me) { $("timer").textContent = ""; return; }
  const left = Math.max(0, Math.ceil((s.msLeft - (Date.now() - app.receivedAt)) / 1000));
  $("timer").textContent = `${left}s left`;
  $("timer").classList.toggle("low", left <= 10);
}, 250);

// ---------------- AI narrator settings (used when you host) ----------------
function paintSettings() {
  const m = ls.get("dl:narrator") || "free";
  document.querySelectorAll('input[name="narr"]').forEach((r) => (r.checked = r.value === m));
  $("keyRow").classList.toggle("hidden", m !== "claude");
  $("apiKey").value = ls.get("dl:anthropicKey") || "";
  $("narrNow").textContent = { free: "Free AI (no key needed)", claude: "Claude with your key", off: "Built-in narrator" }[narratorMode()];
}
document.querySelectorAll('input[name="narr"]').forEach((r) => (r.onchange = () => { ls.set("dl:narrator", r.value); paintSettings(); }));
$("apiKey").onchange = () => { const v = $("apiKey").value.trim(); v ? ls.set("dl:anthropicKey", v) : ls.del("dl:anthropicKey"); paintSettings(); };
paintSettings();
window.__dl = { app, narratorStats }; // for debugging from the console

// ---------------- auto-resume after a reload ----------------
if (ss.get("dl:entered") && ls.get("dl:name")) {
  app.profile = { name: ls.get("dl:name"), cls: ls.get("dl:cls") || "fighter" };
  goOnline();
} else {
  show("entry");
}
