# OpenFront Spawn Highlighter

A browser extension that animates highlights over **Nation** and **Tribe**
territories while you're picking a spawn point in
[OpenFront.io](https://openfront.io/) — so the pre-placed AI territories
are easy to spot at a glance instead of blending into the terrain colors.

- 🟡 **Gold** rings/glow = Nation territories
- 🔵 **Cyan** rings/glow = Tribe territories (what the game calls "bots")

Highlights fade in when the spawn-point picker is active and fade out once
you've spawned, so they never get in the way during actual play. Press
**Alt+H** at any time to toggle them off/on for the session.

## Install (unpacked / developer mode)

1. Clone or download this repo.
2. Open `chrome://extensions` (or the equivalent in Edge/Brave —
   `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the
   `extensions/spawn-highlighter` folder.
5. Open [openfront.io](https://openfront.io/) and start/join a game.

No build step, no dependencies — it's plain JS loaded straight from this
folder. Reload the extension (⟳ button on `chrome://extensions`) after
pulling updates.

Firefox: Manifest V3 `"world": "MAIN"` content scripts require Firefox
128+. Load via `about:debugging` → **This Firefox** → **Load Temporary
Add-on** → pick `manifest.json`. Not regularly tested there — file an issue
if something's off.

## How it works

OpenFront's client doesn't expose a global debug API for other scripts to
hook into. Instead, this extension's content script runs in the **page's
own JS world** (`"world": "MAIN"` in `manifest.json`) so it can read the
same live objects the game's own UI already uses — nothing here touches
the network layer, the game worker, or mutates any state.

Specifically, `createRenderer()` in the game's client
(`src/client/hud/GameRenderer.ts`) sets two properties directly on the
`<player-info-overlay>` custom element once a match starts rendering:

```js
playerInfo.transform = transformHandler; // camera pan/zoom + coordinate math
playerInfo.game = game;                  // GameView — the client's read model of the match
```

`content.js` polls for that element, then each animation frame:

1. Checks `game.inSpawnPhase()` to decide whether to be visible at all.
2. Walks `game.playerViews()`, keeping players whose `.type()` is `NATION`
   or `BOT` (in this codebase, "tribes" *are* the `BOT` player type — see
   `TribeSpawner`/`GameRunner` upstream) and who are still `.isAlive()`.
3. Reads each one's `.nameLocation()` (world-space `{x, y, size}`, the same
   data the game uses to place player name labels) and runs it through
   `transform.worldToScreenCoordinates()` to get a screen position.
4. Draws animated rings/glow at that position on a transparent full-screen
   `<canvas>` overlaid above the game (`pointer-events: none`, so your
   clicks still reach the map).

### Why this can break

This is coupled to two specific, undocumented internals:

- `<player-info-overlay>` carrying `.transform`/`.game` — if
  `GameRenderer.ts` stops wiring those up (or renames them), the extension
  goes silent (no highlights, no errors — `findAnchor()` just never
  resolves).
- The shape of `PlayerView`/`GameView`/`TransformHandler`'s public methods
  (`inSpawnPhase`, `playerViews`, `type`, `isAlive`, `nameLocation`,
  `worldToScreenCoordinates`, `.scale`) — if these are renamed or their
  return shapes change, the extension may throw inside its `try`/`catch`
  guards and silently stop drawing.

If highlights stop appearing after an OpenFront update, diff those two
files against what's described above first.

## Settings

There's no options page yet — it's a fixed set of defaults for now:

| Thing | Value |
| --- | --- |
| Toggle overlay on/off | `Alt+H` |
| Nation color | gold `rgb(255, 201, 74)` |
| Tribe color | cyan `rgb(72, 229, 255)` |
| Pulse period | ~2.2s |

## License

MIT for the code in this folder. Not affiliated with OpenFront/WarFront.
See the [collection README](../../README.md) for the broader disclaimer.
