// Dependency-free narration guard + deterministic fallback narrator.
// Everything the LLM says must pass checkNarration() before any player sees it.
import type { TurnResolution } from "./schemas.js";

export interface NarrationContext {
  scene: string;
  sceneNotes?: string;
  storySoFar: string;
  recentRounds: string[];
  party: { name: string; cls?: string; hp: number; maxHp: number }[];
  enemies: { name: string; hp: number; maxHp: number }[];
  resolution: TurnResolution;
  playerFlavor: { actor: string; text: string }[]; // UNTRUSTED player text
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const baseName = (n: string) => n.replace(/\s*\d+$/, "").toLowerCase();

/** Numbers the narrator may legitimately repeat: only this round's mechanics. */
export function allowedNumbers(ctx: NarrationContext): Set<string> {
  const s = new Set<string>([String(ctx.resolution.round)]);
  for (const e of ctx.resolution.events)
    for (const v of Object.values(e)) if (typeof v === "number") s.add(String(v));
  for (const x of [...ctx.party, ...ctx.enemies]) { s.add(String(x.hp)); s.add(String(x.maxHp)); }
  // digits that are part of enemy names ("Goblin 2") are fine
  for (const e of ctx.enemies) for (const d of e.name.match(/\d+/g) ?? []) s.add(d);
  return s;
}

const MENTAL = "says?|said|shouts?|shouted|whispers?|whispered|replies|replied|declares?|declared|asks?|asked|thinks?|thought|decides?|decided|feels?|felt|wonders?|realizes?|hopes?|wants?|fears?|knows?|remembers?|resolves?|vows?|smiles?|grins?|laughs?|curses|mutters?|chooses?|swears?";

/** Returns null when the narration is acceptable, otherwise a short machine-readable reason. */
export function checkNarration(text: string, ctx: NarrationContext): string | null {
  const t = text.trim();
  if (t.length < 10) return "too_short";
  if (t.split(/\s+/).length > 110) return "too_long";
  if (/[{}\[\]]|```|^#/m.test(t)) return "markup_leak";

  const ok = allowedNumbers(ctx);
  for (const n of t.match(/\d+/g) ?? []) if (!ok.has(n)) return `invented_number:${n}`;
  if (/\b(d20|d\d+|rolled|rolls?|natural (20|one)|dice)\b/i.test(t)) return "dice_talk";
  if (/\b(what do you do|what will you do|your turn|you decide|do you|will you|choose|make your move)\b/i.test(t)) return "offers_choice";

  // Combat-state invention
  if (/\b(reinforcements|more (goblins|enemies|monsters|foes)|a new (foe|enemy|monster)|another (goblin|ogre|enemy))\b/i.test(t)) return "invents_enemy";
  if (/\b(loot|reward|you (find|receive|gain|obtain)|new (item|ability|spell)|level up|experience points)\b/i.test(t)) return "grants_item";
  if (ctx.resolution.outcome === "ongoing" &&
      /\b(victory|victorious|the last (enemy|foe)|all (the )?(enemies|foes|goblins) (are )?(dead|defeated|slain)|the battle is (won|over))\b/i.test(t)) return "premature_victory";
  if (ctx.resolution.outcome !== "defeat" && /\b(the party (falls|is dead|is wiped)|everyone is dead)\b/i.test(t)) return "false_defeat";

  // Player agency: no "you", no speech/thoughts/feelings/decisions for player characters
  const unquoted = t.replace(/["“][^"”]*["”]/g, " ");
  if (/\b(you|your|yours)\b/i.test(unquoted)) return "addresses_player";
  const names = ctx.party.map((p) => p.name);
  for (const s of t.split(/(?<=[.!?])\s+/)) {
    for (const n of names) {
      if (!new RegExp(`\\b${esc(n)}\\b`, "i").test(s)) continue;
      if (/["“”]/.test(s)) return `quote_near_player:${n}`;
      if (new RegExp(`\\b${esc(n)}\\b[^.!?\\n]{0,60}\\b(${MENTAL})\\b`, "i").test(s)) return `player_agency:${n}`;
    }
  }

  // Fidelity: every defeat in the events must be acknowledged by name
  const lower = t.toLowerCase();
  for (const e of ctx.resolution.events) {
    if (e.defeated && e.targetName && !lower.includes(baseName(e.targetName))) return `missing_defeat:${e.targetName}`;
  }
  return null;
}
export const validateNarration = (text: string, ctx: NarrationContext) => checkNarration(text, ctx) === null;

// ---------- Deterministic fallback (always passes checkNarration) ----------
const HIT = ["steel bites deep", "the blow lands true", "the strike finds its mark", "a hard, ringing impact"];
const MISS = ["the strike glances away", "the attack goes wide", "it scrapes harmlessly past", "the swing finds only air"];
const DOWN = ["and the foe crumples", "and it collapses to the floor", "and it falls still"];

export function templateNarration(ctx: NarrationContext): string {
  const parts: string[] = [];
  for (const e of ctx.resolution.events) {
    const i = e.seq;
    if (e.kind === "heal") parts.push(`${e.actorName} calls on soft light, mending ${e.targetName}'s wounds.`);
    else if (e.kind === "defend" || e.kind === "timeout") parts.push(`${e.actorName} drops behind a guarded stance.`);
    else if (e.hit) {
      parts.push(
        `${e.actorName}${e.kind === "spell" ? " hurls a bolt of flame at" : " strikes"} ${e.targetName}: ${e.crit ? "a devastating blow, " : ""}${HIT[i % HIT.length]}${e.defeated ? `, ${DOWN[i % DOWN.length]}` : ""}.`,
      );
    } else parts.push(`${e.actorName} lunges at ${e.targetName}, but ${MISS[i % MISS.length]}.`);
  }
  const tail =
    ctx.resolution.outcome === "victory"
      ? "Silence settles over the chamber. The last enemy is down."
      : ctx.resolution.outcome === "defeat"
        ? "The torchlight gutters as the party falls."
        : "";
  // keep the fallback short enough for the same word budget
  return [...parts.slice(0, 7), tail].filter(Boolean).join(" ");
}
