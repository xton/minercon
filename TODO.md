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
- [ ] Strategy pattern for local-vs-plugin parsing in `commandAutocomplete.ts` — orthogonal to the §2 split (that extracted parsing/caching/suggestions; this would be about varying *how* the tree gets built per-server, inside what's left of `loadCommandDetails`/`loadSubcommandDetails`)
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
`rconProtocolTest.ts` dead-code item are also fully done. The only item left
open across the whole checklist is §3's "Strategy pattern for local-vs-plugin
parsing". 147 → 159 tests passing, `tsc`/`eslint` clean throughout.*

## How to record a live RCON fixture

```
npm run record-rcon-fixtures -- <host> <port> <password> [fixtureName]
```

Connects to a real server, drives it through the canonical script
(`src/test/fixtures/rcon/script.ts`), and writes
`src/test/fixtures/rcon/<fixtureName>.ts` (default name `recorded`) — with
the real password automatically redacted. Review the generated file, commit
it, and add it to the `FIXTURES` array in `src/test/rconProtocol.test.ts`.
