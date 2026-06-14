# No-plugin command-tree crawl: `/help` vs `/minecraft:help` inconsistency

## Background

When no tab-complete plugin/mod is installed (`vanilla`, `paper`, `spigot`,
`fabric` in `src/test/functional/variants.ts`'s `nonPluginVariants`),
`LocalCommandTree` (`src/localCommandTree.ts`) builds its command tree
purely from RCON `/help` text:

1. `fetchRootCommands()` gets the list of root command names.
2. `loadCommandDetails()` / `loadSubcommandDetails()` recursively fetch
   `help <path>` for each command/subcommand to learn its argument syntax.

This is §3 of `TODO.md`'s checklist ("Strategy pattern for local-vs-plugin
parsing") — the only remaining open item. This document records what was
empirically probed against live 1.21.4 servers (Paper, Vanilla, Fabric — all
itzg/minecraft-server, no plugins/mods installed) and the plan for fixing it.

## Empirical findings

### Vanilla & Fabric (pure Brigadier, no Bukkit layer)

Fabric's responses were byte-identical to Vanilla's in every probe below —
Fabric's `/help` is the same vanilla Brigadier implementation.

| Command | Result |
|---|---|
| `help` | **One-shot**, full Brigadier `<args>` syntax for *every* command, flat string (3392 bytes), no "Help: Index" header, no pagination |
| `help 1` | `Unknown command or insufficient permissions` — no page-number support at all |
| `minecraft:help` (any form, with or without args) | `Unknown or incomplete command, see below for errorminecraft:help<--[HERE]` — the `minecraft:` namespace prefix **isn't registered**; this is a Brigadier syntax error, not a help response |
| `help gamemode` | `/gamemode <gamemode> [<target>]` — full detail, directly |
| `help team list` | `/team list [<team>]` — full detail at **any depth** |

**Conclusion**: on vanilla/fabric, plain `/help` (no args) already returns a
complete, accurate, one-shot command list with full argument syntax for
*everything*, and `/help <path>` gives accurate detail at any depth. There is
no inconsistency to resolve here — the only bug is that **today's
`fetchRootCommands()` doesn't use this data** (see "Current bugs" below).

### Paper (Bukkit-based; Spigot shares the same `CraftServer`/`SimpleHelpMap`
lineage so the same shape applies, though not independently re-verified this
round — BuildTools-based Spigot debug image failed to start under emulation)

| Command | Result |
|---|---|
| `help` / `help <n>` | Bukkit's paginated HelpMap: `§e--------- §fHelp: Index (n/m) ...`, 21 pages on this Paper build. Each entry is `/<cmd>: <description>`. Vanilla commands get a generic **"A Mojang provided command."** description; Bukkit/Paper-added commands (`version`, `plugins`, `reload`, `tps`, etc.) get a real human description, e.g. "Gets the version of this server including any plugins in use" |
| `minecraft:help` | **One-shot** (no "Help: Index" pagination — `minecraft:help 1`/`2` → `Unknown command or insufficient permissions`), but **8232 bytes** — exceeds one 4096-byte RCON packet, requires multi-packet reassembly (already handled correctly by `RconController`/`RconProtocol`, see `project_rcon_fence_research` memory). Contains, all in one flat string: full Brigadier `<args>` syntax for every vanilla command (both unprefixed `/gamemode ...` and `minecraft:`-prefixed duplicates `/minecraft:gamemode ...`), aliases as `cmd -> target`, **and** every Bukkit-added command with a **generic placeholder**: `/version [<args>]`, `/reload [<args>]`, `/plugins [<args>]`, `/bukkit:help [<args>]`, `/spigot:tps [<args>]`, `/paper:mspt [<args>]`, etc. |
| `help gamemode` (vanilla cmd) | `Description: A Mojang provided command.` / `Usage: gamemode` — **generic, no `<args>`** |
| `minecraft:help gamemode` (vanilla cmd) | `/gamemode <gamemode> [<target>]` — **full detail** |
| `minecraft:help gamerule` / `execute` / `worldborder` | Full multi-variant breakdown in **one** response (gamerule: all 51 rules, 1956 bytes), never paginated |
| `help version` (Bukkit-added cmd) | `Description: Gets the version...` / `Usage: /version [plugin name]` / `Aliases: ver, about` — **full, semantically real usage** |
| `minecraft:help version` (Bukkit-added cmd) | `/version [<args>]` — **generic placeholder** |
| same pattern for `reload` (`Usage: /reload [permissions\|commands\|confirm]` vs `[<args>]`) and `plugins` (`Usage: /plugins` vs `[<args>]`) | |
| `help team list` (subcommand of vanilla cmd) | `No help for team list` — **useless** |
| `minecraft:help team list` | `/team list [<team>]` — **full detail**, confirms the inconsistency applies recursively at every depth |
| `help bukkit:version`, `help icanhasbukkit` (prefixed/aliased names) | `No help for bukkit:version` / `No help for icanhasbukkit` — `/help <name>` only resolves the **canonical unprefixed** name |
| `minecraft:help <unknown-cmd>` | `Unknown command or insufficient permissions` (different from the bare `minecraft:help` namespace error above — this is a normal "no such command" response) |

**Conclusion — the core inconsistency**: for any given command,
`help <path>` and `minecraft:help <path>` are *complementary*:
- **Vanilla/Brigadier-registered commands**: `minecraft:help` has the real
  `<args>` syntax; `help` has only a generic placeholder.
- **Bukkit/Paper-added "legacy Command" commands** (version, plugins, reload,
  tps, mspt, spark, ...): `help` has the real usage string; `minecraft:help`
  has only a generic `[<args>]` placeholder.

Neither source alone is sufficient — both must be queried and merged, **at
every recursion depth**, picking whichever side is non-generic.

## Current bugs this explains

1. **`fetchRootCommands()` (localCommandTree.ts:130-157)** calls
   `sendCommand('minecraft:help')` directly. On vanilla/fabric this returns
   the Brigadier syntax-error string above — non-empty, so the "empty
   response" fallback to `?` is never triggered, but `parseHelpResponse()`
   finds **zero** command-name matches in that error text and falls through
   to `addFallbackCommands()` — **~70 hardcoded command names from an old MC
   version**. This means vanilla/fabric *never* use real server data for the
   root command list, even though plain `/help` would give a complete,
   accurate, one-shot answer. Concretely, on 1.21.4 the hardcoded fallback:
   - is **missing** real modern commands: `me`, `random`, `ride`, `rotate`,
     `return`, `transfer`, `tick`, `perf`, `jfr`, `setidletimeout`,
     `pardon-ip`, `attribute`, `damage`
   - **includes** commands that no longer exist: `testfor`, `testforblock`,
     `testforblocks`, `blockdata`, `entitydata`, `replaceitem`, `stats`,
     `achievement`, `locatebiome`, `publish` — each of these will fail
     `loadCommandDetails`'s `help <cmd>` lookup and sit in the tree as
     phantom entries with empty parameters.

2. **No `minecraft:help` querying in `loadCommandDetails`/
   `loadSubcommandDetails`** — on Paper, vanilla commands (gamemode, gamerule,
   execute, worldborder, team, ...) get only `help <cmd>`'s generic
   "A Mojang provided command." response, so they end up with **zero
   parameters** in the tree. The rich `<args>` detail sitting in
   `minecraft:help <cmd>` is never fetched.

3. **`loadSubcommandDetails` (localCommandTree.ts:378-463)** uses plain
   `sendCommand` instead of `fetchPaginatedCommand` — a latent gap (no
   pagination format was observed for single-command `help`, but it's
   inconsistent with `loadCommandDetails` and cheap to fix).

4. **Bukkit "Usage: ..." lines are never parsed.** The line-matching patterns
   in `loadCommandDetails` (lines 295-299) all require the line to *start*
   with `/` or a bare command name — `Usage: /version [plugin name]` (after
   `stripColors`) matches none of them. So even when `help version` *does*
   have the real usage, today's code silently discards it.

## Design

### 1. Detect `minecraft:` namespace support once, during root fetch

Send `minecraft:help`. If the (stripColors'd) response matches
`/^Unknown or incomplete command/i` (the Brigadier "unknown namespace" syntax
error, distinct from the normal "Unknown command or insufficient permissions"
not-found message), the namespace is **unsupported** (vanilla/fabric).
Otherwise it's **supported** (Paper/Spigot/Bukkit family). Cache this as
`this.supportsMinecraftNamespace: boolean` for the rest of the crawl — no
point re-probing it ~70 times.

### 2. Root command list

- **Namespace unsupported** (vanilla/fabric): `fetchPaginatedCommand('help')`
  → one-shot flat blob, full `<args>` syntax for everything. Replaces the
  ~70-item hardcoded `addFallbackCommands()` fallback for these variants
  entirely (fallback remains as a last-resort if even plain `help` errors).
- **Namespace supported** (paper/spigot): `minecraft:help` (already one-shot,
  multi-packet-safe) → flat blob with full `<args>` syntax for vanilla
  commands plus generic placeholders for Bukkit-added commands.

Either way, `parseHelpResponse` extracts root command *names* as today. The
per-command `<args>` syntax embedded in this blob is **not** consumed at this
stage — `loadCommandDetails` re-fetches `minecraft:help <cmd>` /
`help <cmd>` per command anyway (simpler, and needed regardless for
subcommand-level recursion).

### 3. Per-command/subcommand detail — merge both sources

For each path (root command or `parent...child` subcommand path), at every
recursion depth:

1. Always: `helpLines = fetchPaginatedCommand('help ${path}')`. If this is a
   Bukkit-style response (`Description:`/`Usage:` labels present), extract
   the `Usage: ...` line(s) and normalize each into a `${path} ...`-shaped
   line (strip the `Usage: ` label and any leading `/`) so it flows through
   the existing per-line tokenize/classify loop unchanged.
2. If `supportsMinecraftNamespace`: also `mcLines =
   fetchPaginatedCommand('minecraft:help ${path}')` (empirically never
   paginates, but routed through `fetchPaginatedCommand` for uniformity/
   safety). Each line already has the shape `/${path} ...` and matches the
   existing patterns directly.
3. Feed `[...mcLines, ...normalizedHelpUsageLines]` through the existing
   per-line classify/build loop, in that order. Because the loop's "direct
   parameters" handling always **overwrites** (`parameters.length = 0;
   parameters.push(...)`), a later non-generic Usage line correctly wins over
   an earlier generic `minecraft:help` `[<args>]` placeholder for Bukkit-added
   commands, while for vanilla commands `minecraft:help`'s real `<args>` line
   is set first and the generic vanilla `Usage: <bare-name>` line that follows
   contributes nothing (`afterCommand` is empty → ignored).
4. Post-process: if the final `parameters` is exactly the generic
   single-argument placeholder (`[<args>]` → one optional `ARGUMENT` named
   literally `args`), clear it to `[]` — this represents "no further
   arguments" (e.g. bare `/plugins`) rather than a misleading `<args>` token.

Apply the same merge in `loadSubcommandDetails` (e.g. `minecraft:help team
list` → `/team list [<team>]` where `help team list` → `No help for team
list`).

### New pure helpers

`helpTextParsing.ts`:
- `isGenericArgsPlaceholder(parameters: Parameter[]): boolean` — true iff
  exactly one parameter, `ARGUMENT`, optional, `name === 'args'`.
- `isUnsupportedNamespaceError(response: string): boolean` — true iff
  (stripColors'd) response matches `/^Unknown or incomplete command/i`.

`bukkitHelpParsing.ts`:
- `extractBukkitUsageLines(helpText: string, commandPath: string): string[]`
  — given `stripColors`'d `help <path>` output, find the `Usage:` section and
  return each usage line with the label stripped and re-prefixed so it reads
  as `${commandPath} ...` (ready for the existing tokenizer). Returns `[]` for
  vanilla's generic `Description: A Mojang provided command. / Usage:
  <bare-name>` (no args after the bare name) and for `No help for ...`
  responses.
- `extractBukkitAliases(helpText: string): string[]` — extracts alias names
  from the `Aliases: a, b, c` line.

## Test plan

### Unit tests (new `src/test/localCommandTree.test.ts`, plus additions to
`helpTextParsing.test.ts` and `bukkitHelpParsing.test.ts`)

`LocalCommandTree` takes `sendCommand: (command: string) => Promise<string>`
as a constructor argument — perfect seam for a fake keyed by exact command
string, replaying the **real captured responses** above (verbatim, including
`§`-color codes) for two fake servers:

- **paper-like**: `minecraft:help` → real 8KB-ish blob (trimmed to the
  relevant commands: `gamemode`, `gamerule`, `team`, `version`, `reload`,
  `plugins`); `help <cmd>` → real per-command Bukkit responses captured above.
- **vanilla-like**: `minecraft:help` → the namespace-error string;
  `help` (root) → the flat one-shot blob; `help <cmd>` → real per-command
  responses (`/gamemode <gamemode> [<target>]`, `/team list [<team>]`, etc.)

Cases:
- namespace detection sets `supportsMinecraftNamespace` correctly for each
  fake server
- root command list: paper-like comes from `minecraft:help`; vanilla-like
  comes from `help` (not the hardcoded fallback) — assert `me`/`random`/
  `transfer` present and `testfor`/`achievement` absent
- `gamemode` ends up with `<gamemode>` (required ARGUMENT) + `[<target>]`
  (optional ARGUMENT) on **both** fake servers
- `gamerule` ends up with all 51 rule variants (paper-like, from
  `minecraft:help gamerule`)
- `version` (paper-like only) ends up with a parameter derived from
  `[plugin name]`, not the generic `args` placeholder
- `team` → `list` subcommand ends up with `[<team>]` (paper-like, where
  `help team list` is useless but `minecraft:help team list` works)

`helpTextParsing.test.ts` additions: `isGenericArgsPlaceholder`,
`isUnsupportedNamespaceError`. `bukkitHelpParsing.test.ts`:
`extractBukkitUsageLines` (generic vanilla → `[]`, `version`/`reload`/
`plugins` Usage lines → normalized lines, `No help for X` → `[]`) and
`extractBukkitAliases`.

### Functional tests (`src/test/functional/`, all four `nonPluginVariants`)

Extend `localMode.test.ts` (or a new sibling file) — after a real
`LocalCommandTree.initialize()` against a live container:

- `gamemode`'s parameters include a required `<gamemode>` argument and an
  optional `<target>` argument (proves the merge works against a real server,
  not just fixtures)
- `team`'s `list` subcommand/variant has a `[<team>]` parameter
- `gamerule` has on the order of 50 variants, each with a `[<value>]`
  parameter
- vanilla/fabric only: root command set includes `me`, `random`, `transfer`
  and excludes `testfor`, `achievement` (proves real `/help` is used, not the
  stale hardcoded fallback)
- paper/spigot only: `version` and `reload` end up with non-generic
  parameters (not the bare `args` placeholder)

## Out of scope / deferred

- Capturing the per-command `<args>` syntax already present in the root
  `minecraft:help` blob to avoid the subsequent per-command `minecraft:help
  <cmd>` round trip — a possible future optimization, not needed for
  correctness.
- Independently re-verifying Spigot (BuildTools-based debug image failed to
  boot under Rosetta this round: "Unsupported Java detected (69.0)"). Spigot
  shares Paper's `CraftServer`/`SimpleHelpMap` lineage, so the Paper-derived
  strategy is expected to apply unchanged; the functional test suite already
  covers the `[spigot]` variant and will surface any divergence.
