// Authoritative room, running in the browser of the player who created it.
// Every other browser only sends intents; this file owns the state machine and all dice.
//   LOBBY -> COMMIT -> (resolve) -> COMMIT ... -> ENDED -> LOBBY
import {
  CLASSES, SCENES, MAX_PLAYERS, createCombat, validateAction, resolveRound,
  introNarration, narratorEvents,
} from "./engine.js";
import { T, randomId } from "./net.js";

export const ENTRY_CODE = "5467";
const LOBBY_DROP_MS = 60000;   // a lobby member silent this long loses their seat
const PRESENCE_MS = 25000;     // no ping for this long = disconnected
const END_TO_LOBBY_MS = 12000;

const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 20);
const condition = (hp, max) => (hp <= 0 ? "down" : hp >= max ? "unhurt" : hp / max > 0.5 ? "wounded" : "badly wounded");

/** Find an unused 4-digit room code on this network (never the entry code). */
export async function pickFreeCode(bus, waitMs = 1200) {
  for (let i = 0; i < 10; i++) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    if (code === ENTRY_CODE) continue;
    const topic = T.state(code);
    let taken = false;
    const h = (t, o) => { if (t === topic && o && !o.closed) taken = true; };
    bus.on("message", h);
    bus.subscribe(topic);
    await new Promise((r) => setTimeout(r, waitMs));
    bus.unsubscribe(topic);
    bus.off("message", h);
    if (!taken) return code;
  }
  throw new Error("Could not find a free room code. Please try again.");
}

export class RoomHost {
  constructor(bus, { code, visibility, creatorCid, narrate, narratorMode = () => "off", commitMs = 45000, endMs = END_TO_LOBBY_MS }) {
    Object.assign(this, { bus, code, visibility, creatorCid, narrate, narratorMode, commitMs, endMs });
    this.rid = randomId(8); // identifies this room instance (codes can be reused later)
    this.phase = "LOBBY";
    this.members = new Map();
    this.hostPid = null;
    this.combat = null;
    this.actions = new Map();
    this.depth = 1;
    this.scene = SCENES[0];
    this.story = [];
    this.recent = [];
    this.outcome = null;
    this.deadline = 0;
    this.v = 0;
    this.closed = false;
    this.timers = new Set();
  }

  // ---------- lifecycle ----------
  start() {
    this.onMsg = (t, o) => { if (t === T.input(this.code) && o && typeof o === "object") this.handle(o); };
    this.onStatus = (s) => { if (s === "online" && !this.closed) { this.publishState(); this.publishListing(); } };
    this.bus.on("message", this.onMsg);
    this.bus.on("status", this.onStatus);
    this.bus.subscribe(T.input(this.code));
    this.publishState();
    this.publishListing();
    this.iv = [
      setInterval(() => this.publishListing(), 15000),
      setInterval(() => this.checkPresence(), 3000),
    ];
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    for (const i of this.iv || []) clearInterval(i);
    this.bus.publish(T.state(this.code), { closed: true, final: true, code: this.code, rid: this.rid, v: ++this.v }, true);
    this.bus.publish(T.list(this.code), null, true);
    this.bus.unsubscribe(T.input(this.code));
  }

  later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.closed) fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  // ---------- inputs ----------
  reply(cid, obj) { if (typeof cid === "string" && cid.length <= 40) this.bus.publish(T.client(cid), obj); }

  auth(o) {
    const m = typeof o.pid === "string" ? this.members.get(o.pid) : null;
    if (!m || m.token !== o.token) return null;
    m.lastSeen = Date.now();
    if (!m.connected) { m.connected = true; this.syncConnected(); this.publishState(); }
    return m;
  }

  handle(o) {
    if (this.closed) return;
    switch (o.t) {
      case "join": return this.onJoin(o);
      case "ping": return void this.auth(o);
      case "leave": { const m = this.auth(o); if (m) this.onLeave(m); return; }
      case "start": {
        const m = this.auth(o);
        const err = !m ? "Not in this room." : this.startBattle(m);
        return this.reply(o.cid, { t: "ack", nonce: o.nonce, ok: !err, error: err || undefined });
      }
      case "action": {
        const m = this.auth(o);
        const err = !m ? "Not in this room." : this.submit(m, o);
        return this.reply(o.cid, { t: "ack", nonce: o.nonce, ok: !err, error: err || undefined });
      }
    }
  }

  onJoin(o) {
    const answer = (x) => this.reply(o.cid, { t: "joined", nonce: o.nonce, ...x });
    const back = typeof o.pid === "string" ? this.members.get(o.pid) : null;
    if (back && back.token === o.token) {
      back.cid = o.cid; back.connected = true; back.lastSeen = Date.now();
      this.syncConnected();
      this.publishState();
      return answer({ ok: true, pid: back.pid, token: back.token, code: this.code, visibility: this.visibility });
    }
    const name = cleanName(o.name);
    if (!name) return answer({ ok: false, error: "Enter a name." });
    if (!CLASSES[o.cls]) return answer({ ok: false, error: "Pick a class." });
    if (this.phase !== "LOBBY") return answer({ ok: false, error: "A battle is in progress. Try again when it ends." });
    if (this.members.size >= MAX_PLAYERS) return answer({ ok: false, error: `Room is full (${MAX_PLAYERS} players).` });
    if ([...this.members.values()].some((m) => m.name.toLowerCase() === name.toLowerCase()))
      return answer({ ok: false, error: "That name is taken in this room." });
    const m = { pid: "p" + randomId(8), token: randomId(20), cid: o.cid, name, cls: o.cls, connected: true, lastSeen: Date.now(), locked: false };
    this.members.set(m.pid, m);
    if (o.cid === this.creatorCid || !this.hostPid) this.hostPid = m.pid;
    this.publishState();
    this.publishListing();
    answer({ ok: true, pid: m.pid, token: m.token, code: this.code, visibility: this.visibility });
  }

  onLeave(m) {
    if (this.phase === "LOBBY") {
      this.members.delete(m.pid);
    } else {
      m.connected = false;
      m.lastSeen = 0;
      this.syncConnected();
    }
    this.publishState();
    this.publishListing();
    if (this.phase === "COMMIT") this.maybeResolve();
  }

  checkPresence() {
    const now = Date.now();
    let changed = false;
    for (const m of [...this.members.values()]) {
      if (m.connected && now - m.lastSeen > PRESENCE_MS) { m.connected = false; changed = true; }
      if (!m.connected && this.phase === "LOBBY" && now - m.lastSeen > LOBBY_DROP_MS && m.pid !== this.hostPid) {
        this.members.delete(m.pid); changed = true;
      }
    }
    if (changed) {
      this.syncConnected();
      this.publishState();
      this.publishListing();
      if (this.phase === "COMMIT") this.maybeResolve();
    }
  }

  syncConnected() {
    if (!this.combat) return;
    for (const e of this.combat.entities) if (e.kind === "player") e.connected = !!this.members.get(e.id)?.connected;
  }

  // ---------- battle ----------
  startBattle(m) {
    if (this.phase !== "LOBBY") return "The battle has already started.";
    if (m.pid !== this.hostPid) return "Only the room's creator can start.";
    for (const x of [...this.members.values()]) if (!x.connected) this.members.delete(x.pid);
    const party = [...this.members.values()].map((x) => ({ id: x.pid, name: x.name, cls: x.cls }));
    if (!party.length) return "No players.";
    this.combat = createCombat(party, (Math.random() * 2 ** 31) | 0, this.depth);
    this.scene = SCENES[Math.floor(Math.random() * SCENES.length)];
    this.story = [];
    this.recent = [];
    this.outcome = null;
    const enemies = this.combat.entities.filter((e) => e.kind === "monster");
    const intro = introNarration(this.scene.text, enemies, this.depth, this.depth + enemies.length);
    this.narrateAsync(0, {
      task: "Introduce the scene: describe the party entering it and the listed enemies emerging. No attacks happen yet.",
      ...this.narrCtx({ round: 0, outcome: "ongoing", events: [] }),
      intro,
    });
    this.startRound();
    this.publishListing();
    return null;
  }

  startRound() {
    this.phase = "COMMIT";
    this.actions.clear();
    for (const m of this.members.values()) m.locked = false;
    this.deadline = Date.now() + this.commitMs;
    clearTimeout(this.roundTimer);
    this.roundTimer = this.later(() => this.resolve(), this.commitMs);
    this.publishState();
    this.maybeResolve();
  }

  submit(m, o) {
    if (this.phase !== "COMMIT" || !this.combat) return "Not accepting actions right now.";
    if (o.round !== this.combat.round) return "That round already resolved.";
    if (this.actions.has(m.pid)) return "Action already locked in.";
    const a = {
      type: o.type,
      targetId: typeof o.targetId === "string" ? o.targetId.slice(0, 24) : undefined,
      flavorText: typeof o.flavorText === "string" ? o.flavorText.replace(/[\u0000-\u001f<>{}]/g, " ").trim().slice(0, 140) || undefined : undefined,
    };
    const err = validateAction(this.combat, m.pid, a);
    if (err) return err;
    this.actions.set(m.pid, a);
    m.locked = true;
    this.publishState();
    this.maybeResolve();
    return null;
  }

  maybeResolve() {
    if (this.phase !== "COMMIT" || !this.combat) return;
    const present = this.combat.entities.filter((e) => e.kind === "player" && e.hp > 0 && this.members.get(e.id)?.connected);
    if (present.length === 0) return; // nobody here: the round timer paces the fight
    if (present.every((e) => this.actions.has(e.id))) this.resolve();
  }

  resolve() {
    if (this.phase !== "COMMIT" || !this.combat) return;
    this.phase = "RESOLVING";
    clearTimeout(this.roundTimer);
    const c = this.combat;
    const timedOut = new Set(c.entities.filter((e) => e.kind === "player" && e.hp > 0 && !this.actions.has(e.id)).map((e) => e.id));
    const flavor = [...this.actions.entries()].filter(([, a]) => a.flavorText).map(([id, a]) => ({ actor: this.members.get(id)?.name || "?", text: a.flavorText }));
    const res = resolveRound(c, this.actions, timedOut);
    this.syncConnected();
    this.bus.publish(T.events(this.code), { t: "res", res });

    this.narrateAsync(res.round, { ...this.narrCtx(res), playerFlavor: flavor });
    for (const e of res.events) if (e.defeated) this.story.push(`${e.targetName} fell to ${e.actorName}.`);
    this.story = this.story.slice(-8);

    if (res.outcome === "ongoing") return this.startRound();
    this.phase = "ENDED";
    this.outcome = res.outcome;
    this.depth = res.outcome === "victory" ? this.depth + 1 : 1;
    this.publishState();
    this.publishListing();
    this.later(() => this.toLobby(), this.endMs);
  }

  toLobby() {
    if (this.phase !== "ENDED") return;
    for (const m of [...this.members.values()]) { m.locked = false; if (!m.connected) this.members.delete(m.pid); }
    this.phase = "LOBBY";
    this.combat = null;
    this.actions.clear();
    this.outcome = null;
    this.publishState();
    this.publishListing();
  }

  // ---------- narration ----------
  narrCtx(res) {
    const ents = this.combat.entities;
    return {
      scene: this.scene.text,
      sceneNotes: this.scene.lore,
      storySoFar: this.story.join(" "),
      recentRounds: this.recent.slice(-2),
      party: ents.filter((e) => e.kind === "player").map((e) => ({ name: e.name, cls: e.cls, condition: condition(e.hp, e.maxHp) })),
      enemies: ents.filter((e) => e.kind === "monster").map((e) => ({ name: e.name, condition: condition(e.hp, e.maxHp) })),
      resolution: { round: res.round, outcome: res.outcome, events: narratorEvents(res.events) },
      playerFlavor: [],
    };
  }

  narrateAsync(round, ctx) {
    Promise.resolve(this.narrate(ctx)).then((n) => {
      if (this.closed || !n) return;
      if (round > 0) { this.recent.push(n.text); this.recent = this.recent.slice(-2); }
      this.bus.publish(T.events(this.code), { t: "nar", round, text: n.text, source: n.source });
    }).catch(() => {});
  }

  // ---------- publishing ----------
  publishState() {
    if (this.closed) return;
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      if (this.closed) return;
      this.bus.publish(T.state(this.code), this.publicState(), true);
    }, 30);
  }

  publishListing() {
    if (this.closed) return;
    if (this.visibility !== "public") return;
    const host = this.members.get(this.hostPid);
    const players = [...this.members.values()].filter((m) => m.connected).length;
    this.bus.publish(T.list(this.code), {
      code: this.code, host: host ? host.name : "…", players, max: MAX_PLAYERS, phase: this.phase,
      depth: this.depth, joinable: this.phase === "LOBBY" && this.members.size < MAX_PLAYERS, ts: Date.now(),
    }, true);
  }

  publicState() {
    const c = this.combat;
    return {
      code: this.code, rid: this.rid, visibility: this.visibility, v: ++this.v, phase: this.phase, hostPid: this.hostPid,
      round: c ? c.round : 0, msLeft: this.phase === "COMMIT" ? Math.max(0, this.deadline - Date.now()) : 0,
      scene: this.scene.text, depth: this.depth, outcome: this.outcome, narrator: this.narratorMode(),
      members: [...this.members.values()].map((m) => ({ id: m.pid, name: m.name, cls: m.cls, connected: m.connected, locked: m.locked })),
      entities: (c ? c.entities : []).slice()
        .sort((a, b) => b.initiative - a.initiative || a.id.localeCompare(b.id))
        .map((e) => ({ id: e.id, name: e.name, kind: e.kind, cls: e.cls || null, type: e.type || null, hp: e.hp, maxHp: e.maxHp, ac: e.ac, initiative: e.initiative, connected: e.connected })),
    };
  }
}
