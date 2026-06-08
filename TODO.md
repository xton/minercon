# Code Quality Checklist

Tracking the work items from the project's "Code Quality Report" code review.
Update checkboxes as items are completed; add a short note on how/where for
anything non-obvious.

## 1. Code smells
- [x] `handleInput` 450-line if-chain → replaced with `Map`-based `buildKeyHandlers()` lookup table (rconTerminal.ts)
- [x] Duplicate prompt-rendering (`showPrompt` vs. `redrawLineWithSelection`) → unified via `LineEditorHost.promptText()`
- [x] Near-duplicate clear-area methods (`clearSuggestionDisplay`/`clearArgumentDisplay`) → merged into single `SuggestionDisplay.clear()`
- [ ] Debug-grade logging in `commandAutocomplete.ts` — `appendLine` calls were converted to `logger.*` but scratch-debug *content* remains (e.g. `everything:\n${modified}`, `"...or is it ${altCommandCount}?"`, `"  Checking: ... vs ..."`)
- [ ] `any` typing — still in `rconClient.ts`, `extension.ts` (x3), `rconTerminal.ts` (mostly `catch (err: any)`)
- [ ] Long methods `loadCommandDetails` (~213 lines) / `loadSubcommandDetails` (~270 lines) in `commandAutocomplete.ts`

## 2. Mega-modules worth splitting
- [x] `rconTerminal.ts` split (1,597 → 646 lines): extracted `LineEditor`, `SuggestionDisplay`, `ConnectionManager` per `dapper-purring-zebra` plan
- [ ] `commandAutocomplete.ts` split (1,227 lines) — proposed `helpResponseParser.ts` / `commandTreeCache.ts` / orchestration class not yet done

## 3. Design patterns
- [x] Command/lookup-table pattern for key dispatch (came along with the rconTerminal split)
- [ ] Strategy pattern for local-vs-plugin parsing in `commandAutocomplete.ts` (tied to the split above)
- [x] Extract a "terminal renderer" collaborator → `SuggestionDisplay` (pure content builders + `renderSuggestionArea`)

## 4. Dead code
- [ ] `src/test/rconProtocolTest.ts` — still exists, still zero references anywhere; converted to use `Logger` but never wired up or deleted. Best resolved alongside §6 (delete it as part of the mocked-test swap, net-zero file count)
- [x] `currentArgumentHelp` write-only field — deleted
- [x] `terminalBufferHeight` unused field — deleted
- [x] `clearArgumentDisplay()` dead method — deleted (folded into `clear()`)

## 5. Test coverage
- [x] `completionEngine.ts` `applySuggestion` — extracted as pure fn + 7 new unit tests (61 → 68 passing)
- [ ] `rconTerminal.ts`/`lineEditor.ts` pure logic (selection math, history nav, word-boundary finding) — now more extractable post-split, but still untested
- [ ] `rconProtocol.ts`/`rconClient.ts` packet framing/fragmentation/auth — no unit tests
- [ ] `extension.test.ts` — still the unmodified VS Code scaffold sample

## 6. Mocked RCON protocol tests
- [ ] Build a fake-socket harness and mock-test `RconProtocol` (auth handshake, single/fragmented packets, concurrent requests, drop mid-request); delete `rconProtocolTest.ts` once it's the replacement

## 7. `readline`-style REPL library
- [x] **Canceled** — decided against by design: adapter complexity, fights the custom multi-line/selection UI, no equivalent for features already built. No action item.

---
*Last updated: 2026-06-08*
