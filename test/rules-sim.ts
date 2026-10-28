// Property/simulation test for the deterministic rules engine. No dependencies.
import { createCombat, resolveRound, validateAction, type Combat, type SubmittedAction } from "../src/rules.js";

const CLS = ["fighter", "rogue", "wizard", "cleric"] as const;
const fails: string[] = [];
const check = (c: boolean, m: string) => { if (!c && fails.length < 20) fails.push(m); };

function lcg(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

function simulate(fightSeed: number) {
  const r = lcg(fightSeed * 7 + 1);
  const n = 1 + Math.floor(r() * 6);
  const members = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, cls: CLS[Math.floor(r() * 4)] }));
  const c: Combat = createCombat(members, fightSeed);
  const log: unknown[] = [];
  let rounds = 0;
  for (;;) {
    rounds++;
    check(rounds <= 400, `seed ${fightSeed}: fight did not terminate`);
    if (rounds > 400) break;
    const aliveAtStart = new Set(c.entities.filter((e) => e.hp > 0).map((e) => e.id));
    const actions = new Map<string, SubmittedAction>();
    const timedOut = new Set<string>();
    for (const e of c.entities.filter((x) => x.kind === "player" && x.hp > 0)) {
      if (r() < 0.12) { timedOut.add(e.id); continue; }
      const roll = r();
      const type = roll < 0.2 ? "defend" : e.cls === "wizard" && roll < 0.7 ? "spell" : e.cls === "cleric" && roll < 0.6 ? "heal" : "attack";
      const stale = r() < 0.2 ? "m1" : undefined; // may point at a dead enemy -> engine must retarget
      const targetId = type === "defend" ? undefined : type === "heal" ? members[Math.floor(r() * n)].id : stale;
      const a: SubmittedAction = { type, targetId };
      if (validateAction(c, e.id, a)) { timedOut.add(e.id); continue; }
      actions.set(e.id, a);
    }
    const res = resolveRound(c, actions, timedOut);
    log.push(res);

    // invariants
    for (const e of c.entities) check(e.hp >= 0 && e.hp <= e.maxHp, `seed ${fightSeed}: hp out of range for ${e.name}`);
    let last = 0;
    for (const ev of res.events) {
      check(ev.seq === last + 1, `seed ${fightSeed}: seq not increasing`); last = ev.seq;
      check(aliveAtStart.has(ev.actorId), `seed ${fightSeed}: dead actor ${ev.actorName} acted`);
      check(ev.text.length > 0, `seed ${fightSeed}: empty event text`);
      if (ev.kind === "attack" || ev.kind === "spell") {
        check(typeof ev.hit === "boolean" && (ev.damage ?? -1) >= 0, `seed ${fightSeed}: bad attack event`);
        check(ev.hit || ev.damage === 0, `seed ${fightSeed}: miss dealt damage`);
        check(!ev.defeated || ev.targetHpAfter === 0, `seed ${fightSeed}: defeated but hp>0`);
        check((ev.d20 ?? 0) >= 1 && (ev.d20 ?? 0) <= 20, `seed ${fightSeed}: d20 out of range`);
        check(!(ev.fumble && ev.hit), `seed ${fightSeed}: fumble hit`);
        check(!(ev.crit && !ev.hit), `seed ${fightSeed}: crit missed`);
      }
      if (ev.kind === "heal") check((ev.targetHpAfter ?? 0) <= c.entities.find((e) => e.id === ev.targetId)!.maxHp, `seed ${fightSeed}: overheal`);
    }
    const monstersAlive = c.entities.some((e) => e.kind === "monster" && e.hp > 0);
    const playersAlive = c.entities.some((e) => e.kind === "player" && e.hp > 0);
    const expected = !monstersAlive ? "victory" : !playersAlive ? "defeat" : "ongoing";
    check(res.outcome === expected, `seed ${fightSeed}: outcome ${res.outcome} != ${expected}`);
    check(c.entities.every((e) => !e.defending), `seed ${fightSeed}: defend flag leaked across rounds`);
    if (res.outcome !== "ongoing") return { log, rounds, outcome: res.outcome };
  }
  return { log, rounds, outcome: "stuck" };
}

const N = 1000;
const tally: Record<string, number> = {};
let totalRounds = 0;
for (let seed = 1; seed <= N; seed++) {
  const a = simulate(seed);
  const b = simulate(seed); // determinism: identical seed + policy => identical history
  check(JSON.stringify(a.log) === JSON.stringify(b.log), `seed ${seed}: not deterministic`);
  tally[a.outcome] = (tally[a.outcome] ?? 0) + 1;
  totalRounds += a.rounds;
}

console.log(`fights: ${N}, outcomes:`, tally, `avg rounds: ${(totalRounds / N).toFixed(1)}`);
if (fails.length) { console.error("FAIL\n" + fails.join("\n")); process.exit(1); }
console.log("ok   rules engine: invariants, determinism, retargeting, timeouts, termination");
