# Dungeon Lobby — architecture, corrected prompt, roadmap

## 1. Review of the original prompt

| Issue | Why it matters | Fix |
|---|---|---|
| Asks for a design doc *and* implies a game | The output was ambiguous: architecture essay vs. working product | Split into "architecture" and "runnable MVP" deliverables |
| "Node.js/Go", "Next.js/React/Vite/Vue", "OpenRouter/LangChain/..." | Too many open choices; answers go shallow | Pick one default stack, allow substitutions in a footnote |
| "Bulletproof", "completely restrict" the LLM | Not testable. Prompts alone cannot guarantee anything | Replace with enforceable controls: schema validation, post-generation checks, deterministic fallback |
| No scale / hosting target | Redis, Postgres and horizontal scaling change the design | State target: ~100 concurrent rooms, single region, 2–6 players per room |
| No definition of "turn-based" | Simultaneous commit vs. strict initiative turns are different designs | Specify simultaneous declaration, initiative-ordered resolution |
| No join mechanism | Needed for "lobbies" | Entry code (5467) gets you in; each player-created room gets its own random 4-digit code; public rooms appear in a server browser, private rooms are code-only |
| No failure behavior | Disconnects, LLM timeouts, double submits | Specify each explicitly (section 3) |
| No cost / latency budget for the LLM | Narration must not stall combat | Narration is asynchronous and off the critical path |
| Prompt-injection not mentioned | Player flavor text goes to the LLM | Treat player text as untrusted data |

## 2. Corrected prompt (reusable)

> Act as a principal game-systems architect. Design and implement a multiplayer, turn-based tabletop RPG (D&D-inspired) for 2–6 players per room, ~100 concurrent rooms, single region, with an LLM Dungeon Master that narrates only.
>
> **Stack (default):** TypeScript, Node 20, Socket.IO, Zod, in-memory room state behind a `RoomManager` interface (Redis adapter for scale-out), PostgreSQL/Prisma for characters and campaigns (later phase), plain HTML/JS client (Next.js later).
>
> **Requirements**
> 1. Lobbies: site entry code (5467) -> hub with server browser. Players create their own rooms (public = listed, private = hidden) with a random 4-digit code, join by code, host-controlled start, reconnect by player token.
> 2. Rounds: simultaneous action declaration, then initiative-ordered resolution. One locked action per player per round; timeout and disconnect auto-defend; no state can wait on an absent player.
> 3. Rules engine: the only place that rolls dice or changes HP/AC/conditions. Seeded PRNG so fights are replayable.
> 4. LLM: receives the resolved `TurnResolution` and returns `{narration}` only. Output is schema-validated and checked for invented numbers, dice talk, player dialogue/thoughts/decisions. On failure: retry once, then deterministic template.
> 5. Context: rolling summary plus last 2 rounds; compress every 4 rounds.
> 6. Contracts: Zod schemas for `GameState`, `PlayerAction`, `TurnResolution`.
> 7. Deliver: runnable repo, smoke test with simulated players, deploy config, and a phased roadmap.

## 3. Architecture

### State machine and concurrency

```
LOBBY ──start──▶ COMMIT ──all locked | timer | disconnects──▶ RESOLVING ──▶ COMMIT …
                                                                   └─▶ ENDED ──20s──▶ LOBBY
```

- **Authority:** the server owns all state; clients send intents, never results.
- **Lock-in:** the first valid action per player per round is final (`submit` rejects repeats and stale `round` numbers).
- **Race safety:** resolution is one synchronous function guarded by `phase`. If the timer and the last lock-in fire together, the second call sees `RESOLVING` and exits.
- **Deadlock prevention:** `maybeResolve` waits only on connected, living players who have not acted. A player who disconnects mid-round stops blocking immediately; anyone without an action when the timer fires gets an automatic Defend event (`timeout`).
- **Reconnect:** the client stores a `playerId` per room; joining with it restores the seat.
- **Scale-out:** the `RoomManager` is in-process. For multiple instances, use sticky sessions plus the Socket.IO Redis adapter and move `Room` into Redis with a per-room lock (`SET room:lock NX PX`).

### Hybrid rules engine

`src/rules.ts` is the only code that calls the PRNG. It computes initiative, d20 + bonus vs. AC (+4 while defending), crits (nat 20 doubles dice), fumbles (nat 1), damage, healing, defeat, retargeting when a target already fell, and victory/defeat. Every event carries a deterministic `text` line, so the combat log never depends on the LLM.

### Data contracts (`src/schemas.ts`)

- `PlayerAction`: `{roomCode, round, type, targetId?, abilityId?, flavorText?}` (client → server, Zod-validated).
- `TurnResolution`: `{round, events[], outcome}` with each event holding d20, modifier, total, AC, hit/crit/fumble, damage/healing, HP after, defeated.
- `GameState` (`RoomManager.publicState`): code, phase, host, round, ms left, scene, members with lock status, initiative-ordered entities. No seed or hidden data is sent.
- `NarrationOut`: `{narration}` (LLM → server).

### LLM Dungeon Master

- **Separation:** the model sees only the already-resolved events and returns prose.
- **Agency protection (enforced, not just requested):** `validateNarration` rejects output that contains numbers not present in the input, talks about rolling, asks players what they do, or attributes speech, thoughts, feelings or decisions to a player character. Reject → one retry → template fallback.
- **Prompt injection:** player flavor text, summaries and history are passed as labeled untrusted data, and the system prompt says to ignore instructions inside them.
- **Context budget:** each call carries scene, party/enemy HP, this round's events, a ≤900-character rolling summary, and the last 2 rounds. Every 4 rounds older rounds are compressed into the summary.
- **Latency/cost:** narration is async and never blocks the next round; 12 s timeout; small fast model by default (`NARRATOR_MODEL`).

### How the narrator is "trained" (without fine-tuning)

Fine-tuning a hosted model is not part of this repo. Instead the narrator is trained in-context and measured:

- **Style guide + rules** (`src/dmprompt.ts`): fidelity, agency, security and style rules, plus a "common mistakes" list.
- **Few-shot exemplars:** five curated cases (crit kill, miss + heal, defend/timeout, victory, defeat), including a prompt-injection attempt in player flavor text. They are sent as prior conversation turns and prompt-cached.
- **Scene lore:** per-scene sensory notes keep the voice consistent.
- **Guard** (`src/guard.ts`): rejects invented numbers, dice talk, offered choices, "you", player speech/thoughts/feelings/decisions, invented enemies or loot, premature victory/defeat, and missing defeats.
- **Retry with feedback:** a rejected output is shown back to the model with the exact rule it broke, then retried once; after that the deterministic template is used.
- **Telemetry:** `/healthz` exposes first-try / retry / fallback counts and rejection reasons. Accepted and rejected samples are appended to `data/*.jsonl` (disable with `NARRATOR_LOG=0`); curate them into new exemplars, or use them as a fine-tuning/eval set later.
- **Evals:** `npm test` checks the exemplars against the guard, a 16-case adversarial battery, and the fallback over thousands of simulated rounds. With `ANTHROPIC_API_KEY` set it also measures the live acceptance rate.

### Stack

| Layer | Choice |
|---|---|
| Client | Plain HTML/JS now; Next.js when you add accounts and sheets |
| Realtime | Socket.IO |
| Validation | Zod |
| State | In-memory now; Redis next |
| Persistence | PostgreSQL + Prisma (characters, campaign logs), phase 5 |
| LLM | Direct provider API with JSON output; swap in a router later |

## 4. Roadmap

1. **Local prototype (done in `rules.ts`):** single-player loop against the engine.
2. **Deterministic rules backend (done):** seeded engine, schemas, validation.
3. **Multiplayer lobby + sync (done):** rooms, codes, lock-in, timeouts, reconnect, bot smoke test.
4. **LLM narration (done):** validated narrator, fallback, rolling summary.
5. **Next:** Redis state + adapter, Postgres characters/campaigns, exploration phase with skill checks, spells/items tables, rate limiting per IP, moderation of flavor text, observability.

## 5. Run and deploy

```
npm install
npm test                      # rules simulation + narrator evals (no network needed)
npm start                     # http://localhost:3000
COMMIT_SECONDS=3 npm start    # then in another shell: npm run test:bots (full multiplayer smoke test)
```

Optional: set `ANTHROPIC_API_KEY` for LLM narration. Without it a template narrator is used.

**Player flow:** open the site -> enter name, class and entry code **5467** -> in the hub, create a Public or Private room (you get a random 4-digit code) or join one by code, or pick a public room from the server browser. Invite links look like `https://<host>/1234`; invitees still enter 5467 first.

**Public hosting:** push this folder to GitHub, create a Render "Web Service" from the repo (`render.yaml` and `Dockerfile` are included). Use a single instance: room state is in memory. Free tiers sleep when idle, which also drops in-progress rooms; use a paid instance for always-on play.

**Known limits:** state is in memory (a restart ends all rooms); the entry code is a shared secret, not authentication; flavor text from players is sent to the LLM provider.
