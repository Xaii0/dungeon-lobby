import { z } from "zod";

// ---------- Shared enums ----------
export const ClassId = z.enum(["fighter", "rogue", "wizard", "cleric"]);
export type ClassId = z.infer<typeof ClassId>;

export const ActionType = z.enum(["attack", "spell", "heal", "defend"]);
export type ActionType = z.infer<typeof ActionType>;

const RoomCode = z.string().regex(/^\d{4}$/, "Room code is 4 digits");

// ---------- Client -> Server ----------
// 1) Pass the front door with the site entry code and set up your hero.
export const EnterPayload = z.object({
  entryCode: RoomCode,
  name: z.string().trim().min(1).max(20),
  cls: ClassId,
});
export type EnterPayload = z.infer<typeof EnterPayload>;

// 2) Create your own room (public = listed in the server browser, private = code only).
export const CreatePayload = z.object({
  visibility: z.enum(["public", "private"]),
});

// 3) Join a room by its code (from the browser or from a friend).
export const JoinPayload = z.object({
  code: RoomCode,
  playerId: z.string().max(64).optional(), // present when reconnecting to a seat
});
export type JoinPayload = z.infer<typeof JoinPayload>;

export const PlayerAction = z.object({
  roomCode: RoomCode,
  round: z.number().int().min(1),
  type: ActionType,
  targetId: z.string().max(64).optional(),
  abilityId: z.string().max(32).optional(),
  // Player-authored flavor. UNTRUSTED: only ever passed to the narrator as labeled data.
  flavorText: z.string().max(200).optional(),
});
export type PlayerAction = z.infer<typeof PlayerAction>;

// ---------- Rules engine -> Client + LLM ----------
export const TurnEvent = z.object({
  seq: z.number().int(),
  actorId: z.string(),
  actorName: z.string(),
  kind: z.enum(["attack", "spell", "heal", "defend", "timeout"]),
  targetId: z.string().optional(),
  targetName: z.string().optional(),
  d20: z.number().int().optional(),
  modifier: z.number().int().optional(),
  total: z.number().int().optional(),
  targetAc: z.number().int().optional(),
  hit: z.boolean().optional(),
  crit: z.boolean().optional(),
  fumble: z.boolean().optional(),
  damage: z.number().int().optional(),
  healing: z.number().int().optional(),
  targetHpAfter: z.number().int().optional(),
  defeated: z.boolean().optional(),
  retargeted: z.boolean().optional(),
  text: z.string(), // deterministic one-line combat log entry
});
export type TurnEvent = z.infer<typeof TurnEvent>;

export const TurnResolution = z.object({
  round: z.number().int(),
  events: z.array(TurnEvent),
  outcome: z.enum(["ongoing", "victory", "defeat"]),
});
export type TurnResolution = z.infer<typeof TurnResolution>;

// ---------- LLM -> Server ----------
export const NarrationOut = z.object({
  narration: z.string().min(10).max(700),
});
