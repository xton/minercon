# Minercon documentation

These docs are all technical — there's no separate end-user manual here (user
setup lives in the top-level [README](../README.md)). They fall into three
groups:

## Current reference

Kept in sync with the code; start here.

- [ARCHITECTURE.md](ARCHITECTURE.md) — a tour of `src/`: what each module owns
  and how the layers (RCON → command knowledge → completion engine → terminal
  UI → orchestration → host adapters) fit together. The map to read first.
- [UML.md](UML.md) — the same structure as diagrams: per-layer class diagrams,
  the `Parameter` and engine-`Machine` data models, plus sequence and
  state-machine diagrams for the key runtime flows.
- [TECHNICAL.md](TECHNICAL.md) — the RCON wire protocol: packet framing, the
  deferred "fence packet" technique for reassembling fragmented responses, and
  the record/replay test harness.
- [NO_PLUGIN_HELP_CRAWL.md](NO_PLUGIN_HELP_CRAWL.md) — how local mode rebuilds a
  command tree by crawling `/help` when no TabComplete plugin is installed,
  including the empirically-probed `/help` vs. `minecraft:help` differences
  across vanilla, Fabric, and Paper/Spigot.

## Design / working notes

A spec under active discussion rather than a finished reference.

- [ARGUMENT_HINT_UX_STORIES.md](ARGUMENT_HINT_UX_STORIES.md) — story-by-story
  spec for when the argument-hint display appears, updates, and disappears.
  Some stories are settled and tested; a few remain open questions.

## Historical writeups

Snapshots of earlier fixes, grouped under [`historical/`](historical/). They
describe code shapes that have since been refactored away and are kept for
context only — each carries a banner pointing back to
[ARCHITECTURE.md](ARCHITECTURE.md) for the current shape.

- [historical/RENDERING_FIX.md](historical/RENDERING_FIX.md) — terminal-rendering
  fixes for the suggestion display after large command output.
- [historical/HYPHEN_FIX.md](historical/HYPHEN_FIX.md) — parsing parameters for
  hyphenated command names out of `/help` output.
- [historical/AUTOCOMPLETE_UPDATES.md](historical/AUTOCOMPLETE_UPDATES.md) —
  autocomplete changes that came with the custom RCON protocol implementation.
