// Deterministic rules engine. ALL math lives here. The LLM never touches it.
import type { ClassId, TurnEvent, TurnResolution } from "./schemas.js";

export interface Entity {
  id: string;
  name: string;
  kind: "player" | "monster";
  cls?: ClassId;
  hp: number;
  maxHp: number;
  ac: number;
  initBonus: number;
  initiative: number;
  attackBonus: number;
  dmg: Dice;
  defending: boolean;
  connected: boolean;
}
export type Dice = [count: number, sides: number, mod: number];

export interface Combat {
  round: number;
  seed: number; // mutable PRNG state -> replayable fights
  entities: Entity[];
}

export interface SubmittedAction {
  type: "attack" | "spell" | "heal" | "defend";
  targetId?: string;
  flavorText?: string;
}

const DEFEND_BONUS = 4;

const CLASSES: Record<
  ClassId,
  { hp: number; ac: number; init: number; atk: number; dmg: Dice; spell?: { atk: number; dmg: Dice }; heal?: Dice }
> = {
  fighter: { hp: 32, ac: 16, init: 1, atk: 5, dmg: [1, 8, 3] },
  rogue: { hp: 24, ac: 14, init: 3, atk: 6, dmg: [1, 6, 3] },
  wizard: { hp: 18, ac: 12, init: 2, atk: 2, dmg: [1, 4, 0], spell: { atk: 5, dmg: [1, 10, 2] } },
  cleric: { hp: 26, ac: 15, init: 0, atk: 3, dmg: [1, 6, 1], heal: [1, 8, 3] },
};

// ---------- Seeded RNG (mulberry32) ----------
function rand(c: Combat): number {
  c.seed = (c.seed + 0x6d2b79f5) | 0;
  let t = c.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const d = (c: Combat, sides: number) => 1 + Math.floor(rand(c) * sides);
function roll(c: Combat, [n, s, m]: Dice, extraDice = 0): number {
  let total = m;
  for (let i = 0; i < n + extraDice; i++) total += d(c, s);
  return total;
}

// ---------- Setup ----------
export function createCombat(members: { id: string; name: string; cls: ClassId }[], seed: number): Combat {
  const c: Combat = { round: 1, seed, entities: [] };
  for (const m of members) {
    const k = CLASSES[m.cls];
    c.entities.push({
      id: m.id, name: m.name, kind: "player", cls: m.cls,
      hp: k.hp, maxHp: k.hp, ac: k.ac, initBonus: k.init, initiative: 0,
      attackBonus: k.atk, dmg: k.dmg, defending: false, connected: true,
    });
  }
  const goblins = Math.max(2, members.length);
  for (let i = 1; i <= goblins; i++) {
    c.entities.push({
      id: `m${i}`, name: `Goblin ${i}`, kind: "monster",
      hp: 7, maxHp: 7, ac: 13, initBonus: 2, initiative: 0,
      attackBonus: 4, dmg: [1, 6, 2], defending: false, connected: true,
    });
  }
  if (members.length >= 2) {
    c.entities.push({
      id: `m${goblins + 1}`, name: "Cave Ogre", kind: "monster",
      hp: 30, maxHp: 30, ac: 11, initBonus: -1, initiative: 0,
      attackBonus: 6, dmg: [2, 6, 2], defending: false, connected: true,
    });
  }
  for (const e of c.entities) e.initiative = d(c, 20) + e.initBonus;
  return c;
}

// ---------- Validation ----------
export function validateAction(c: Combat, playerId: string, a: SubmittedAction): string | null {
  const me = c.entities.find((e) => e.id === playerId && e.kind === "player");
  if (!me || me.hp <= 0) return "You are not able to act.";
  if (a.type === "spell" && !CLASSES[me.cls!].spell) return "Your class has no spell.";
  if (a.type === "heal" && !CLASSES[me.cls!].heal) return "Your class cannot heal.";
  if (a.type === "attack" || a.type === "spell") {
    if (a.targetId) {
      const t = c.entities.find((e) => e.id === a.targetId);
      if (!t || t.kind !== "monster" || t.hp <= 0) return "Pick a living enemy.";
    }
  }
  if (a.type === "heal" && a.targetId) {
    const t = c.entities.find((e) => e.id === a.targetId);
    if (!t || t.kind !== "player" || t.hp <= 0) return "Pick a living ally.";
  }
  return null;
}

// ---------- Resolution ----------
export function resolveRound(
  c: Combat,
  actions: Map<string, SubmittedAction>,
  timedOut: Set<string>,
): TurnResolution {
  const events: TurnEvent[] = [];
  let seq = 0;
  const get = (id: string) => c.entities.find((e) => e.id === id);
  const living = (kind: "player" | "monster") => c.entities.filter((e) => e.kind === kind && e.hp > 0);

  // Simultaneous declaration: every Defend takes effect before anyone swings.
  for (const [id, a] of actions) if (a.type === "defend") { const e = get(id); if (e && e.hp > 0) e.defending = true; }
  for (const id of timedOut) { const e = get(id); if (e && e.hp > 0) e.defending = true; }

  const order = c.entities
    .filter((e) => e.hp > 0)
    .sort((a, b) => b.initiative - a.initiative || a.id.localeCompare(b.id))
    .map((e) => e.id);

  const strike = (actor: Entity, tgt: Entity, bonus: number, dmg: Dice, kind: "attack" | "spell", retargeted: boolean) => {
    const d20 = d(c, 20);
    const total = d20 + bonus;
    const ac = tgt.ac + (tgt.defending ? DEFEND_BONUS : 0);
    const fumble = d20 === 1;
    const crit = d20 === 20;
    const hit = crit || (!fumble && total >= ac);
    let damage = 0;
    if (hit) damage = Math.max(1, roll(c, dmg, crit ? dmg[0] : 0));
    tgt.hp = Math.max(0, tgt.hp - damage);
    const defeated = tgt.hp === 0 && damage > 0;
    const verb = kind === "spell" ? "casts Firebolt at" : "attacks";
    const text =
      `${actor.name} ${verb} ${tgt.name} (d20 ${d20}${bonus >= 0 ? "+" : ""}${bonus} = ${total} vs AC ${ac}) — ` +
      (hit ? `${crit ? "CRITICAL HIT, " : ""}${damage} damage` : fumble ? "fumble, a clean miss" : "miss") +
      (defeated ? `. ${tgt.name} is defeated!` : "");
    events.push({
      seq: ++seq, actorId: actor.id, actorName: actor.name, kind, targetId: tgt.id, targetName: tgt.name,
      d20, modifier: bonus, total, targetAc: ac, hit, crit, fumble, damage, targetHpAfter: tgt.hp, defeated,
      retargeted: retargeted || undefined, text,
    });
  };

  for (const id of order) {
    if (living("player").length === 0 || living("monster").length === 0) break;
    const actor = get(id)!;
    if (actor.hp <= 0) continue;

    if (actor.kind === "monster") {
      const targets = living("player");
      const tgt = targets[d(c, targets.length) - 1];
      strike(actor, tgt, actor.attackBonus, actor.dmg, "attack", false);
      continue;
    }

    const a = actions.get(id);
    if (timedOut.has(id) || !a) {
      events.push({
        seq: ++seq, actorId: id, actorName: actor.name, kind: "timeout",
        text: `${actor.name} hesitates and takes cover (+${DEFEND_BONUS} AC).`,
      });
      continue;
    }
    const k = CLASSES[actor.cls!];
    if (a.type === "defend") {
      events.push({
        seq: ++seq, actorId: id, actorName: actor.name, kind: "defend",
        text: `${actor.name} braces behind their guard (+${DEFEND_BONUS} AC).`,
      });
    } else if (a.type === "heal") {
      let tgt = a.targetId ? get(a.targetId) : actor;
      if (!tgt || tgt.hp <= 0) tgt = actor;
      const healing = Math.min(roll(c, k.heal!), tgt.maxHp - tgt.hp);
      tgt.hp += healing;
      events.push({
        seq: ++seq, actorId: id, actorName: actor.name, kind: "heal", targetId: tgt.id, targetName: tgt.name,
        healing, targetHpAfter: tgt.hp,
        text: `${actor.name} heals ${tgt.name} for ${healing} (HP ${tgt.hp}/${tgt.maxHp}).`,
      });
    } else {
      let tgt = a.targetId ? get(a.targetId) : undefined;
      let retargeted = false;
      if (!tgt || tgt.kind !== "monster" || tgt.hp <= 0) {
        tgt = living("monster")[0];
        retargeted = !!a.targetId;
      }
      if (a.type === "spell") strike(actor, tgt, k.spell!.atk, k.spell!.dmg, "spell", retargeted);
      else strike(actor, tgt, actor.attackBonus, actor.dmg, "attack", retargeted);
    }
  }

  for (const e of c.entities) e.defending = false;
  const outcome = living("monster").length === 0 ? "victory" : living("player").length === 0 ? "defeat" : "ongoing";
  const res: TurnResolution = { round: c.round, events, outcome };
  c.round += 1;
  return res;
}
