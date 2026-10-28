// Authoritative room / session state machine.
//   LOBBY -> COMMIT -> RESOLVING -> COMMIT ... -> ENDED -> LOBBY
import { randomUUID } from "node:crypto";
import type { ClassId, PlayerAction, TurnResolution } from "./schemas.js";
import { createCombat, resolveRound, validateAction, type Combat, type SubmittedAction } from "./rules.js";
import { narrateRound, summarizeHistory } from "./narrator.js";

export type Phase = "LOBBY" | "COMMIT" | "RESOLVING" | "ENDED";
export type Visibility = "public" | "private";
export const ENTRY_CODE = "5467"; // site entry code only; never a room code
const MAX_PLAYERS = 6;
const SCENES = [
  "a torchlit crypt beneath a ruined chapel",
  "a damp goblin warren lit by guttering lanterns",
  "a collapsed mine shaft echoing with dripping water",
];

export interface Member {
  id: string;
  name: string;
  cls: ClassId;
  connected: boolean;
  socketId?: string;
  locked: boolean;
}

export interface Room {
  code: string;
  visibility: Visibility;
  phase: Phase;
  hostId?: string;
  members: Map<string, Member>;
  combat?: Combat;
  actions: Map<string, SubmittedAction>;
  deadline: number;
  timer?: NodeJS.Timeout;
  scene: string;
  summary: string;
  recent: string[];
  outcome?: "victory" | "defeat";
  lastActive: number;
}

export interface Hooks {
  rooms(): void; // the public room list changed
  state(room: Room): void;
  resolution(room: Room, res: TurnResolution): void;
  narration(room: Room, round: number, text: string, source: string): void;
  toast(room: Room, msg: string): void;
}

export class RoomManager {
  rooms = new Map<string, Room>();

  constructor(private hooks: Hooks, private commitMs: number) {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  /** Each new room gets its own random, unused 4-digit code (never the entry code). */
  createRoom(visibility: Visibility): Room {
    let code: string;
    do code = String(1000 + Math.floor(Math.random() * 9000));
    while (this.rooms.has(code) || code === ENTRY_CODE);
    const room: Room = {
      code, visibility, phase: "LOBBY", members: new Map(), actions: new Map(), deadline: 0,
      scene: SCENES[0], summary: "", recent: [], lastActive: Date.now(),
    };
    this.rooms.set(code, room);
    this.hooks.rooms();
    return room;
  }

  get(code: string) {
    return this.rooms.get(code);
  }

  /** Server browser: public rooms only. Private rooms are never listed. */
  listPublic() {
    return [...this.rooms.values()]
      .filter((r) => r.visibility === "public" && [...r.members.values()].some((m) => m.connected))
      .map((r) => ({
        code: r.code,
        host: (r.hostId && r.members.get(r.hostId)?.name) || "—",
        players: [...r.members.values()].filter((m) => m.connected).length,
        max: MAX_PLAYERS,
        phase: r.phase,
        joinable: r.phase === "LOBBY" && r.members.size < MAX_PLAYERS,
      }))
      .sort((a, b) => Number(b.joinable) - Number(a.joinable) || a.code.localeCompare(b.code));
  }

  /** Player leaves on purpose. Lobby: seat is freed. Mid-battle: treated as a disconnect so combat stays consistent. */
  leave(code: string, playerId: string) {
    const room = this.rooms.get(code);
    const m = room?.members.get(playerId);
    if (!room || !m) return;
    if (room.phase === "LOBBY") {
      room.members.delete(playerId);
      if (room.hostId === playerId) this.reassignHost(room);
      if (room.members.size === 0) return this.destroy(room);
      this.hooks.state(room);
    } else {
      m.connected = false;
      m.socketId = undefined;
      if (room.hostId === playerId) this.reassignHost(room);
      this.hooks.state(room);
      if (room.phase === "COMMIT") this.maybeResolve(room);
    }
    this.hooks.rooms();
  }

  private destroy(room: Room) {
    clearTimeout(room.timer);
    this.rooms.delete(room.code);
    this.hooks.rooms();
  }

  // ----- membership -----
  join(code: string, name: string, cls: ClassId, playerId?: string): { room?: Room; member?: Member; error?: string } {
    const room = this.rooms.get(code);
    if (!room) return { error: `No room with code ${code}.` };
    room.lastActive = Date.now();
    const existing = playerId ? room.members.get(playerId) : undefined;
    if (existing) return { room, member: existing };
    if (room.phase !== "LOBBY") return { error: "A battle is in progress. Try again when it ends (a few seconds after the last round)." };
    if (room.members.size >= MAX_PLAYERS) return { error: "Room is full (6 players)." };
    if ([...room.members.values()].some((m) => m.name.toLowerCase() === name.toLowerCase()))
      return { error: "That name is taken in this room." };
    const member: Member = { id: randomUUID(), name, cls, connected: false, locked: false };
    room.members.set(member.id, member);
    if (!room.hostId) room.hostId = member.id;
    return { room, member };
  }

  attach(room: Room, member: Member, socketId: string) {
    member.connected = true;
    member.socketId = socketId;
    room.lastActive = Date.now();
    this.hooks.state(room);
  }

  detach(code: string, playerId: string, socketId: string) {
    const room = this.rooms.get(code);
    const m = room?.members.get(playerId);
    if (!room || !m || m.socketId !== socketId) return; // a newer socket already took over
    m.connected = false;
    if (room.hostId === m.id) this.reassignHost(room);
    if (room.phase === "LOBBY") {
      setTimeout(() => {
        if (!m.connected && room.phase === "LOBBY" && room.members.get(m.id) === m) {
          room.members.delete(m.id);
          if (room.hostId === m.id) this.reassignHost(room);
          this.hooks.state(room);
        }
      }, 60_000).unref();
    }
    this.hooks.state(room);
    if (room.phase === "COMMIT") this.maybeResolve(room); // never wait on someone who left
  }

  private reassignHost(room: Room) {
    room.hostId = [...room.members.values()].find((m) => m.connected)?.id;
  }

  // ----- lifecycle -----
  startBattle(room: Room, playerId: string): string | null {
    if (room.phase !== "LOBBY") return "Battle already started.";
    if (room.hostId !== playerId) return "Only the host can start.";
    for (const m of [...room.members.values()]) if (!m.connected) room.members.delete(m.id);
    const party = [...room.members.values()];
    if (party.length === 0) return "No players.";
    room.combat = createCombat(party, (Math.random() * 2 ** 31) | 0);
    room.scene = SCENES[Math.floor(Math.random() * SCENES.length)];
    room.summary = "";
    room.recent = [];
    room.outcome = undefined;
    this.startRound(room);
    return null;
  }

  private startRound(room: Room) {
    room.phase = "COMMIT";
    room.actions.clear();
    for (const m of room.members.values()) m.locked = false;
    room.deadline = Date.now() + this.commitMs;
    clearTimeout(room.timer);
    room.timer = setTimeout(() => this.resolve(room), this.commitMs);
    this.hooks.state(room);
    this.maybeResolve(room);
  }

  /** Commit: one locked action per player per round, final once accepted. */
  submit(room: Room, playerId: string, a: PlayerAction): string | null {
    if (room.phase !== "COMMIT" || !room.combat) return "Not accepting actions right now.";
    if (a.round !== room.combat.round) return "That round already resolved.";
    const m = room.members.get(playerId);
    if (!m) return "You are not in this room.";
    if (room.actions.has(playerId)) return "Action already locked in.";
    const sub: SubmittedAction = {
      type: a.type,
      targetId: a.targetId,
      flavorText: a.flavorText?.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200) || undefined,
    };
    const err = validateAction(room.combat, playerId, sub);
    if (err) return err;
    room.actions.set(playerId, sub);
    m.locked = true;
    this.hooks.state(room);
    this.maybeResolve(room);
    return null;
  }

  private maybeResolve(room: Room) {
    if (room.phase !== "COMMIT" || !room.combat) return;
    const present = room.combat.entities.filter(
      (e) => e.kind === "player" && e.hp > 0 && room.members.get(e.id)?.connected,
    );
    // If nobody is connected, don't fast-forward the fight; the round timer paces it and the sweep reaps the room.
    if (present.length === 0) return;
    if (present.every((e) => room.actions.has(e.id))) this.resolve(room);
  }

  /** Resolve: synchronous, single-threaded, guarded by phase so double triggers (timer + last lock) are harmless. */
  private resolve(room: Room) {
    if (room.phase !== "COMMIT" || !room.combat) return;
    room.phase = "RESOLVING";
    clearTimeout(room.timer);
    const c = room.combat;
    const timedOut = new Set(
      c.entities.filter((e) => e.kind === "player" && e.hp > 0 && !room.actions.has(e.id)).map((e) => e.id),
    );
    const res = resolveRound(c, room.actions, timedOut);
    for (const e of c.entities) if (e.kind === "player") e.connected = room.members.get(e.id)?.connected ?? false;
    this.hooks.resolution(room, res);

    // Narration is async and never blocks the next round.
    const flavor = [...room.actions.entries()]
      .filter(([, a]) => a.flavorText)
      .map(([id, a]) => ({ actor: room.members.get(id)?.name ?? "?", text: a.flavorText! }));
    narrateRound({
      scene: room.scene,
      storySoFar: room.summary,
      recentRounds: room.recent.slice(-2),
      party: c.entities.filter((e) => e.kind === "player").map((e) => ({ name: e.name, cls: e.cls, hp: e.hp, maxHp: e.maxHp })),
      enemies: c.entities.filter((e) => e.kind === "monster").map((e) => ({ name: e.name, hp: e.hp, maxHp: e.maxHp })),
      resolution: res,
      playerFlavor: flavor,
    })
      .then((n) => this.hooks.narration(room, res.round, n.text, n.source))
      .catch(() => {});

    room.recent.push(`Round ${res.round}: ${res.events.map((e) => e.text).join(" ")}`);
    if (room.recent.length > 4) {
      const old = room.recent.splice(0, room.recent.length - 2);
      summarizeHistory(room.summary, old).then((s) => (room.summary = s)).catch(() => {});
    }

    if (res.outcome === "ongoing") {
      this.startRound(room);
    } else {
      room.phase = "ENDED";
      room.outcome = res.outcome;
      this.hooks.state(room);
      setTimeout(() => this.resetToLobby(room), 20_000).unref();
    }
  }

  private resetToLobby(room: Room) {
    if (room.phase !== "ENDED") return;
    clearTimeout(room.timer);
    for (const m of [...room.members.values()]) if (!m.connected) room.members.delete(m.id);
    for (const m of room.members.values()) m.locked = false;
    room.phase = "LOBBY";
    room.combat = undefined;
    room.actions.clear();
    room.summary = "";
    room.recent = [];
    room.outcome = undefined;
    if (!room.hostId || !room.members.has(room.hostId)) this.reassignHost(room);
    this.hooks.state(room);
  }

  private sweep() {
    const now = Date.now();
    for (const r of [...this.rooms.values()]) {
      const anyone = [...r.members.values()].some((m) => m.connected);
      if (!anyone && now - r.lastActive > 5 * 60_000) this.destroy(r); // empty rooms expire after 5 min
    }
  }

  // ----- what clients are allowed to see -----
  publicState(room: Room) {
    const c = room.combat;
    return {
      code: room.code,
      visibility: room.visibility,
      phase: room.phase,
      hostId: room.hostId ?? null,
      round: c?.round ?? 0,
      msLeft: room.phase === "COMMIT" ? Math.max(0, room.deadline - Date.now()) : 0,
      scene: room.scene,
      outcome: room.outcome ?? null,
      members: [...room.members.values()].map((m) => ({
        id: m.id, name: m.name, cls: m.cls, connected: m.connected, locked: m.locked,
      })),
      entities: (c?.entities ?? [])
        .slice()
        .sort((a, b) => b.initiative - a.initiative || a.id.localeCompare(b.id))
        .map((e) => ({
          id: e.id, name: e.name, kind: e.kind, cls: e.cls ?? null, hp: e.hp, maxHp: e.maxHp,
          ac: e.ac, initiative: e.initiative, connected: e.connected,
        })),
    };
  }
}
