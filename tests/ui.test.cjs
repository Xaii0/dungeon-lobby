// End-to-end UI test: three browser tabs play through the real page using the local transport.
// Start a static server on docs/ first:  python3 -m http.server 8765 -d docs
// Run: node tests/ui.test.cjs
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:8765/?net=local";
const SHOTS = process.env.SHOTS || "/tmp";

let failed = 0;
const ok = (c, m) => { if (c) console.log("ok  ", m); else { failed++; console.error("FAIL", m); } };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  const open = async (label, url = BASE) => {
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
    p.on("console", (m) => { if (m.type() === "error") errors.push(`${label} console: ${m.text()}`); });
    p.on("dialog", (d) => d.accept());
    await p.goto(url);
    return p;
  };
  const enter = async (p, name, cls, code = "5467") => {
    await p.fill("#name", name);
    await p.fill("#entryCode", code);
    await p.click(`#classes button[data-c="${cls}"]`);
    await p.click("#btnEnter");
  };

  // --- entry gate ---
  const A = await open("A");
  await enter(A, "Aldric", "fighter", "1111");
  await A.waitForTimeout(200);
  ok((await A.textContent("#entryErr")).includes("not right"), "wrong entry code is refused");
  await A.screenshot({ path: `${SHOTS}/ui-1-entry.png` });
  await enter(A, "Aldric", "fighter");
  await A.waitForSelector("#hub:not(.hidden)");
  ok(true, "entry code 5467 opens the hub");

  // --- create public room ---
  await A.click("#btnCreate");
  await A.waitForSelector("#room:not(.hidden)", { timeout: 10000 });
  const code = (await A.textContent("#roomCode")).trim();
  ok(/^\d{4}$/.test(code) && code !== "5467", `creator gets their own room code ${code}`);
  ok((await A.textContent("#visTag")).includes("public"), "room is public");

  // --- second player finds it in the server browser ---
  const Z = await open("Z");
  await enter(Z, "Zara", "wizard");
  await Z.waitForSelector(`#roomList button[data-join="${code}"]`, { timeout: 8000 });
  ok(true, "public room shows in another player's server browser");
  await Z.screenshot({ path: `${SHOTS}/ui-2-browser.png` });
  await Z.click(`#roomList button[data-join="${code}"]`);
  await Z.waitForSelector("#room:not(.hidden)");
  ok((await Z.textContent("#roomCode")).trim() === code, "joined from the browser");

  // --- private room: hidden from the browser, joinable by code ---
  const P = await open("P");
  await enter(P, "Pip", "rogue");
  await P.selectOption?.call; // no-op
  await P.click('#vis button[data-v="private"]');
  await P.click("#btnCreate");
  await P.waitForSelector("#room:not(.hidden)", { timeout: 10000 });
  const pcode = (await P.textContent("#roomCode")).trim();
  ok((await P.textContent("#visTag")).includes("private"), `private room created ${pcode}`);

  const E = await open("E");
  await enter(E, "Elin", "cleric");
  await E.waitForTimeout(1500);
  const listed = await E.$$eval("#roomList button[data-join]", (bs) => bs.map((b) => b.dataset.join));
  ok(listed.includes(code) && !listed.includes(pcode), "server browser lists the public room but not the private one");
  await E.fill("#joinCode", "5467");
  await E.click("#joinBtn");
  await E.waitForTimeout(300);
  ok((await E.textContent("#hubErr")).includes("entry code"), "typing 5467 as a room code explains it is the entry code");
  await E.fill("#joinCode", pcode === "9999" ? "9998" : "9999");
  await E.click("#joinBtn");
  await E.waitForFunction(() => document.querySelector("#hubErr").textContent.includes("No room"), null, { timeout: 8000 });
  ok(true, "unknown room code is reported");
  await E.fill("#joinCode", pcode);
  await E.click("#joinBtn");
  await E.waitForSelector("#room:not(.hidden)");
  ok((await E.textContent("#roomCode")).trim() === pcode, "private room joined by code");

  // --- invite link deep-link ---
  const L = await open("L", `${BASE}#${code}`);
  ok((await L.textContent("#inviteNote")).includes(code), "invite link shows which room you were invited to");
  await enter(L, "Lark", "cleric");
  await L.waitForSelector("#room:not(.hidden)", { timeout: 8000 });
  ok((await L.textContent("#roomCode")).trim() === code, "invite link drops you into the room after the entry code");

  // --- lobby: only the creator can start ---
  await A.waitForFunction(() => document.querySelectorAll("#lobbyMembers .card").length === 3);
  ok(await A.isVisible("#btnStart"), "creator sees Start");
  ok(!(await Z.isVisible("#btnStart")), "other players don't");
  await A.screenshot({ path: `${SHOTS}/ui-3-lobby.png` });
  await A.click("#btnStart");
  for (const p of [A, Z, L]) await p.waitForSelector("#combat:not(.hidden)", { timeout: 5000 });
  ok(true, "battle starts for everyone");
  await A.waitForSelector("#story .nar", { timeout: 5000 });
  ok(true, "Dungeon Master narrates the scene");

  // --- play: everyone picks actions until the battle ends ---
  const actOnce = async (p) => {
    for (const t of ["spell", "attack"]) {
      const loc = p.locator(`#actions button[data-t="${t}"]:not([disabled])`);
      if (await loc.count()) { try { await loc.first().click({ timeout: 1500 }); } catch {} return; }
    }
  };
  let rounds = 0;
  for (let i = 0; i < 80; i++) {
    const phase = await A.evaluate(() => window.__dl.app.state && window.__dl.app.state.phase);
    if (phase === "ENDED" || phase === "LOBBY") break;
    for (const p of [A, Z, L]) await actOnce(p);
    await A.waitForTimeout(250);
    rounds = await A.$$eval("#log .round-log", (x) => x.length);
    if (i === 1) await Z.screenshot({ path: `${SHOTS}/ui-4-combat.png` });
  }
  const outcome = await A.evaluate(() => window.__dl.app.state.outcome || window.__dl.app.state.phase);
  ok(rounds >= 1, `battle played through ${rounds} rounds (${outcome})`);
  await A.waitForTimeout(800);
  const nA = await A.$$eval("#story .nar", (x) => x.length);
  const nZ = await Z.$$eval("#story .nar", (x) => x.length);
  ok(nA === rounds + 1 && nZ === nA, `every round narrated for every player (${nA} entries)`);
  const logA = await A.$$eval("#log .ev", (x) => x.map((e) => e.textContent).join("|"));
  const logZ = await Z.$$eval("#log .ev", (x) => x.map((e) => e.textContent).join("|"));
  ok(logA === logZ, "all players see the identical combat log");
  await Z.screenshot({ path: `${SHOTS}/ui-5-end.png`, fullPage: true });

  // --- heal flow for a cleric ---
  await A.waitForSelector("#lobby:not(.hidden)", { timeout: 20000 });
  ok(true, "room returns to the lobby after the battle");
  await A.click("#btnStart");
  await L.waitForSelector('#actions button[data-t="healmode"]:not([disabled])', { timeout: 5000 });
  await L.click('#actions button[data-t="healmode"]');
  await L.click('#party .card.pick');
  await L.click('#actions button[data-t="heal"]');
  await L.waitForFunction(() => document.querySelector("#actionNote").textContent.includes("Locked in"), null, { timeout: 5000 });
  ok(true, "cleric can target an ally and heal");

  // --- reload keeps your seat ---
  await Z.reload();
  await Z.waitForSelector("#room:not(.hidden)", { timeout: 10000 });
  ok((await Z.textContent("#roomCode")).trim() === code, "reloading the page puts you back in your room");

  // --- leaving & closing ---
  await L.click("#btnLeave");
  await L.waitForSelector("#hub:not(.hidden)");
  ok(true, "a player can leave back to the hub");
  await P.click("#btnLeave"); // host of the private room -> closes it
  await E.waitForFunction(() => !document.querySelector("#closedBanner").classList.contains("hidden"), null, { timeout: 5000 });
  ok((await E.textContent("#closedBanner")).includes("closed"), "players are told when the host closes the room");
  await E.waitForSelector("#hub:not(.hidden)", { timeout: 8000 });
  ok(true, "and are returned to the hub");

  // --- mobile layout ---
  const M = await ctx.newPage();
  await M.setViewportSize({ width: 390, height: 844 });
  await M.goto(BASE);
  const overflow = await M.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  ok(!overflow, "no horizontal scrolling on a phone");
  await M.screenshot({ path: `${SHOTS}/ui-6-phone.png`, fullPage: true });
  const AM = await ctx.newPage();
  await AM.setViewportSize({ width: 390, height: 844 });
  await AM.goto(BASE);
  await enter(AM, "Mo", "rogue");
  await AM.waitForSelector("#hub:not(.hidden)");
  await AM.fill("#joinCode", code);
  await AM.click("#joinBtn");
  await AM.waitForTimeout(1200);
  await AM.screenshot({ path: `${SHOTS}/ui-7-phone-room.png`, fullPage: true });
  const overflow2 = await AM.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  ok(!overflow2, "room screen fits a phone");

  // The sandbox blocks outside AI services; the page must fall back silently, so ignore that one network error.
  const real = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/.test(e));
  ok(real.length === 0, `no page errors${real.length ? ":\n  " + real.join("\n  ") : ""}`);
  await browser.close();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nui: all checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
