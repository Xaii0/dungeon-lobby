// Offline evaluation of the narration guard + fallback + few-shot exemplars (no API key needed).
// With ANTHROPIC_API_KEY set, it also runs a live eval of the real LLM narrator and prints pass rates.
import { checkNarration, templateNarration, type NarrationContext } from "../src/guard.js";
import { EXEMPLARS } from "../src/dmprompt.js";
import { createCombat, resolveRound, type SubmittedAction } from "../src/rules.js";

let failed = 0;
const ok = (c: boolean, m: string) => { if (c) console.log("ok  ", m); else { failed++; console.error("FAIL", m); } };

// 1) The examples we teach with must satisfy the rules we enforce.
EXEMPLARS.forEach((x, i) => ok(checkNarration(x.narration, x.context) === null, `exemplar ${i + 1} passes the guard (${checkNarration(x.narration, x.context) ?? "clean"})`));

// 2) Adversarial battery: each bad narration must be rejected for the expected reason.
const ctx = EXEMPLARS[0].context; // Mira crit-kills Goblin 1; Cave Ogre misses Brann; outcome ongoing
const long = Array(130).fill("steel").join(" ");
const BAD: [string, string][] = [
  ["Mira's dagger deals 47 damage to Goblin 1, which falls. The Cave Ogre misses Brann.", "invented_number"],
  ["Mira rolled high and Goblin 1 falls. The Cave Ogre swings wide at Brann.", "dice_talk"],
  ["Goblin 1 falls to Mira. The Cave Ogre misses Brann. What do you do next?", "offers_choice"],
  ["You watch Goblin 1 fall to Mira's dagger. The Cave Ogre misses Brann.", "addresses_player"],
  ["Mira feels a surge of pride as Goblin 1 falls. The Cave Ogre misses Brann.", "player_agency"],
  ["Brann thinks about retreating as the Cave Ogre misses, and Mira kills Goblin 1.", "player_agency"],
  ['Brann shouts "For the crown!" as the Cave Ogre misses him. Mira drops Goblin 1.', "quote_near_player"],
  ["Mira kills Goblin 1, the Cave Ogre misses Brann, and reinforcements pour in.", "invents_enemy"],
  ["Mira fells Goblin 1; the Cave Ogre misses Brann. Victory is theirs.", "premature_victory"],
  ["All the goblins are dead and Mira wins the battle forever.", "premature_victory"],
  ["Goblin 1 falls to Mira's dagger and the party falls into despair.", "false_defeat"],
  ["Mira kills Goblin 1 and finds a potion nearby. The Cave Ogre misses Brann, and a new spell is learned.", "grants_item"],
  ["Mira's dagger flashes through the gloom while the Cave Ogre misses Brann.", "missing_defeat"],
  ['{"narration":"Mira kills Goblin 1."}', "markup_leak"],
  ["Ok.", "too_short"],
  [long, "too_long"],
];
for (const [text, reason] of BAD) {
  const r = checkNarration(text, ctx);
  ok(r !== null && r.startsWith(reason), `rejects "${text.slice(0, 48)}…" -> ${r}`);
}

// 3) Positive controls: good narration (including monster speech) must pass.
const GOOD = [
  "Mira's blade flashes and Goblin 1 crumples. The Cave Ogre's club whistles past Brann and cracks the flagstones.",
  '"Crush them!" bellows the Cave Ogre. Its club smashes stone beside Brann while Mira\'s dagger drops Goblin 1.',
];
GOOD.forEach((t) => ok(checkNarration(t, ctx) === null, `accepts good narration (${checkNarration(t, ctx) ?? "clean"})`));

// 4) Template fallback must ALWAYS pass the guard, over many real simulated rounds.
function buildCtx(c: ReturnType<typeof createCombat>, res: ReturnType<typeof resolveRound>): NarrationContext {
  return {
    scene: "a torchlit crypt", storySoFar: "", recentRounds: [],
    party: c.entities.filter((e) => e.kind === "player").map((e) => ({ name: e.name, cls: e.cls, hp: e.hp, maxHp: e.maxHp })),
    enemies: c.entities.filter((e) => e.kind === "monster").map((e) => ({ name: e.name, hp: e.hp, maxHp: e.maxHp })),
    resolution: res, playerFlavor: [],
  };
}
const CLS = ["fighter", "rogue", "wizard", "cleric"] as const;
let rounds = 0, bad = 0; const reasons: Record<string, number> = {};
const samples: NarrationContext[] = [];
for (let seed = 1; seed <= 400; seed++) {
  const n = 1 + (seed % 5);
  const c = createCombat(Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: ["Aldric", "Zara", "Mira", "Brann", "Elin"][i], cls: CLS[(seed + i) % 4] })), seed);
  for (let r = 0; r < 60; r++) {
    const acts = new Map<string, SubmittedAction>();
    const to = new Set<string>();
    for (const e of c.entities.filter((x) => x.kind === "player" && x.hp > 0)) {
      if ((seed + r + e.id.length) % 7 === 0) to.add(e.id);
      else acts.set(e.id, { type: e.cls === "wizard" ? "spell" : (r + seed) % 5 === 0 ? "defend" : "attack" });
    }
    const res = resolveRound(c, acts, to);
    const x = buildCtx(c, res);
    const why = checkNarration(templateNarration(x), x);
    rounds++;
    if (why) { bad++; const k = why.split(":")[0]; reasons[k] = (reasons[k] ?? 0) + 1; }
    if (samples.length < 30) samples.push(x);
    if (res.outcome !== "ongoing") break;
  }
}
ok(bad === 0, `template fallback passes the guard on ${rounds} simulated rounds (${bad} violations ${JSON.stringify(reasons)})`);

// 5) Optional live eval of the real LLM narrator.
if (process.env.ANTHROPIC_API_KEY) {
  const { narrateRound, stats } = await import("../src/narrator.js");
  let llm = 0;
  for (const x of samples) if ((await narrateRound(x)).source === "llm") llm++;
  console.log(`live: ${llm}/${samples.length} accepted from the LLM`, stats);
  ok(llm / samples.length >= 0.8, "live LLM narration acceptance rate >= 80%");
} else {
  console.log("skip live LLM eval (set ANTHROPIC_API_KEY to run it)");
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall narrator checks passed");
