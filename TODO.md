# Code Quality Checklist

Tracking the work items from the project's "Code Quality Report" code review.
Update checkboxes as items are completed; add a short note on how/where for
anything non-obvious.

## 1. Code smells
- [x] `handleInput` 450-line if-chain → replaced with `Map`-based `buildKeyHandlers()` lookup table (rconTerminal.ts)
- [x] Duplicate prompt-rendering (`showPrompt` vs. `redrawLineWithSelection`) → unified via `LineEditorHost.promptText()`
- [x] Near-duplicate clear-area methods (`clearSuggestionDisplay`/`clearArgumentDisplay`) → merged into single `SuggestionDisplay.clear()`
- [x] Debug-grade logging in `commandAutocomplete.ts` — removed scratch-debug content: the full-text `everything:\n${modified}` dump, the hyphenated-command debug block, the confused `"...or is it ${altCommandCount}?"` phrasing, and the per-iteration `"  Checking: ... vs ..."`/`"  Tokens: ..."`/`"    Added parameter: ..."` traces in `loadCommandDetails`. Kept and tidied the legitimate operational diagnostics (response-byte-count log, the "no commands found" fallback dump), collapsed the root-command summary to a single `Found ${this.rootCommands.size} root commands` line, and replaced the verbose final-parameters JSON dump with one concise `Loaded ${parameters.length} parameter(s) for ${commandPath}` summary
- [x] `any` typing — added a pure `errorMessage(err: unknown): string` helper to `logger.ts` (an `Error`'s `.message`, otherwise `String(err)`) and used it to convert every `catch (err: any) { ...err.message... }` to `catch (err)`, simultaneously removing the `any` and ~6 scattered near-duplicate `String(err.message ?? err)`/`(err.message || err)` call sites: `rconClient.ts`, `extension.ts` (x3 — including a bonus `'pty' in terminal.creationOptions` type-guard replacing `(terminal.creationOptions as any).pty`), `rconTerminal.ts`, and `connectionManager.ts:155` (an identical `catch (err: any)` introduced by the post-TODO `RconTerminal`/`ConnectionManager` split, not originally counted but fixed for consistency)
- [x] Long methods `loadCommandDetails`/`loadSubcommandDetails` in `commandAutocomplete.ts` — the two genuinely-identical chunks (token classification → variant-or-direct-parameters, and building a SUBCOMMAND/CHOICE_LIST structure from collected variants) were extracted as pure functions `classifyParameterTokens`/`buildParameterStructureFromVariants` in `helpTextParsing.ts` (with unit tests), leaving only the genuinely-different orchestration (path-building, fetch strategy, line-matching regexes, recursion) in place — exactly the parts that need a live server to validate, untouched. `loadCommandDetails` 213 → ~130 lines, `loadSubcommandDetails` 270 → ~88 lines (100 passing)

## 2. Mega-modules worth splitting
- [x] `rconTerminal.ts` split (1,597 → 646 lines): extracted `LineEditor`, `SuggestionDisplay`, `ConnectionManager` per `dapper-purring-zebra` plan
- [x] `commandAutocomplete.ts` split (1,227 → 679 lines): extracted `helpTextParsing.ts` (pure grammar parsing — `formatMinecraftColors`/`stripColors`/`tokenizeParameterString`/`parseParameter`/`parseCommandHelp` + `ParameterType`/`Parameter` types), `commandTreeCache.ts` (`CommandTreeCache` class — on-disk cache persistence, versioning, age checks), `commandSuggestions.ts` (pure `getSuggestions` + helpers operating on the built tree). `CommandAutocomplete` is now just the RCON-crawling orchestration core plus thin delegations. Bonus: the "Parsing (typed)" tests now call the pure functions directly — no more `as unknown as Internals` casts on a stub-constructed instance

## 3. Design patterns
- [x] Command/lookup-table pattern for key dispatch (came along with the rconTerminal split)
- [x] Strategy pattern for local-vs-plugin parsing in `commandAutocomplete.ts` — landed as a **merge strategy** rather than a class hierarchy: `fetchRootCommands()` detects `supportsMinecraftNamespace` once (vanilla/fabric reject the `minecraft:` prefix; paper/spigot accept it), then `loadCommandDetails`/`loadSubcommandDetails` always fetch both `help <path>` and (when supported) `minecraft:help <path>` and hand them to a new `mergeHelpSources()`, which picks whichever side has real `<args>` syntax (vanilla's `minecraft:help` vs. Bukkit's `help`/Usage-line for added commands) at every recursion depth. See `docs/technical/NO_PLUGIN_HELP_CRAWL.md` for the full empirical writeup
- [x] Extract a "terminal renderer" collaborator → `SuggestionDisplay` (pure content builders + `renderSuggestionArea`)

## 4. Dead code
- [x] `src/test/rconProtocolTest.ts` — deleted now that a real recorded fixture (xton.ts) covers the same ground via the replay suite
- [x] `currentArgumentHelp` write-only field — deleted
- [x] `terminalBufferHeight` unused field — deleted
- [x] `clearArgumentDisplay()` dead method — deleted (folded into `clear()`)

## 5. Test coverage
- [x] `completionEngine.ts` `applySuggestion` — extracted as pure fn + 7 new unit tests (61 → 68 passing)
- [x] `helpTextParsing.ts`/`commandTreeCache.ts`/`commandSuggestions.ts` — each of the three modules extracted in §2's `commandAutocomplete.ts` split now has its own 1:1 test file (`commandAutocomplete.test.ts` renamed to `helpTextParsing.test.ts`; `commandSuggestions.test.ts` and `commandTreeCache.test.ts` are new — the latter introduces a `mkdtemp`-backed `vscode.ExtensionContext` stub, the first filesystem-IO test in the suite). Plus `classifyParameterTokens`/`buildParameterStructureFromVariants` (newly extracted from §1's long-methods de-dup) get their own unit tests too. 71 → 100 passing
- [x] `lineEditor.ts` pure logic — `LineEditor` is stateful but already had a clean test seam (`LineEditorHost`); added `lineEditor.test.ts` with a `FakeHost` stub and 39 tests across editing, cursor movement, selection math, kill operations, `transposeChars`, history navigation (dedup, 100-entry cap, temp-line save/restore), and whole-line ops, asserting on observable state (`line`/`cursor`/`hasSelection`/`getSelectedText`). 100 → 139 passing
- [x] `rconTerminal.ts` — added `rconTerminal.test.ts` (12 tests, 147 → 159 passing). The trick that makes it tractable (unlike `extension.ts`): driving the terminal into *plugin mode* (a `FakeController` that answers the `tabcomplete` probe with the magic phrase) sidesteps the entire command-tree-crawling startup path, leaving a small, fast, fully-isolated surface to drive end-to-end through `handleInput`/`open`/`close` and observe via `onDidWrite` — exactly like `lineEditor.test.ts` drives `LineEditor` through a `FakeHost`. Covers: welcome-banner/plugin-detection on `open`, regular-character assembly + Enter → RCON send + response rendering (incl. "(no response)"), Escape/Ctrl+C line-clearing (and that cleared text is never sent), Ctrl+L screen-redraw, Tab → `dispatchToEngine`/`executeEngineEffect` → live `tabcomplete <query>` fetch through the active backend, the `/help`/`/clear`/`/disconnect` built-in-command router (and that built-ins never reach the server as RCON commands — only the engine's live-as-you-type "tabcomplete -" fetches do), the "not connected" guard in `executeCommand`, and `close()` → `ConnectionManager.dispose()` → controller teardown. Deliberately never exercises the "connection lost → auto-reconnect" path: `ConnectionManager.attemptReconnect` constructs a real `RconController` directly (no injection seam), which would attempt a live socket connection from the test
- [x] `rconProtocol.ts`/`rconClient.ts` — `rconProtocol.ts`'s framing/fragmentation/auth turned out to already be covered byte-exact by §6's record/replay harness; the real gap was `RconController` (rconClient.ts), which had zero coverage and no injection seam. Added a `createProtocol` factory (mirroring `RconProtocol`'s own `createSocket` pattern — same "only production change, default behavior unchanged" shape) and `rconClient.test.ts` with a `FakeProtocol` stub: 8 tests covering queue serialization (a second `send` provably waits for the first, not just schedules later), error containment (a rejected send doesn't wedge the queue), `Not connected` guards, and `error`/`close` event wiring. 139 → 147 passing
- [x] `extension.test.ts` — replaced the meaningless scaffold "Sample test" (`assert.strictEqual(-1, [1,2,3].indexOf(5))`) with a minimal smoke test that the module loads under the real vscode host and exports `activate`/`deactivate`. Deep-mocking the vscode API to test `activate`/`createRconTerminalProfile`/`connectToRcon` was decided against — like §7's readline-library item — because `extension.ts` is ~100% IO/UI orchestration with no pure logic to extract; such tests would mostly assert mock call-order rather than real behavior

## 6. Mocked RCON protocol tests
- [x] Build a fake-socket harness and mock-test `RconProtocol` — done as a **record/replay** harness:
  - `RconProtocol` now takes an injectable `createSocket: () => SocketLike` (rconProtocol.ts) — the only production change, default behavior unchanged
  - `FakeSocket`/`RecordingSocket` (src/test/support/) play back / capture byte-exact wire conversations; `rconWireFormat.ts` has standalone encode helpers for hand-built fixtures
  - `src/test/fixtures/rcon/synthetic.ts` is a hand-built fixture covering auth, short response, fragmented response (incl. cross-`data`-event packet splitting), and unknown-command
  - `src/test/fixtures/rcon/xton.ts` is a **real recorded fixture** captured against a live server — genuinely fragmented `minecraft:help` response spanning multiple packets and `data`-event boundaries, real server error text, etc. Address/password are scrubbed from the checked-in file (the repo is public) — see the file's header comment
  - both fixtures replay byte-exact through `rconProtocol.test.ts` (71 passing, was 68)
  - a hand-authored connection-drop scenario covers the "server hangs up mid-request → pending command rejects, isConnected() goes false" path
- [x] Delete `rconProtocolTest.ts` — done (closed out §4's dead-code item too — net-zero file count)

## 7. `readline`-style REPL library
- [x] **Canceled** — decided against by design: adapter complexity, fights the custom multi-line/selection UI, no equivalent for features already built. No action item.

---
*Last updated: 2026-06-08 — §1 (Code smells) AND §5 (Test coverage) are now
both fully checked off, closing out the last two open threads in the
checklist bar one.

§1's last two items: the `commandAutocomplete.ts` debug-logging cleanup
(scratch dumps/traces removed, legitimate diagnostics kept and tidied) and
the remaining `any` typing (a new `errorMessage(unknown): string` helper in
`logger.ts` retired every `catch (err: any)` across `rconClient.ts`,
`extension.ts`, `rconTerminal.ts`, and `connectionManager.ts`, plus a
`'pty' in ...` type-guard fix in `extension.ts`).

§5's last loose thread — `rconTerminal.ts` had no dedicated test file — is
now closed too: `rconTerminal.test.ts` (12 tests) drives the terminal in
*plugin mode* (sidestepping the command-tree-crawl startup path entirely) end
to end through `handleInput`/`open`/`close`, observing via `onDidWrite`, the
same way `lineEditor.test.ts` drives `LineEditor` through a `FakeHost`. Covers
key dispatch (Escape/Ctrl+C/Ctrl+L/Tab), the `/`-built-in-command router, and
`executeCommand`'s response/error/not-connected handling — deliberately
stopping short of the "connection lost → auto-reconnect" path, since
`ConnectionManager.attemptReconnect` constructs a real `RconController`
directly (no injection seam) and would attempt a live socket connection from
a test.

§2 (mega-module splits), §4 (dead code), §6 (record/replay harness), and the
`rconProtocolTest.ts` dead-code item are also fully done. 147 → 159 tests
passing, `tsc`/`eslint` clean throughout.*

---
*Last updated: 2026-06-10 — §3's last open item, the local-vs-plugin merge
strategy, is now closed too, finishing the checklist.

`mergeHelpSources()` (`commandAutocomplete.ts`) now dispatches explicitly by
shape rather than a try/fallback cascade: `looksLikeBukkitHelpPage()` (a `---`
banner line) routes to `extractBukkitUsageLines()`, which extracts the Usage
line(s) verbatim — required because hand-written Bukkit Usage strings
sometimes contain a literal `/` inside `[...]` (e.g. `[home/away]`), which
must not be corrupted. Everything else (a `minecraft:help` blob, or vanilla's
`help <path>` for multi-variant commands like `gamerule`/`team`) is a flat
Brigadier blob with no separators between `/cmd ...` entries, normalized by
the new shared `splitConcatenatedHelpLines()` helper (extracted from three
duplicated `/`→`\n/` resplit call sites).

Fixed along the way: a runaway-recursion bug where vanilla's concatenated
`help <path>` responses (no `/`-resplit applied) produced malformed variant
names that `loadSubcommandDetails` recursed into forever, eventually killing
the RCON connection. `commandAutocomplete.test.ts`'s vanilla fixtures for
`help`/`help gamerule`/`help team` now use the real concatenated (no
separator) format specifically so this class of bug is caught at the unit
level, not just by live functional tests.

58 unit tests in `commandAutocomplete.test.ts`/`helpTextParsing.test.ts` (250
total), plus all 32 functional tests across vanilla/paper/spigot/fabric, pass.
`tsc`/`eslint` clean. See `docs/technical/NO_PLUGIN_HELP_CRAWL.md` for the full
empirical writeup.*

## 8. Fresh code-review pass (2026-06-10)

A follow-up pass over `src/*.ts` looking for code smells, confusing names, and
rough edges left over from earlier refactors.

- [x] Stale "RconTerminal is the orchestrator/shell" doc comments — `RconTerminal`
  was split into `RconSession` (host-agnostic core) and a thin VS Code adapter,
  but several comments still described `RconTerminal` as the live orchestrator.
  Updated to say `RconSession` in: `connectionManager.ts` (header, and the
  `dispose()` doc comment — "used by `RconSession.close()`"), `completionEngine.ts`,
  `completionsBackend.ts`, `suggestionDisplay.ts`, `logger.ts` (class list), and
  `rconClient.ts` (`RconSession.executeCommand` reference). Left the genuinely
  historical "Pulled out of RconTerminal as part of the mega-module split" notes
  in `connectionManager.ts`/`suggestionDisplay.ts` as-is — those describe history
  accurately
- [x] `commandAliases`/`rawHelp` round-tripped through `CommandTreeCache` but
  `commandAliases.set()` is never called (always empty) and `rawHelp` is never
  read outside the cache round-trip/tests (`commandAutocomplete.ts`) — removed
  `rawHelp` entirely (`Parameter`, `CommandNode`, `SerializedCommandNode`,
  cache serialize/deserialize); replaced the dead `commandAliases` map with
  alias *expansion*: new `parseAliasRedirect`/`extractBukkitAliases` helpers
  (`helpTextParsing.ts`) recognize `<alias> -> <target>` redirect lines (real
  vanilla `minecraft:help` aliases, e.g. `/tp -> teleport`) and Bukkit
  `Aliases: a, b, c` lines, collected into a transient `pendingAliases` map
  during the crawl and, once their targets are fully loaded, expanded directly
  into `rootCommands` (alias name → the same `CommandNode` as its target) —
  no separate alias map to thread through `getSuggestions` or persist.
  `cacheVersion` bumped to `2.2.0` for the schema change
- [x] Duplicated subcommand-recursion blocks in `loadCommandDetails` and
  `loadSubcommandDetails` — both walked a `Parameter[]` looking for
  not-yet-complete `SUBCOMMAND`s (direct, or nested inside `CHOICE_LIST`
  choices) and recursed into `loadSubcommandDetails`; extracted into a shared
  `loadSubcommandsIn(path, parameters)` helper, called from both
  (`commandAutocomplete.ts`)
- [x] Scattered raw ANSI SGR escape codes (`\x1b[NNm`) — extracted to a new
  `src/ansi.ts` module: named constants (`RESET`, `DIM`, `REVERSE`/`REVERSE_OFF`,
  `HIDDEN`, `RED`/`GREEN`/`YELLOW`/`CYAN`/`GRAY`/`BRIGHT_YELLOW`,
  `BOLD_RED`/`BOLD_GREEN`/`BOLD_CYAN`/`BOLD_BRIGHT_WHITE`) plus a `style()` helper
  and per-color wrap functions (`yellow()`, `red()`, `dim()`, ...). Applied across
  every `\x1b[NNm` occurrence in `rconSession.ts`, `suggestionDisplay.ts`,
  `lineEditor.ts`, `connectionManager.ts`, and `cli.ts` (121 occurrences total).
  Deliberately left untouched at the time: `helpTextParsing.ts`'s separate
  Minecraft `§`-color-code-to-ANSI translation table (folded into `ansi.ts` by
  item below), the terminal-input key-binding escape sequences in
  `rconSession.ts`'s `buildKeyHandlers` (e.g.
  `\x1b[A`, `\x1b[1;5C` — these identify *incoming* key presses, not output
  styling), and cursor-movement/erase codes (`\x1b[2K`, `\x1b[K`, `\x1b[NA`,
  `\x1b[NC`, `\x1b[2J\x1b[H`) which are a different category from SGR styling
- [x] `helpTextParsing.ts` mixed the Minecraft `§`-color-code-to-ANSI translation
  table (`formatMinecraftColors`/`stripColors`) with Bukkit/Brigadier help-page
  parsing (`looksLikeBukkitHelpPage`, `extractBukkitUsageLines`,
  `splitConcatenatedHelpLines`, `parseHelpLines`, ...); moved
  `formatMinecraftColors`/`stripColors`/the color-code table into `ansi.ts`
  alongside the SGR constants/helpers from item 5 — `helpTextParsing.ts` now
  imports `stripColors` from `ansi.ts` for its own parsing, and
  `commandAutocomplete.ts`/`rconSession.ts` import the color helpers from
  `ansi.ts` directly. Their unit tests moved to a new `ansi.test.ts`
  (`commandAutocomplete.ts`, `rconSession.ts`, `helpTextParsing.ts`, `ansi.ts`)
- [x] Stale "migration note" comments — removed `// Now includes subcommands as
  parameters` and `// NO MORE subcommands Map!` from `CommandNode`
  (`commandAutocomplete.ts`), and the `// Now includes SUBCOMMAND` /
  `// NEW: ...` comments on `ParameterType`/`Parameter` (`helpTextParsing.ts`)
- [x] Duplicated reconnect-state-reset (`reconnectAttempts = 0; reconnectDelay =
  2000;` plus clearing `reconnectTimeout`) repeated across
  `reportConnectionLost()`, `manualReconnect()`, and both the success and
  max-attempts paths of `attemptReconnect()` — extracted into a private
  `resetReconnectState()` helper, called from all four
  (`connectionManager.ts`)
- [x] Misc smells: the lone `var` in `commandAutocomplete.ts`'s
  `fetchPaginatedCommand` → `let`; the unused `catch (error)` binding in
  `loadSubcommandDetails` → `catch {`; and the 4x-repeated
  `(process.stdin as NodeJS.ReadStream & { setRawMode(mode: boolean): void })`
  cast in `cli.ts` extracted into a single `setRawMode(mode: boolean): void`
  helper (checks `isTTY` internally), used at all 4 call sites
- [x] Dead `dimensions()` plumbing — `RconSession.open`'s `_dimensions`
  parameter was accepted but never used (`rconSession.ts`). Investigated with
  a new xterm-headless test (`suggestionDisplay.screen.test.ts`): when the
  typed line wraps onto a second terminal row, `SuggestionDisplay`'s cursor
  restoration (`\x1b[${col}C` from column 0) used the raw, un-wrapped
  `promptWidth + lineEditor.cursor` as `col`, which a real terminal clamps to
  its rightmost column instead of the cursor's actual (wrapped) column — the
  popup itself was still drawn in the right place and intact. Fixed by
  reducing that value mod `sessionHost.dimensions().columns` (already
  implemented live by both adapters — `process.stdout.columns/rows` for the
  CLI, `setDimensions`-cached `TerminalDimensions` for the VS Code
  `Pseudoterminal`) when known. The now-genuinely-dead `_dimensions` parameter
  on `open()` was removed (`rconSession.ts`, `rconTerminal.ts`, `cli.ts`)

---
*Last updated: 2026-06-10 — §8's items 3, 5, and 7 (renamed here to match this
list's order) are done: stale `RconTerminal`-as-orchestrator comments now say
`RconSession`, stale migration-note comments are gone, and a new `src/ansi.ts`
module replaced all 121 raw `\x1b[NNm` SGR escapes across `rconSession.ts`,
`suggestionDisplay.ts`, `lineEditor.ts`, `connectionManager.ts`, and `cli.ts`
with named constants and color-wrap helpers. `tsc`/`eslint` clean, 263 tests
passing.*

---
*Last updated: 2026-06-10 — §8's item 4 is done: the duplicated
subcommand-recursion blocks in `loadCommandDetails` and `loadSubcommandDetails`
were extracted into a shared `loadSubcommandsIn(path, parameters)` helper in
`commandAutocomplete.ts`. `tsc`/`eslint` clean, 263 tests passing.*

---
*Last updated: 2026-06-10 — §8's item 6 is done: `formatMinecraftColors`,
`stripColors`, and the Minecraft `§`-color-code table moved out of
`helpTextParsing.ts` into `ansi.ts` (alongside item 5's SGR constants/helpers);
`helpTextParsing.ts` now imports `stripColors` from `ansi.ts` for its own
parsing, `commandAutocomplete.ts`/`rconSession.ts` import the color helpers
from `ansi.ts` directly, and their unit tests moved to a new `ansi.test.ts`.
`tsc`/`eslint` clean, 263 tests passing.*

---
*Last updated: 2026-06-10 — §8's item 8 is done: the duplicated
reconnect-state-reset (`reconnectAttempts = 0; reconnectDelay = 2000;` plus
clearing/nulling `reconnectTimeout`) in `reportConnectionLost()`,
`manualReconnect()`, and both branches of `attemptReconnect()` was extracted
into a private `resetReconnectState()` helper in `connectionManager.ts`.
`tsc`/`eslint` clean, 263 tests passing.*

---
*Last updated: 2026-06-10 — §8's item 2 is done: removed the dead `rawHelp`
field everywhere (`Parameter`, `CommandNode`, `SerializedCommandNode`, cache
serialize/deserialize) and replaced the always-empty `commandAliases` map with
in-place alias expansion. New `parseAliasRedirect`/`extractBukkitAliases`
helpers in `helpTextParsing.ts` recognize `<alias> -> <target>` redirect lines
(confirmed present in real `minecraft:help` output, e.g. `/tp -> teleport`)
and Bukkit `Aliases: a, b, c` lines; `commandAutocomplete.ts` collects these
into a transient `pendingAliases` map during the crawl and, once targets are
fully loaded, sets `rootCommands.set(alias, targetNode)` so alias names are
just additional keys sharing the canonical command's node — `getSuggestions`
and the cache format are unchanged. `cacheVersion` bumped to `2.2.0`.
`tsc`/`eslint` clean, 275 tests passing.*

---
*Last updated: 2026-06-10 — §8's dead-`dimensions()`-plumbing item (now `[x]`)
is done: `RconSession`'s `cursorColumn()` now reduces `promptWidth +
lineEditor.cursor` mod `sessionHost.dimensions()?.columns` (falling back to
the raw value when dimensions are unknown), fixing the suggestion popup's
cursor-restoration column when the typed line wraps onto a second terminal
row. Both adapters already supplied `dimensions()` live (CLI:
`process.stdout.columns/rows`; VS Code: `setDimensions`-cached
`TerminalDimensions`), so no new dimension-gathering code was needed. The
now-genuinely-dead `_dimensions` parameter on `RconSession.open()` was
removed (`rconSession.ts`, `rconTerminal.ts`, `cli.ts`, plus two test call
sites). New xterm-headless test in `suggestionDisplay.screen.test.ts` and a
new `rconSession.test.ts` test cover the wrap case end-to-end. `tsc`/`eslint`
clean, 277 tests passing.*

## 9. Feature ideas

Smaller UX enhancements noticed along the way, not yet scheduled.

- [x] Tab completion should complete to the **longest common prefix** when
  multiple suggestions share one, instead of jumping straight to the first
  match (`applySuggestion` in `completionEngine.ts`). E.g. with
  `minecraft:diamond_sword`/`minecraft:diamond_pickaxe` as the only matches,
  the first Tab should complete to `minecraft:diamond_` (and open/keep the
  suggestion popup), not commit to `minecraft:diamond_sword`. Most useful
  when exploring a shared namespace like `minecraft:`. Done: new
  `longestCommonPrefix(items)` helper in `completionEngine.ts`; on the first
  Tab with >1 candidate, if `applySuggestion(line, lcp) !== line` it's applied
  instead of `items[0]` and the list stays open in `'preview'` mode (handled
  in both `onTabOrShiftTab`'s "items already on hand" path and
  `onCompletionsResult`'s fresh-fetch `'tab'` path). A follow-up Tab with
  nothing left to gain falls through to the existing cycling behavior
  (1st suggestion, then 2nd, ...) — which, together with the existing
  live-as-you-type `lineChanged` refetch on Space, already covered the rest
  of the requested cycle/accept flow. 9 new tests (`longestCommonPrefix` +
  a new "Tab common-prefix completion" suite). `tsc`/`eslint` clean,
  286 tests passing.

  Follow-up: cycling between Tab presses no longer depends on elapsed
  wall-clock time. Previously a re-press only cycled if it landed within
  500ms of the last one (`Mode.cycling.lastAdvanceAt`); a slower re-press
  re-derived from scratch instead, which made the behavior feel arbitrary.
  Replaced with an exact check: cycle if the line still equals
  `applySuggestion(phase.query, phase.items[selectedIndex])` (i.e. nothing
  was typed since the last suggestion was applied), regardless of timing;
  otherwise re-derive for the new line. `now`/`Date.now()` removed entirely
  from `completionEngine.ts`'s `Event`/`Mode`/reducer signatures and from
  `rconSession.ts`'s three dispatch sites. 287 tests passing.
- [x] `/history` built-in command (if not already present) and a Ctrl+R-style
  reverse history search (2026-06-11). Done: new `/history` command lists
  `lineEditor.historyEntries` (numbered, oldest-first, like bash's `history`).
  Ctrl+R opens a "(reverse-i-search)" popup reusing `SuggestionDisplay` to show
  matching history entries (deduped, most-recently-used first); typing narrows
  the list, Ctrl+R/Up cycles to older matches, Down cycles to newer, Enter
  loads the selected entry into the line for further editing (does not
  auto-execute), Escape/Ctrl+G/Ctrl+C cancels and restores the in-progress
  line. New pure module `historySearch.ts` (`searchHistory`,
  `startHistorySearch`, `setHistorySearchQuery`, `cycleHistorySearch`) with
  its own test suite. While searching, `RconSession` bypasses `LineEditor`
  entirely and writes the search line directly, with `cursorColumn()` aware of
  search mode so `SuggestionDisplay`'s clear/redraw stays in sync.

  Bonus: command history now persists to disk. New `HistoryStore`
  (`historyStore.ts`), server-scoped JSON in `cacheDir` like
  `commandTreeCache.ts` (capped at 100 entries), loaded once at session start
  via `lineEditor.loadHistory()` and rewritten after each command via
  `pushHistory`. `lineEditor.ts` gained `historyEntries`/`loadHistory()`.
  Welcome banner and `/help` mention Ctrl+R; `/help` lists `/history`.
  New test files `historySearch.test.ts` and `historyStore.test.ts`, plus
  additions to `lineEditor.test.ts` and `rconSession.test.ts` (popup opens
  with recent history, typing narrows it, Enter loads without executing,
  Escape restores the line, persistence across sessions). `tsc`/`eslint`
  clean, 315 tests passing.

  Follow-up: Tab now cycles to the next-older match and Shift-Tab to the
  next-newer match within the search popup, mirroring Tab-cycling in regular
  completions (`handleHistorySearchInput` in `rconSession.ts`). 316 tests
  passing.

  Follow-up: history size (in-memory, persisted, and `/history`/Ctrl+R) is
  now configurable instead of a hardcoded 100. `LineEditor` and `HistoryStore`
  take a `maxHistorySize`/`maxEntries` constructor param (default 100);
  `RconSessionHost` gained an optional `historySize` field threaded through to
  both. VS Code: new `minercon.historySize` setting (`package.json`), read by
  `RconTerminal`. CLI: new `--history-size <n>` flag / `MCRCON_HISTORY_SIZE`
  env var / `historySize` field in `~/.config/minercon/config.json` (written
  by `--save`), resolved via new `resolveHistorySize`/`parseHistorySize` in
  `cliConfig.ts`. 328 tests passing.
- [x] CLI flag to disable the server-side tab-complete plugin probe, for
  manually testing the local (help-crawl) completion path (2026-06-11). Done:
  new `--no-plugin` flag (not persisted to `~/.config/minercon/config.json` —
  intentionally manual-testing-only). New `RconSessionHost.disablePlugin?:
  boolean`; when set, `detectAndInitialize` in `rconSession.ts` skips the
  `tabcomplete` probe entirely, writes a "plugin probe disabled" notice, and
  goes straight to `initializeCommands()` (help-crawl). 329 tests passing.

  Follow-up: three issues found while manually exercising `--no-plugin`
  (2026-06-11) - this is the real experience for every server *without* the
  RconTabComplete plugin, not just a dev path, so all three were treated as
  production bugs:

  1. **Namespace parsing**: `minecraft:help` lines for namespaced commands
     (`minecraft:advancement`, `bukkit:version`, ...) were mis-parsed - `:`
     was treated as end-of-word, so `/minecraft:advancement (grant|revoke)`
     was read as command `minecraft`. Per "ingest everything" (do not strip or
     dedupe namespace prefixes), every namespaced variant - and every
     namespace that contributes the same command (`help`/`bukkit:help`/
     `minecraft:help`) - is now its own first-class `rootCommands` entry.
     Fixed by including `:` in `parseHelpResponse`'s pattern 1/3 char classes
     (`commandAutocomplete.ts`) and by `parseAliasRedirect` (now in
     `helpTextParsing.ts`) preserving namespace prefixes on both the alias and
     target sides of `/<alias> -> <target>` redirects.
  2. **Performance**: with namespaced commands now ingested too, the no-plugin
     crawl was fetching near-identical `help <cmd>`/`minecraft:help <cmd>`
     syntax twice (once for `foo`, once for `minecraft:foo`/`bukkit:foo`).
     Fixed by loading namespaced root commands first
     (`commands.sort((a,b) => Number(b.includes(':')) - Number(a.includes(':')))`
     in `initialize()`), then having `loadCommandDetails` call new
     `findNamespacedSibling(commandPath)` - if a `*:foo` sibling is already
     `isComplete`, its `.parameters` are copied directly and the `help foo`/
     `minecraft:help foo` round trips are skipped entirely.
  3. **Progress bar / log interleaving**: the CLI logger's `INFO ...` lines
     (no leading `\r`/clear) were getting appended onto the in-progress
     `\r\x1b[K`-redrawn progress bar before its next redraw, garbling the
     output. Fixed with a new `src/terminalOutput.ts`
     (`createTerminalWriter`/`createCliLogger`, used by `cli.ts`): the writer
     tracks the terminal's current (redrawable) line, and a log line clears
     it, prints on its own line, then redraws it underneath - a scrolling log
     "pane" below the fixed progress bar.

  New/updated tests: `helpTextParsing.test.ts` (`parseAliasRedirect` preserves
  namespace prefixes), a new "namespaced commands (ingest everything)" suite
  in `commandAutocomplete.test.ts` (4 tests: distinct root entries, multiple
  namespaces contributing `help`, alias redirects preserve prefixes, sibling
  reuse skips re-fetching), and a new "terminal output coordination"/
  "createCliLogger" suite in `cli.test.ts`. 338 tests passing.

  Follow-up (2026-06-11): the argument-hint line was missing its command name
  in `--no-plugin` mode (e.g. `/ [<targets>] [<item>]` instead of `/clear
  [<targets>] [<item>]`, for `/clear`, `/minecraft:clear`, and every other
  command). Cause: `LocalCompletionsBackend.fetchUsage`
  (`completionsBackend.ts`) returned just `argumentHelp` (e.g. "[<targets>]
  [<item>]"), whereas the server's `cmdusage` (plugin mode) echoes the full
  `<command> <args...>` line - `formatArgumentHint` derives the `/command`
  prefix from that leading text, so without it the prefix collapsed to bare
  `/`. Fixed by having `getSuggestions` (`commandSuggestions.ts`) track and
  return the consumed command path (root command name plus any
  literal/subcommand tokens navigated past, e.g. "mvp modify" - excluding
  argument *values* like a typed player name) as a new `commandPath` field,
  and `fetchUsage` now returns `` `${commandPath} ${argumentHelp}`.trim() ``
  (or just `commandPath` for zero-argument commands like `reload`). Also fixed
  the `commandName` cache-key regex (`\w+` → `\S+`) so namespaced commands
  don't collide on their `minecraft:`/`bukkit:` prefix. New tests:
  `commandSuggestions.test.ts` (`commandPath` for plain/namespaced/subcommand/
  zero-arg commands) and new `completionsBackend.test.ts` (6 tests covering
  the bug, namespace preservation, zero-arg commands, cache stickiness, and
  cache reset on command change). 346 tests passing.
- [x] Module-overview developer doc with a Mermaid dependency diagram
  (2026-06-11). Done: new `docs/ARCHITECTURE.md` — layered tour of all ~20
  `src/` modules (RCON connection, command knowledge, completion engine,
  terminal UI, orchestration, host adapters, shared utilities), a `graph TD`
  Mermaid diagram of module dependencies (dashed edges for the type-only
  `commandSuggestions`/`commandTreeCache` ↔ `commandAutocomplete` cluster),
  and a "Where to start reading" section tracing common flows (keypress,
  reconnect, no-plugin Tab, Ctrl+R). `CONTRIBUTING.md`'s stale "Architecture
  Overview" section updated to match current module names
  (`RconSession`/`rconSession.ts` instead of the pre-mega-module-split
  `RconTerminal`) and now points to the new doc.
- [x] **Argument hint never shows for commands with optional trailing
  arguments, in plugin mode** (found 2026-06-11, fixed 2026-06-11). `cmdusage
  clear` returned a Brigadier "usage ladder" - one line per optional-argument
  depth:
  ```
  clear
  clear <targets>
  clear <targets> <item>
  clear <targets> <item> <maxCount>
  ```
  whereas `minecraft:help clear` shows the compact `/clear [<targets>]
  [<item>]` form. `parseUsageResponse` (`completionEngine.ts`) treats any
  response with more than one non-empty line as unresolved/ambiguous (the
  shape it's designed to recognize is genuine ambiguity, e.g. "mvp c" →
  "mvp create"/"mvp config") and returns `''`, so no argument hint was ever
  shown for `/clear` or any other command with optional trailing args.
  Root cause was on the plugin side: `plugin/src/main/java/dev/rcon/
  tabcomplete/TabCompletePlugin.java`'s `handleUsageCommand` called
  Brigadier's `CommandDispatcher.getAllUsage`, which deliberately enumerates
  one usage string per executable depth (the ladder).
  `CommandDispatcher.getSmartUsage` instead returns a `Map<CommandNode,
  String>` already collapsed into the compact `[<param>]` "smart form" - the
  same form `minecraft:help` displays. Fixed by switching
  `handleUsageCommand` to `getSmartUsage`: an empty map means "no further
  args" (sends bare `prefix`), a single-entry map means one collapsed usage
  line (`clear [<targets>] [<item>]`), and a multi-entry map (genuinely
  different subcommand branches, e.g. `team add ...` / `team empty ...`)
  still produces one line per entry - preserving the real-ambiguity case
  `parseUsageResponse` correctly treats as unresolved. No `parseUsageResponse`
  change was needed - its existing single-line/multi-line split already does
  the right thing once the plugin emits the compact form. Updated
  `autocompleteSession.test.ts`'s "highlights the next argument" functional
  test to accept either `[<target>]` (paper/spigot+plugin, now bracketed) or
  `<target>` (fabric+mod, still on `getAllUsage` and unbracketed - same
  ladder issue, not yet fixed there). Verified against real servers via
  `npm run test:functional` (all 7 variants) and a targeted re-run of
  `autocompleteSession.test.ts` (24/24 passing).

## 10. Code review findings — fresh pass (2026-06-12)

A full read of `src/`, `src/test/`, `plugin/`, `fabric-mod/`, and `docs/`.
Ordered roughly by user impact within each group.

### Bugs / behavior

- [x] **Several `LineEditor` edits never fire `host.onLineChanged`** —
  `insertText` and `handleBackspace` notify the host (so completions/argument
  hints re-derive), but `deleteForward`, `killToStart`, `killToEnd`,
  `killWordBack`, `killWordForward`, and `transposeChars` all mutate the line
  without notifying (`lineEditor.ts`). Net effect: after Delete / Ctrl+K /
  Ctrl+U / Ctrl+W / Alt+D / Ctrl+T, the suggestion popup and argument hint
  keep showing results for the *old* line. Fixed: every mutating op (incl.
  the public `deleteSelection`, used by Ctrl+X cut) now notifies; `insertText`
  uses a private non-notifying `deleteSelectionInternal` so replacing a
  selection notifies exactly once, with the final line. New
  "host notification on every mutating edit" suite (10 tests) pins each op,
  including the no-op-doesn't-notify cases.
- [x] **Cancelling the VS Code password prompt connects with an empty
  password** — `password = await vscode.window.showInputBox({...}) ?? ''`
  followed by a dead `if (password === undefined)` check
  (`extension.ts:186-194`); the `?? ''` makes the guard unreachable, so Esc
  at the password box proceeds to connect with `''` instead of aborting like
  the host/port prompts do. Fixed: the `?? ''` is gone and cancel now throws
  `'Password is required'`; a deliberately *empty* password (plain Enter)
  remains allowed, since some servers use one. (No unit test —
  `extension.ts` is IO/UI orchestration, per §5's deep-mocking decision.)
- [x] **`/disconnect` echoes a spurious `^D`** —
  `ConnectionManager.disconnect()` unconditionally writes `'^D\r\n'`
  (`connectionManager.ts:92`), but its only caller is the typed `/disconnect`
  built-in (Ctrl+D goes through `handleCtrlD` → `sessionHost.close`, which
  writes its own `^D`). Fixed: echo removed; the existing disconnect() test
  now also asserts no `^D` is written. (Whether `disconnect()` should write
  UI text at all is left as a possible future refactor.)
- [x] **A slow command (>10s) triggers a full reconnect of a healthy
  connection** — `executeCommand`'s connection-loss detection is substring
  sniffing (`errorMsg.includes('timeout')`, `'socket'`, ...
  `rconSession.ts:711-718`), and `RconProtocol`'s `Command timeout: <cmd>`
  error matches it, so a long-running-but-fine server command tears down and
  re-establishes the connection. Fixed: the catch block now asks
  `connectionManager.controller.isConnected()` — works because
  `RconController` nulls its client on the protocol's `close` event, which
  fires before pending sends reject. Two new rconSession tests cover both
  sides (error on a live connection shows the error without reconnecting;
  error on a dead one reports "Connection lost" and starts auto-reconnect).
- [x] **`fetchPaginatedCommand` checks the wrong variable** — the page loop's
  `if (output)` (`commandAutocomplete.ts:159`) is always true (we returned
  early if page 1 was empty); it clearly meant `if (pageOutput)`. Currently
  harmless but a logic slip waiting to bite. Fixed: guard is now `pageOutput`,
  so empty pages are neither logged nor appended.
- [x] **`RconController.sendNow`'s non-string fallback can throw** — `const
  result = typeof res === 'string' ? res : JSON.stringify(res)` yields
  `undefined` when `res` is `undefined`, and the next line reads
  `result.length` (`rconClient.ts:79-80`). Unreachable today
  (`RconProtocol.send` always resolves a string) but the defensive path is
  itself broken — fixed with `?? ''` on the stringify fallback, plus a
  rconClient.test.ts case driving an `undefined` response through the seam.

### Code smells / structure

- [x] **Prompt text is computed in three places in `rconSession.ts`** — the
  `[reconnecting] > ` / `[disconnected] > ` / `> ` conditional appears in
  `SuggestionDisplay`'s `cursorColumn()` host callback (~line 110),
  `LineEditor`'s `promptText()` host callback (~line 123), and `showPrompt()`
  (~line 244). Fixed: one private `promptText(): string`; all three derive
  from it.
- [x] **`handleEnter`'s built-in command if/else chain** mirrors the old
  `handleInput` smell that §1 fixed with a lookup table — `/reconnect`,
  `/disconnect`, `/clear`, `/help`, `/reload-commands`, `/clear-cache`,
  `/cache-info`, `/history` (`rconSession.ts:580-626`). A
  `Map<string, () => void>` (plus a description field) would also let
  `showHelp()` generate its command list from the same table instead of
  hand-maintaining a parallel copy (CONTRIBUTING.md even documents the
  "add another else-if, don't forget /help" dance). Fixed: new
  `BuiltinCommand` table (`buildBuiltinCommands()` / `builtinLookup`) drives
  both `handleEnter` dispatch and `showHelp()`'s command list; adding a
  command is now a single table entry.
- [x] **Two § color-code strippers** — `completionEngine.ts` has a private
  `stripMinecraftColorCodes` (handles the `Â§` UTF-8-mangled form) while
  `ansi.ts` exports `stripColors`. Consolidate in `ansi.ts` (folding in the
  `Â§` handling) so the alphabet lives in one place. Fixed: the two
  implementations were identical; `completionEngine.ts` now imports and uses
  `stripColors` from `ansi.ts`.
- [ ] **Progress phase is signaled by string-sniffing** —
  `initializeCommands` decides the progress-bar phase via
  `message.includes('Fetching')` / `'Loading'` / `'Complete'`
  (`rconSession.ts:212-218`) against strings composed in
  `commandAutocomplete.ts`. Pass a structured phase
  (`'fetching' | 'loading' | 'done'`) through the `onProgress` callback
  instead of parsing prose.
- [ ] **`addFallbackCommands` list is stale and has duplicates** — `'reload'`
  appears twice, and many entries were removed from the game years ago
  (`testfor`, `testforblock(s)`, `blockdata`, `entitydata`, `replaceitem`,
  `achievement`, `stats`) (`commandAutocomplete.ts:309-321`). Prune to a
  small modern set — wrong suggestions are worse than fewer suggestions.
- [x] **`parseHelpResponse` pattern char-class inconsistency** — patterns 2/4
  use `[a-zA-Z0-9_\:-]` (needless `\:` escape) while 1/3 use
  `[a-zA-Z0-9_:-]` (`commandAutocomplete.ts:252-255`). Fixed: all four use
  `[a-zA-Z0-9_:-]`; pattern 4's needless `\[`/`\(` class escapes dropped too.
- [x] **`extension.ts` `let` → `const`** for `activeTerminals` and
  `ptyToController` (`extension.ts:21-22`); they're never reassigned. Fixed.
- [x] **fabric-mod's `cmdusage` still emits the `getAllUsage` ladder** —
  `TabcompleteMod.java:107` — so argument hints for commands with optional
  trailing args (`/clear`, etc.) never show on fabric+mod, the exact bug
  fixed in the Paper plugin by switching to `getSmartUsage` (§9, fb81e69).
  Fixed: same `getSmartUsage` port (empty map → bare prefix; entries →
  one collapsed usage line each), and the autocompleteSession functional
  test's `<target>` assertion is tightened to require the bracketed
  `[<target>]` smart form on **all** addon variants — the bare ladder form
  now fails the test instead of being accepted as an alternative.
- [ ] **Server-side addon naming is inconsistent** — plugin.yml says
  `RconTabComplete`, the gradle project/jar is `paper-tabcomplete`, the
  fabric mod id is `fabric-tabcomplete`, README calls it "the RconTabComplete
  plugin". Pick one public name (worth doing *before* publishing to
  Hangar/Modrinth — see §11).

### Tests

- [ ] **`FakeController` is defined three times** — near-identical copies in
  `rconSession.test.ts`, `rconTerminal.test.ts`, and
  `connectionManager.test.ts`; `waitUntil` twice. Move both to
  `src/test/support/` alongside `fakeSocket.ts`.
- [ ] **Stale "no injection seam" comments + missing reconnect coverage** —
  `rconSession.test.ts` and `rconTerminal.test.ts` headers still say the
  auto-reconnect path can't be tested because `ConnectionManager` constructs
  a real `RconController`, but `ConnectionManager` has since gained a
  `controllerFactory` param (used by `connectionManager.test.ts`).
  `RconSession` just doesn't thread it through. Plumb an optional factory
  from `RconSession`'s constructor into `ConnectionManager`, update the
  comments, and add the session-level "connection lost → auto-reconnect →
  onReconnected reloads commands" test the gap was about.
- [x] **`variants.ts:34` ends with a double semicolon** (`...hasMod);;`). Fixed.

### Docs

- [ ] **`docs/TECHNICAL.md` contradicts the code it documents** — it says the
  fence/dummy packet is sent *immediately* after the command (now deferred
  until the first response fragment — the whole point of the fence fix);
  claims "multiple commands in-flight / no head-of-line blocking" (the send
  queue now deliberately serializes — the opposite, and load-bearing);
  claims Nagle is disabled (no `setNoDelay` call exists); gives 5s/30s
  timeouts (actual: one 10s `RESPONSE_TIMEOUT`); and references methods that
  don't exist (`parsePackets`, `encodePacket`, a `debug()` using
  `this.output`) plus Jest examples in a mocha project. Rewrite against the
  current `rconProtocol.ts`/`rconClient.ts`.
- [ ] **`CONTRIBUTING.md` staleness** — "Node.js 14+" (devDeps target Node
  22 types / modern TS), the "Project Structure" tree lists 5 of ~22
  modules, and the debugging tip says `this.output.appendLine()` (pre-Logger).
  Also update "Adding a New Built-in Command" if the command table from §10
  lands.
- [ ] **README drift** — CLI options section omits `--log-level`,
  `--history-size`, and `--no-plugin` (all in `--help`); the built-in
  commands table omits `/history`; the keyboard-shortcut tables omit Ctrl+R
  history search. Also worth a "formerly Minecraft RCON Terminal" naming
  note near the version badge for returning users.
- [ ] **`SECURITY.md` supported-versions table** still lists 2.0.x/1.1.x/1.0.x
  while the package is at 3.0.0.
- [ ] **Mark `docs/technical/AUTOCOMPLETE_UPDATES.md`, `HYPHEN_FIX.md`,
  `RENDERING_FIX.md` as historical** — they describe code shapes that have
  since been refactored away (e.g. quoting pre-split `commandAutocomplete.ts`
  internals). A one-line "historical writeup, see ARCHITECTURE.md for the
  current shape" header keeps them useful without misleading.

## 11. Publishing & audience roadmap (2026-06-12)

Everything between "works great locally" and "strangers use it". Roughly in
order. npm name check (2026-06-12): **`minercon` is unclaimed on the npm
registry** — grab it early.

### 11.1 Pre-flight: make the package publishable

- [ ] **Fix the npm tarball — it is currently broken and bloated.**
  `npm pack --dry-run` today produces 228 files / 2.1 MB unpacked: it ships
  `src/` and all tests, while `out/` (the actual compiled code) is excluded
  by `.gitignore`-fallback rules — npm force-includes only the `main`/`bin`
  files, so the published CLI would crash on its first `require('./rconSession')`.
  Add a `files` whitelist (e.g. `["out/", "!out/test/", "images/icon.png",
  "LICENSE", "README.md", "CHANGELOG.md"]`) and a `prepublishOnly: "npm run
  compile"` script; re-audit with `npm pack --dry-run` until it's just the
  compiled tree.
- [ ] **Fill in package.json metadata** — `author`, `keywords` (`minecraft`,
  `rcon`, `console`, `terminal`, `server-admin`, `tab-completion`, ...),
  `homepage`, `bugs`, `repository.url` in `git+https://...` form, and an
  `engines.node` (`>=18`) for the CLI. These feed both the npm page and the
  Marketplace listing search.
- [ ] **Add `--version` to the CLI** (read from package.json at runtime).
  First thing people try; also needed in bug reports.
- [ ] **Write the missing CHANGELOG entries** — CHANGELOG stops at 2.2.0
  (2025-10-03) but the package says 3.0.0; everything since (the standalone
  CLI, plugin mode + RconTabComplete, the help-crawl local mode, Ctrl+R,
  history persistence, `--no-plugin`, ...) is the actual launch story.
  The 3.0.0 entry is effectively the announcement post — write it well once,
  reuse it everywhere.
- [ ] **LICENSE: add your own copyright line** alongside the existing
  `Copyright (c) 2025 Jake T Cooper` (keep his — MIT requires preserving the
  notice; the fork attribution in README's Acknowledgements is already good).
- [ ] **Fill in or delete `.github/FUNDING.yml`** — it's still the unfilled
  GitHub template (every line a placeholder comment).
- [ ] **Windows smoke test** the CLI (raw-mode stdin, ANSI rendering in
  Windows Terminal, `~/.config` path assumptions — `os.homedir()+'/.config'`
  is unixy; consider `env.APPDATA`/`XDG_CONFIG_HOME` handling). The
  `cp`/`chmod` in the compile script also breaks `npm run compile` for
  Windows contributors — a tiny node script fixes both.
- [ ] **Refresh the demo media** — `images/demo-autocomplete.gif` predates
  argument hints/Ctrl+R; record one ~20s GIF (or asciinema for the CLI)
  showing: connect → type `/give` → live suggestions → Tab cycling →
  argument hint. This single asset gets reused in README, Marketplace,
  Reddit, and HN.

### 11.2 Publish to npm

- [ ] Create/verify npm account with 2FA; `npm login`.
- [ ] `npm publish --dry-run`, then `npm publish` (unscoped packages are
  public by default). Verify with a cold `npm install -g minercon` on a
  clean machine/container and run against a real server.
- [ ] Tag `v3.0.0` and create a GitHub Release; attach the `.vsix`, the
  plugin jar, and the fabric mod jar so non-npm users have direct downloads.
- [ ] (Nice) Set up a GitHub Actions release workflow that publishes on tag
  with `npm publish --provenance` — the provenance badge is a real trust
  signal for a tool that takes server passwords.

### 11.3 Publish to the VS Code Marketplace

The Marketplace is run through Azure DevOps; the steps are:

- [ ] **Create a publisher**: sign in at
  https://marketplace.visualstudio.com/manage with a Microsoft account →
  "Create publisher" → pick the publisher ID (e.g. `xton`) and display name.
- [ ] **Create a PAT**: at https://dev.azure.com → user settings → Personal
  Access Tokens → new token with org "All accessible organizations" and the
  **Marketplace → Manage** scope. (This is the step everyone fumbles —
  the scope must be Marketplace/Manage, not the defaults.)
- [ ] **Add Marketplace fields to package.json**: `"publisher": "<your-id>"`
  (required — packaging fails without it), and improve the listing:
  `keywords` show in Marketplace search, `galleryBanner` colors the header,
  `icon` is already set. Consider whether `categories: ["Other"]` is right
  (there's no great category for terminals; "Other" is what similar
  extensions use).
- [ ] **Create `.vscodeignore`** — without it the `.vsix` bundles everything
  (src, tests, docker/, plugin/, fabric-mod/, docs/). Exclude all of those;
  `vsce ls` shows exactly what will ship. (There are no runtime deps, so no
  bundler is needed — the compiled `out/` is already self-contained.)
- [ ] **Package and publish**: `npm i -g @vscode/vsce` → `vsce package`
  (produces `minercon-3.0.0.vsix`; install it locally via "Install from
  VSIX" as a final check) → `vsce login <publisher>` with the PAT →
  `vsce publish`. Subsequent releases: `vsce publish minor` bumps and
  publishes in one step.
- [ ] **Also publish to Open VSX** (https://open-vsx.org, `npx ovsx publish`)
  — it's the registry used by VSCodium, Gitpod, and many Cursor/forks
  setups; it's ~10 minutes of extra work for a real chunk of audience.
- [ ] README *is* the listing page — make sure the demo GIF is near the top
  and image links are absolute URLs (Marketplace can't resolve repo-relative
  paths for some setups; `vsce` rewrites most but verify the rendered page).

### 11.4 Publish the server-side addon where admins actually look

Plugin mode is the best experience, and plugin sites are themselves
discovery channels that link back to the client:

- [ ] **Hangar** (hangar.papermc.io) for the Paper/Spigot plugin — the
  modern Paper-ecosystem registry.
- [ ] **Modrinth** for both the plugin and the fabric mod (Modrinth hosts
  plugins now too, and is where Fabric users live).
- [ ] **SpigotMC resources** — older crowd but still the biggest plugin
  audience; the resource page doubles as a place people ask questions.
- [ ] Unify the addon naming first (see §10) and give the addon README a
  clear "this powers tab completion for the Minercon client → link" pitch.

### 11.5 Announce / find an audience

Order matters: have npm + Marketplace + GitHub Release all live *before*
posting anywhere, then announce within a few days while it's fresh.

- [ ] **r/admincraft** — the primary audience (server admins). Read the
  self-promo rules first, post with the demo GIF, lead with the pain point
  ("RCON clients truncate /help and have no tab completion"), mention it's
  free/MIT/open-source, and stick around in the comments. This is the single
  highest-value post.
- [ ] **r/MinecraftCommands** — people who live in command syntax; the
  argument-hint/tab-completion angle lands well here.
- [ ] **r/feedthebeast** (modded servers — the Fabric mod angle) and
  **r/vscode** (the extension angle) as secondary posts, reworded per
  audience, spaced out by a week or so.
- [ ] **Show HN** — "Show HN: Minercon – a Minecraft RCON terminal with tab
  completion". HN loves the technical meat: the double-packet fragmentation
  fence and the /help-crawl Brigadier reverse-engineering
  (docs/technical/NO_PLUGIN_HELP_CRAWL.md is most of a blog post already).
  Consider polishing that into a post and submitting the post instead of the
  repo.
- [ ] **Discord servers**: PaperMC (#plugins / tooling channels), the
  Admincraft discord, Fabric's discord (for the mod). Ask-don't-spam: most
  have a showcase channel.
- [ ] **The itzg/minecraft-server (docker) ecosystem** — minercon pairs
  naturally with dockerized servers (the functional tests already use it); a
  docs PR or discussion post there reaches exactly the right users.
- [ ] **Awesome lists** — PR to awesome-minecraft / awesome-vscode style
  lists once the listing pages look good.
- [ ] After launch: enable GitHub Discussions (or point people at issues),
  and watch the Marketplace Q&A tab — answered questions are marketing.

### 11.6 Relationship with the original author (jaketcooper/Minecraft-rcon)

There's no legal todo — MIT is satisfied by the preserved LICENSE copyright
line and the README Acknowledgements (both already in place). The rest is
courtesy, which costs little and occasionally pays off big:

- [ ] **Send a friendly heads-up** (GitHub issue on his repo, or email if
  listed): the fork lives on, got renamed to Minercon, here's what it became,
  he's credited in README + LICENSE — and a thank-you. No ask attached.
- [ ] **Offer a cross-link**: if his project is dormant, he may be happy to
  add "actively maintained fork: minercon" to his README — that converts his
  existing installs/stars into your funnel. His call; offer once.
- [ ] If he engages, add him to `contributors` in package.json and the
  release notes. If he doesn't respond, the existing attribution is already
  correct and sufficient — proceed.
- [ ] Keep the branding distinct (already done — different name, icon, and
  description), so Marketplace/npm listings can't be confused with his.

## 12. Server-side plugin: fork per server type, drop reflection on Paper (2026-06-12)

`plugin/src/main/java/dev/rcon/tabcomplete/TabCompletePlugin.java` reaches
Brigadier's `CommandDispatcher` via reflection because `plugin/build.gradle`
only depends on `paper-api`, which deliberately doesn't expose
CraftBukkit/NMS types (`CraftServer`, `MinecraftServer`, `Commands`,
`CommandSourceStack`). All the reflected members are `public` — the
reflection exists to name types that aren't on the compile classpath, not to
reach package-private members (a "declare your class in `net.minecraft.*`"
trick wouldn't help: it only addresses access modifiers, and plugin classes
load under a different ClassLoader than the server anyway, so same-package
access control doesn't even apply).

- [ ] **Fork the plugin into Paper-specific and Spigot-specific projects.**
  User is fine with this — in fact prefers it. This also resolves the
  addon-naming-inconsistency item above (§10): each fork gets its own
  gradle project name / jar / plugin.yml name, decided as part of this work.
- [ ] **Paper fork: use `paperweight-userdev`** to add the Mojang-mapped dev
  bundle to the compile classpath, giving direct typed access to
  `CraftServer`, `MinecraftServer`, `Commands`, `CommandSourceStack`, and
  `CommandDispatcher<CommandSourceStack>`. This replaces the entire
  Mojang-mapped happy path (`onEnable` lines ~38-46) and removes the need for
  `findDispatcherAndSourceReflectively()` on Paper entirely — `cmdusage` and
  `tabcomplete` become ordinary typed Brigadier calls. Need to confirm
  whether a `reobfJar` step is still required for current Paper versions
  (Paper's runtime server jar may already be Mojang-mapped since 1.20.5).
- [ ] **Spigot fork: investigate current mapping state** before deciding the
  approach — Spigot may have also moved to Mojang mappings post-1.20.5, in
  which case compiling against a BuildTools-produced `org.spigotmc:spigot`
  jar (still versioned `vX_Y_R_` CraftBukkit packages, so version-pinned)
  could replace reflection there too. If not, keep the existing structural
  `findDispatcherAndSourceReflectively()` fallback for Spigot — it already
  works and is well-documented.
- [ ] Update README, functional test harness (`variants.ts`,
  testcontainers plugin-deploy paths), and `fabric-mod/` references for the
  new artifact name(s)/jar filename(s) once the naming decision is made.

This is a build/architecture change, not a code-smell fix — treat as its own
session, after the §10 cleanup pass.

## How to record a live RCON fixture

```
npm run record-rcon-fixtures -- <host> <port> <password> [fixtureName]
```

Connects to a real server, drives it through the canonical script
(`src/test/fixtures/rcon/script.ts`), and writes
`src/test/fixtures/rcon/<fixtureName>.ts` (default name `recorded`) — with
the real password automatically redacted. Review the generated file, commit
it, and add it to the `FIXTURES` array in `src/test/rconProtocol.test.ts`.
