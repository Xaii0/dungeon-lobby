// Rules engine + narration guard tests for the static site. Run: node tests/engine.test.mjs
import {
  CLASSES, createCombat, resolveRound, validateAction, checkNarration, templateNarration,
  introNarration, narratorEvents, EXEMPLARS, SCENES,
} from "../docs/engine.js";
import { exemplarContext } from "../docs/narrator.js";

let failed = 0;
const ok = (c, m) => { if (c) console.log("ok  ", m); else { failed++; console.error("FAIL", m); } };
const CLS = Object.keys(CLASSES);
const NAMES = ["Aldric", "Zara", "Mira", "Brann", "Elin", "Kestrel"];
const cond = (hp, max) => (hp <= 0 ? "down" : hp >= max ? "unhurt" : hp / max > 0.5 ? "wounded" : "badly wounded");

function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

/** Reasonable player policy: casters cast, clerics heal the badly hurt, occasional defends/timeouts. */
function playRound(c, r) {
  const actions = new Map(), timedOut = new Set();
  for (const e of c.entities.filter((x) => x.kind === "player" && x.hp > 0)) {
    if (r() < 0.08) { timedOut.add(e.id); continue; }
    const hurt = c.entities.filter((x) => x.kind === "player" && x.hp > 0 && x.hp < x.maxHp * 0.4)[0];
    const foes = c.entities.filter((x) => x.kind === "monster" && x.hp > 0);
    const foe = foes[Math.floor(r() * foes.length)];
    let a;
    if (e.cls === "cleric" && hurt && r() < 0.8) a = { type: "heal", targetId: hurt.id };
    else if (r() < 0.08) a = { type: "defend" };
    else a = { type: e.cls === "wizard" ? "spell" : "attack", targetId: r() < 0.1 ? "m1" : foe.id };
    if (validateAction(c, e.id, a)) a = { type: e.cls === "wizard" ? "spell" : "attack" };
    actions.set(e.id, a);
  }
  return resolveRound(c, actions, timedOut);
}

const ctxOf = (c, res) => ({
  scene: SCENES[0].text, storySoFar: "", recentRounds: [],
  party: c.entities.filter((e) => e.kind === "player").map((e) => ({ name: e.name, cls: e.cls, condition: cond(e.hp, e.maxHp) })),
  enemies: c.entities.filter((e) => e.kind === "monster").map((e) => ({ name: e.name, condition: cond(e.hp, e.maxHp) })),
  resolution: { round: res.round, outcome: res.outcome, events: narratorEvents(res.events) },
  playerFlavor: [],
});

// ---------- 1. invariants, determinism, termination, balance by depth ----------
const fails = [];
const check = (c, m) => { if (!c && fails.length < 10) fails.push(m); };
const winRate = {};
let templateBad = 0, templateRounds = 0;
const templateReasons = {};
for (let depth = 1; depth <= 5; depth++) {
  let wins = 0, fights = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const r1 = lcg(seed * 31 + depth), n = 1 + (seed % 6);
    const members = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: NAMES[i], cls: CLS[(seed + i * 3) % 4] }));
    const runs = [];
    for (let rep = 0; rep < 2; rep++) {
      const r = lcg(seed * 31 + depth);
      const c = createCombat(members, seed * 977 + depth, depth);
      const log = [];
      let res, rounds = 0;
      do {
        rounds++;
        const alive = new Set(c.entities.filter((e) => e.hp > 0).map((e) => e.id));
        res = playRound(c, r);
        log.push(res);
        for (const e of c.entities) check(e.hp >= 0 && e.hp <= e.maxHp, `hp range ${e.name}`);
        let last = 0;
        for (const ev of res.events) {
          check(ev.seq === last + 1, "seq order"); last = ev.seq;
          check(alive.has(ev.actorId), `dead actor acted (${ev.actorName})`);
          if (ev.kind === "attack" || ev.kind === "spell") {
            check(ev.hit || ev.damage === 0, "miss dealt damage");
            check(!ev.defeated || ev.targetHpAfter === 0, "defeated with hp");
            check(!(ev.fumble && ev.hit) && !(ev.crit && !ev.hit), "crit/fumble logic");
          }
        }
        check(c.entities.every((e) => !e.defending), "defend leaked");
        if (rep === 0) {
          const x = ctxOf(c, res);
          const why = checkNarration(templateNarration(x), x);
          templateRounds++;
          if (why) { templateBad++; const k = why.split(":")[0]; templateReasons[k] = (templateReasons[k] || 0) + 1; if (templateBad < 3) console.log("  template issue:", why, "|", templateNarration(x)); }
        }
      } while (res.outcome === "ongoing" && rounds < 300);
      check(rounds < 300, "fight did not end");
      runs.push(JSON.stringify(log));
      if (rep === 0) { fights++; if (res.outcome === "victory") wins++; }
    }
    check(runs[0] === runs[1], `seed ${seed} depth ${depth} not deterministic`);
  }
  winRate[depth] = Math.round((100 * wins) / fights);
}
ok(fails.length === 0, `rules invariants over ${5 * 400} fights${fails.length ? ": " + fails.join("; ") : ""}`);
console.log("     win rate by depth (%):", winRate);
ok(winRate[1] >= 55 && winRate[1] <= 95, "depth 1 is winnable but not trivial");
ok(winRate[5] < winRate[1], "deeper fights are harder");
// class-appropriate verbs: a cleric never swings a blade, a goblin never "drives a shoulder"
{
  const c = createCombat([{ id: "p0", name: "Lark", cls: "cleric" }], 5, 1);
  const res = { round: 1, outcome: "ongoing", events: [
    { seq: 1, actorName: "Lark", actorType: "cleric", kind: "attack", targetName: "Goblin 1", targetKind: "monster", hit: true, defeated: false },
    { seq: 2, actorName: "Goblin 1", actorType: "goblin", kind: "attack", targetName: "Lark", targetKind: "player", hit: true, defeated: false },
  ] };
  const text = templateNarration({ ...ctxOf(c, { round: 1, outcome: "ongoing", events: [] }), resolution: { ...res, events: narratorEvents(res.events) } });
  ok(/mace/.test(text) && !/blade down|shoulder/.test(text), `built-in narrator uses class and monster moves: "${text}"`);
}
ok(templateBad === 0, `built-in narrator passes the guard on ${templateRounds} rounds ${JSON.stringify(templateReasons)}`);

// intros
let introBad = 0;
for (let seed = 1; seed <= 200; seed++) {
  const c = createCombat([{ id: "p0", name: "Aldric", cls: "fighter" }, { id: "p1", name: "Zara", cls: "wizard" }], seed, 1 + (seed % 5));
  const enemies = c.entities.filter((e) => e.kind === "monster");
  const text = introNarration(SCENES[seed % SCENES.length].text, enemies, 1 + (seed % 5), seed);
  const x = ctxOf(c, { round: 0, outcome: "ongoing", events: [] });
  if (checkNarration(text, x)) { introBad++; if (introBad < 3) console.log("  intro issue:", checkNarration(text, x), text); }
}
ok(introBad === 0, "scene intros pass the guard");

// ---------- 2. exemplars and adversarial battery ----------
EXEMPLARS.forEach((x, i) => {
  const why = checkNarration(x.narration, exemplarContext(x.context));
  ok(!why, `exemplar ${i + 1} passes the guard${why ? " (" + why + ")" : ""}`);
});
const ctx = exemplarContext(EXEMPLARS[0].context);
const BAD = [
  ["Mira's dagger deals 47 damage to Goblin 1, which falls. The Cave Ogre misses Brann.", "invented_number"],
  ["Mira rolled high and Goblin 1 falls. The Cave Ogre swings wide at Brann.", "dice_talk"],
  ["Goblin 1 falls to Mira. The Cave Ogre misses Brann. What happens next?", "offers_choice"],
  ["You watch Goblin 1 fall to Mira's dagger. The Cave Ogre misses Brann.", "addresses_player"],
  ["Mira feels a surge of pride as Goblin 1 falls. The Cave Ogre misses Brann.", "player_agency"],
  ["Brann thinks about retreating as the Cave Ogre misses, and Mira kills Goblin 1.", "player_agency"],
  ['Brann shouts "For the crown!" as the Cave Ogre misses him. Mira drops Goblin 1.', "quote_near_player"],
  ["Mira kills Goblin 1, the Cave Ogre misses Brann, and reinforcements pour in.", "invents_enemy"],
  ["Mira fells Goblin 1 as the Cave Ogre misses Brann, and another goblin appears.", "invents_enemy"],
  ["Mira fells Goblin 1; the Cave Ogre misses Brann. Victory is theirs.", "premature_victory"],
  ["Goblin 1 falls to Mira's dagger and the party falls into despair.", "false_defeat"],
  ["Mira kills Goblin 1 and finds a potion nearby while the Cave Ogre misses Brann.", "grants_item"],
  ["Mira's dagger flashes through the gloom while the Cave Ogre misses Brann.", "missing_defeat"],
  ['{"narration":"Mira kills Goblin 1."}', "markup_leak"],
  ["Ok.", "too_short"],
  [Array(130).fill("steel").join(" "), "too_long"],
];
for (const [text, reason] of BAD) {
  const r = checkNarration(text, ctx);
  ok(r && r.startsWith(reason), `rejects ${reason}: "${text.slice(0, 40)}…" -> ${r}`);
}
for (const t of [
  "Mira's blade flashes and Goblin 1 crumples. The Cave Ogre's club whistles past Brann and cracks the flagstones.",
  '"Crush them!" bellows the Cave Ogre. Its club smashes stone beside Brann while Mira\'s dagger drops Goblin 1.',
]) ok(!checkNarration(t, ctx), `accepts good narration (${checkNarration(t, ctx) || "clean"})`);

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nengine: all checks passed");
