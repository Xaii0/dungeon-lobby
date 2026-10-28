# Dungeon Lobby

A free, cooperative, D&D-style battle game for 1–6 players with an AI Dungeon Master. It runs entirely in the browser: no accounts, no installs, no server to pay for.

**Play:** https://xaii0.github.io/dungeon-lobby/ (entry code **5467**)

## How it works

1. Open the link, pick a name and class, and enter the code **5467**.
2. **Create a room.** You get a random 4-digit room code.
   - **Public** rooms show up in the server browser for anyone.
   - **Private** rooms are hidden; only people you give the code (or the invite link) to can join.
3. Or **join** a room from the server browser, or by typing its code.
4. The room's creator presses **Start battle**. Each round, everyone picks an action at the same time (Attack, Firebolt, Heal, Defend). When all have locked in, or after 45 seconds, the round resolves in initiative order. Win and the next fight goes one level deeper.

## Architecture

- **Static site** (`docs/`) hosted on GitHub Pages.
- **Rooms run in the creator's browser.** That tab is the authoritative server: it rolls all dice, keeps the state machine, and validates every action. Players only send intents.
- **Networking** goes through a free public MQTT relay over secure WebSockets (retained messages for room state and the server browser; a last-will message closes the room if the host disconnects).
- **Rules engine** (`docs/engine.js`): deterministic, seeded; the only place numbers change.
- **AI Dungeon Master** (`docs/narrator.js`): narrates only what the engine decided. A style guide, few-shot examples (including a prompt-injection case), and a rules checker reject invented numbers, dice talk, dialogue or thoughts for player characters, invented enemies or loot, premature victory, and missed defeats. Rejected or slow AI output falls back to a built-in narrator. The host picks the narrator: free keyless AI (default), Claude with their own API key, or built-in only.

## Known limits

- If the room's creator closes their tab, the room ends (players get a 60-second grace period if the host just lost signal).
- The relay is public: the entry code is a door, not a password, and names and flavor text are not private.
- The free AI service is best effort; when it's busy, the built-in narrator takes over.

## Tests

```
node tests/engine.test.mjs   # rules invariants over 2,000 fights, difficulty curve, narration guard
node tests/host.test.mjs     # multiplayer protocol on an in-memory MQTT-like broker
python3 -m http.server 8765 -d docs & node tests/ui.test.cjs   # multi-tab browser play-through (Playwright)
```

`server/` holds the earlier Node.js server version (Socket.IO + Express), kept for reference.
