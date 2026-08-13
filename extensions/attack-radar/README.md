# OpenFront Attack Radar

A browser extension for [OpenFront.io](https://openfront.io/) that predicts
**when** each Nation/Tribe bot will next decide whether to attack, and takes
a best-effort guess at **who**. Shows up as:

- A small **"next decisions" panel** (bottom-right) listing the soonest
  bots to act, with a countdown and their likely target.
- An **amber cooldown ring** around a bot on the map as its decision tick
  approaches (fills clockwise, like an ability cooldown).
- A **red danger ring + dashed line** from the bot to its predicted victim,
  once a target's been guessed.

Press **Alt+P** to toggle it off/on for the session. Only active outside
the spawn phase (bots don't attack during it).

## Important: read this before trusting it

**The "when" is exact. The "who" is a heuristic guess.** These are not
the same kind of claim, and the extension (and this README) tries to keep
them visually and textually distinct — do not read a highlighted "likely
target" as a spoiler; it's informed guesswork, wrong plenty of the time.

### Why "when" can be exact

OpenFront's bot AI only re-evaluates whether to attack on ticks where
`ticks % attackRate === attackTick`
(`src/core/execution/TribeExecution.ts`, `NationExecution.ts` upstream).
Both numbers are drawn once, deterministically, from a PRNG seeded purely
from the bot's player ID (Nations also mix in the game ID and configured
difficulty) — nothing about them depends on how the match actually plays
out. This extension reimplements that PRNG
(`core/PseudoRandom.ts`'s sfc32 generator, seeded via `core/Util.ts`'s
`simpleHash`) from scratch — same well-known, fully-specified algorithm,
independently written, not copied from OpenFront's source — and verified
bit-for-bit against it. Feed it a bot's public `.id()` and you get back the
exact `attackRate`/`attackTick` the real simulation is using, so the
countdown is deterministic, not a guess.

### Why "who" can't be

Target selection runs through a long, heavily randomized decision tree
(`AiAttackBehavior.ts`) with dozens of `random.chance(N)` gates, and it
depends on **real border-tile adjacency** — the client doesn't expose a
synchronous "who does this bot actually border" accessor (`PlayerView` has
no `nearby()`/`borderTiles()`; the one async accessor that exists
round-trips to a worker, and calling it for every bot every second isn't
something this extension wants to risk doing to your game's performance).

So the target guess:

- **Uses real signals where they exist:** if a bot currently has an
  incoming attack, it'll very plausibly retaliate against the biggest
  attacker (`red`, "likely") — this mirrors the AI's actual retaliation
  check and uses real attack data.
  Disconnected/AFK and traitor-flagged neighbors are also real, exact
  signals (`orange`, "possible").
- **Falls back to a proximity heuristic** otherwise: nearby territories
  (by name-label distance — a rough stand-in for actual border adjacency,
  see caveat below) ranked by lowest troop count (`yellow`, "guess").
- **Tribes are more approximate than Nations.** Tribes can attack a
  bordering traitor or expand into adjacent unclaimed land *without* any
  troop-reserve check at all — paths this extension can't model without
  real border data. A tribe showing a "saving troops" / dim ring isn't a
  guarantee it won't act.

Bottom line: treat the panel as "here's where I'd look if I were worried,"
not as ground truth.

## Install (unpacked / developer mode)

1. Clone or download this repo.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode**.
4. **Load unpacked** → select `extensions/attack-radar`.
5. Join a game past the spawn phase.

Firefox needs 128+ for MV3 `"world": "MAIN"` content scripts; load via
`about:debugging` → **This Firefox** → **Load Temporary Add-on**.

Works alongside [`spawn-highlighter`](../spawn-highlighter) in this
collection — they're independent extensions, install either or both.

## How it works

Same technique as `spawn-highlighter`: a `"world": "MAIN"` content script
reads the live `GameView`/`TransformHandler` instances the game's own
`GameRenderer.ts` stashes on `<player-info-overlay>`. See that extension's
README for the full writeup of the hook and why it can go silent on an
upstream refactor.

On top of that, every ~350ms this extension:

1. Walks `game.players()`, keeps `NATION`/`BOT` types that are alive.
2. Derives each one's `attackRate`/`attackTick`/`triggerRatio`/
   `reserveRatio`/`expandRatio` from its `.id()` (cached — these never
   change for a given bot in a given match) and computes ticks until its
   next decision from `game.ticks()`.
3. Takes the 6 soonest and, for any within ~3s, runs the target-guessing
   heuristic above and checks troop readiness via
   `game.config().maxTroops(pv)` vs. `pv.troops()`.

The map overlay and panel then redraw every animation frame from that
cached board — cheap, since the expensive part (the walk + guess) is
throttled separately from the render loop.

## Known limitations / ideas for improvement

- No real border-adjacency check (see above) — the biggest accuracy gap.
  `PlayerView#borderTiles()` exists and would fix this, but it's async and
  round-trips to a worker; doing that for every candidate bot every cycle
  needs real throttling/caching work this version doesn't attempt.
- Doesn't model the various no-troop-check attack paths (terra nullius
  expansion, harassment boats, bots-with-structures raiding) — these can
  fire regardless of the reserve/trigger readiness shown here.
- `nameLocation().size` (font size) is used as a rough territory-footprint
  proxy for the proximity fallback; it's calibrated for name-label
  legibility, not geography, so treat "nearby" loosely.

## License

MIT for the code in this folder. Not affiliated with OpenFront/WarFront.
See the [collection README](../../README.md) for the broader disclaimer.
