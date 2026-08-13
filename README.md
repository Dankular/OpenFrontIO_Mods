# OpenFrontIO Mods

A personal collection of mods, browser extensions, and scripts for
[OpenFront.io](https://openfront.io/), the real-time territorial strategy
game ([source](https://github.com/openfrontio/OpenFrontIO)).

This is an **unofficial, third-party** collection. It isn't affiliated with
or endorsed by the OpenFront project. Everything here works by observing the
game client at runtime in your own browser — nothing here modifies the
server or automates play (clicks, builds, attacks — all still on you).
Some mods surface information that isn't otherwise on screen (e.g.
predicted bot behavior); where that's the case, its README says so
explicitly and is upfront about how reliable it actually is. Things may
break whenever the upstream client changes; see each mod's README for how
it hooks in and what to check first.

## Mods

| Mod | Type | Description |
| --- | --- | --- |
| [`extensions/spawn-highlighter`](extensions/spawn-highlighter) | Browser extension | Animated highlights over Nation and Tribe territories while you're picking a spawn point. |
| [`extensions/attack-radar`](extensions/attack-radar) | Browser extension | Predicts when Nation/Tribe bots will next decide whether to attack, and guesses their likely target. |

More to come — see [Ideas](#ideas) below.

## Repo layout

```
extensions/   Browser extensions (load unpacked in Chrome/Edge/Brave)
scripts/      One-off dev tooling shared across mods (e.g. icon generation)
```

Each mod is self-contained under its own directory with its own README.
There's no shared build system on purpose — most of these are small enough
to stay dependency-free.

## Ideas

Rough backlog for future mods in this collection:

- Territory/army strength overlay (compare your stats to neighbors at a glance)
- Alliance web visualizer (who's allied with whom, at a glance)
- Nuke/MIRV incoming-threat radar
- Replay analysis / stats export tooling
- Real border-adjacency lookup (via `PlayerView#borderTiles()`) to sharpen
  `attack-radar`'s target guessing beyond the current proximity heuristic

Opening an issue with a mod idea (or a PR) is welcome.

## Disclaimer

Use at your own risk. These are unofficial community tools built by reading
the OpenFront client's own runtime objects (the same ones its UI uses) —
they don't patch, redistribute, or bundle any of OpenFront's code or
assets. OpenFront's source is AGPLv3-licensed and its assets are
CC BY-SA 4.0; nothing in this repo includes copies of either. See
[openfrontio/OpenFrontIO](https://github.com/openfrontio/OpenFrontIO) for
the game itself.
