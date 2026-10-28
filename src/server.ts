import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server, type Socket } from "socket.io";
import { CreatePayload, EnterPayload, JoinPayload, PlayerAction } from "./schemas.js";
import { ENTRY_CODE, RoomManager, type Room } from "./rooms.js";
import { stats as narratorStats } from "./narrator.js";

const PORT = Number(process.env.PORT || 3000);
const COMMIT_MS = Number(process.env.COMMIT_SECONDS || 45) * 1000;
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true }, pingInterval: 10_000, pingTimeout: 10_000 });

// Everyone who got past the entry code sits in the "hub" socket room and sees the server browser.
let pushTimer: NodeJS.Timeout | undefined;
const pushRooms = () => {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    io.to("hub").emit("rooms", mgr.listPublic());
  }, 250);
};

const mgr: RoomManager = new RoomManager(
  {
    rooms: pushRooms,
    state: (r: Room) => { io.to(r.code).emit("state", mgr.publicState(r)); pushRooms(); },
    resolution: (r, res) => io.to(r.code).emit("resolution", res),
    narration: (r, round, text, source) => io.to(r.code).emit("narration", { round, text, source }),
    toast: (r, msg) => io.to(r.code).emit("toast", msg),
  },
  COMMIT_MS,
);

app.get("/healthz", (_q, r) => r.json({ ok: true, rooms: mgr.rooms.size, narrator: narratorStats }));
app.use(express.static(pub));
app.get(/^\/\d{4}$/, (_q, r) => r.sendFile(path.join(pub, "index.html"))); // /1234 invite deep link

type Ack = (r: unknown) => void;
const reply = (ack: unknown, body: unknown) => typeof ack === "function" && (ack as Ack)(body);

io.on("connection", (socket: Socket) => {
  // crude per-socket rate limit
  let hits = 0;
  const bucket = setInterval(() => (hits = 0), 10_000);
  socket.use((_p, next) => (++hits > 60 ? next(new Error("rate limited")) : next()));

  socket.data = { entered: false, name: "", cls: "fighter", code: null, pid: null };
  let badEntries = 0;

  const seat = (room: Room, playerId: string | undefined, ack: unknown) => {
    const { member, error } = mgr.join(room.code, socket.data.name, socket.data.cls, playerId);
    if (error || !member) return reply(ack, { ok: false, error });
    if (socket.data.code && socket.data.code !== room.code) leaveCurrent();
    socket.leave("hub");
    socket.join(room.code);
    socket.data.code = room.code;
    socket.data.pid = member.id;
    mgr.attach(room, member, socket.id);
    reply(ack, { ok: true, playerId: member.id, code: room.code, visibility: room.visibility });
  };

  const leaveCurrent = () => {
    if (!socket.data.code) return;
    socket.leave(socket.data.code);
    mgr.leave(socket.data.code, socket.data.pid);
    socket.data.code = null;
    socket.data.pid = null;
  };

  // Front door: the site entry code (5467) + your hero.
  socket.on("enter", (raw, ack) => {
    const p = EnterPayload.safeParse(raw);
    if (!p.success) return reply(ack, { ok: false, error: "Enter a name, class and the 4-digit entry code." });
    if (p.data.entryCode !== ENTRY_CODE) {
      if (++badEntries > 5) return reply(ack, { ok: false, error: "Too many wrong codes. Reload to try again." });
      return reply(ack, { ok: false, error: "That entry code is not right." });
    }
    Object.assign(socket.data, { entered: true, name: p.data.name, cls: p.data.cls });
    if (!socket.data.code) socket.join("hub");
    reply(ack, { ok: true, rooms: mgr.listPublic() });
  });

  const guard = (ack: unknown) => {
    if (socket.data.entered) return true;
    reply(ack, { ok: false, error: "Enter the entry code first." });
    return false;
  };

  socket.on("browse", (_raw, ack) => guard(ack) && reply(ack, { ok: true, rooms: mgr.listPublic() }));

  // Create your own room: random code, public (browser-listed) or private (code only).
  socket.on("create", (raw, ack) => {
    if (!guard(ack)) return;
    const p = CreatePayload.safeParse(raw);
    if (!p.success) return reply(ack, { ok: false, error: "Choose public or private." });
    seat(mgr.createRoom(p.data.visibility), undefined, ack);
  });

  // Join any room by code (public or private), or reconnect to your seat.
  let badJoins = 0;
  socket.on("join", (raw, ack) => {
    if (!guard(ack)) return;
    const p = JoinPayload.safeParse(raw);
    if (!p.success) return reply(ack, { ok: false, error: "Room codes are 4 digits." });
    const room = mgr.get(p.data.code);
    if (!room) {
      // slow down people guessing private codes
      if (++badJoins > 10) return reply(ack, { ok: false, error: "Too many unknown codes. Reload to try again." });
      return reply(ack, { ok: false, error: `No room with code ${p.data.code}.` });
    }
    seat(room, p.data.playerId, ack);
  });

  socket.on("leave", (_raw, ack) => {
    if (!guard(ack)) return;
    leaveCurrent();
    socket.join("hub");
    reply(ack, { ok: true, rooms: mgr.listPublic() });
  });

  socket.on("start", (_raw, ack) => {
    const room = socket.data.code && mgr.get(socket.data.code);
    if (!room) return reply(ack, { ok: false, error: "Not in a room." });
    const err = mgr.startBattle(room, socket.data.pid);
    reply(ack, err ? { ok: false, error: err } : { ok: true });
  });

  socket.on("action", (raw, ack) => {
    const p = PlayerAction.safeParse(raw);
    const room = socket.data.code && mgr.get(socket.data.code);
    if (!p.success || !room || p.data.roomCode !== room.code) return reply(ack, { ok: false, error: "Bad action." });
    const err = mgr.submit(room, socket.data.pid, p.data);
    reply(ack, err ? { ok: false, error: err } : { ok: true });
  });

  socket.on("disconnect", () => {
    clearInterval(bucket);
    if (socket.data.code) mgr.detach(socket.data.code, socket.data.pid, socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Dungeon Lobby on :${PORT} — entry code ${ENTRY_CODE}; players create their own rooms`);
  console.log(`Narrator: ${process.env.ANTHROPIC_API_KEY ? "LLM (" + (process.env.NARRATOR_MODEL || "claude-haiku-5-5") + ")" : "template fallback (no ANTHROPIC_API_KEY)"}`);
});
