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
- [ ] `rconTerminal.ts` — still has no dedicated test file (the original review item's share for this module). The selection/history/word-boundary logic itself already moved to `LineEditor` and is covered by the suite above; what's left here is `RconTerminal` itself — `buildKeyHandlers`/`handleInput` dispatch, `dispatchToEngine`/`executeEngineEffect` (wiring `completionEngine`'s `Machine` to the UI), and `executeCommand`'s output-line bookkeeping. Like `extension.ts` (§5, closed as decided-against) it's largely vscode-pty/IO orchestration glued together with `LineEditor`/`SuggestionDisplay`/`ConnectionManager`/`CommandAutocomplete` collaborators — but unlike `extension.ts`, the engine-dispatch and key-handler-lookup pieces *are* reasonably pure state-machine logic over a `LineEditorHost`-style seam, so a `FakeHost`-driven suite (mirroring `lineEditor.test.ts`) looks tractable rather than a call-order-assertion exercise. Worth a closer look before deciding whether to test or close-as-decided-against
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
*Last updated: 2026-06-08 — §1 (Code smells) is now fully checked off too:
the last two items were the `commandAutocomplete.ts` debug-logging cleanup
(scratch dumps/traces removed, legitimate diagnostics kept and tidied) and
the remaining `any` typing (a new `errorMessage(unknown): string` helper in
`logger.ts` retired every `catch (err: any)` across `rconClient.ts`,
`extension.ts`, `rconTerminal.ts`, and `connectionManager.ts`, plus a
`'pty' in ...` type-guard fix in `extension.ts`). Pure refactor — still 147
tests passing, `tsc`/`eslint` clean.

§5 (Test coverage) was fully checked off in the prior pass: beyond the
`completionEngine`/split-module/`classifyParameterTokens` work, that pass
added a `FakeHost`-driven suite for `lineEditor.ts`'s selection math/history
nav/word-boundary logic, a `FakeProtocol`-driven suite for `RconController`'s
queue-serialization/error-containment logic (a new `createProtocol` injection
seam was added to make it testable, mirroring `RconProtocol`'s
`createSocket`), and a smoke test replacing `extension.test.ts`'s meaningless
scaffold sample (deep vscode-API mocking for `extension.ts` was decided
against, like §7). One loose thread remains: `rconTerminal.ts`'s share of the
selection/history/word-boundary item still has no dedicated test file.

§2 (mega-module splits), §4 (dead code), §6 (record/replay harness), and the
`rconProtocolTest.ts` dead-code item are also fully done. The only items left
open across the whole checklist are §3's "Strategy pattern for
local-vs-plugin parsing" and the `rconTerminal.ts` test-coverage loose thread
above. 147 tests passing.*

## How to record a live RCON fixture

```
npm run record-rcon-fixtures -- <host> <port> <password> [fixtureName]
```

Connects to a real server, drives it through the canonical script
(`src/test/fixtures/rcon/script.ts`), and writes
`src/test/fixtures/rcon/<fixtureName>.ts` (default name `recorded`) — with
the real password automatically redacted. Review the generated file, commit
it, and add it to the `FIXTURES` array in `src/test/rconProtocol.test.ts`.
