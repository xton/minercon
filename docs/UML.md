# UML reference

A detailed, diagram-first companion to [ARCHITECTURE.md](ARCHITECTURE.md).
Where `ARCHITECTURE.md` explains *why* each module is shaped the way it is in
prose, this document draws the *structure* — classes, interfaces, the
discriminated-union data models, the relationships between them — plus a few
behavioural diagrams (sequences and a state machine) for the flows that are
hard to see from static structure alone.

All diagrams are [Mermaid](https://mermaid.js.org/); GitHub renders them
inline. Member lists are **representative of the public surface**, not
exhaustive — private helpers are omitted unless they're load-bearing for
understanding a relationship. Names track the code as of this writing; if they
drift, the source is the source of truth.

## How to read the relationship arrows

| Arrow | Mermaid | Meaning here |
|---|---|---|
| Solid triangle | `<|--` | Class inheritance (`extends`) |
| Dashed triangle | `<|..` | Interface realization (`implements`) |
| Filled diamond | `*--` | Composition — owner constructs/owns the part's lifetime |
| Open diamond | `o--` | Aggregation — holds a reference it didn't necessarily create |
| Solid arrow | `-->` | Association — holds/uses a reference |
| Dashed arrow | `..>` | Dependency — calls into / constructs, but doesn't retain |

The codebase layers bottom-up: **RCON connection → command knowledge →
completion engine → terminal UI → orchestration → host adapters**, with two
shared utilities (`ansi.ts`, `logger.ts`) used throughout. Each layer gets its
own class diagram below; the orchestration diagram ties them together.

---

## 1. RCON connection layer

The wire protocol and its lifecycle. `RconProtocol` speaks bytes; `RconController`
serializes commands onto it; `RconConnectionManager` owns connect/reconnect.
Both lower classes take a *factory* for the layer beneath them (`createSocket`,
`createProtocol`, `controllerFactory`) so tests can substitute fakes without a
real socket.

```mermaid
classDiagram
    direction LR

    class EventEmitter {
        <<node:events>>
    }

    class SocketLike {
        <<interface>>
        +connect(port, host) void
        +setKeepAlive(enable, initialDelay) void
        +write(data: Buffer) void
        +destroy() void
    }

    class RconProtocol {
        -socket: SocketLike
        -authenticated: bool
        -pendingRequests: Map~number, PendingRequest~
        -RESPONSE_TIMEOUT: 10000ms
        -AUTH_TIMEOUT: 5000ms
        +connect() Promise
        +send(cmd) Promise~string~
        +disconnect() Promise
        +isConnected() bool
        -handleData(data) void
        -handlePacket(packet) void
        -createPacket(id, type, body) Buffer
        -parsePacket(buffer) RconPacket
    }

    class PendingRequest {
        <<union>>
        auth | command | fence
    }

    class RconController {
        -client: RconProtocol
        -sendQueue: Promise
        -createProtocol: factory
        +connect() Promise
        +send(cmd) Promise~string~
        +disconnect() Promise
        +isConnected() bool
        -sendNow(cmd) Promise~string~
    }

    class RconConnectionManager {
        -_controller: RconController
        -_isConnected: bool
        -_isReconnecting: bool
        -reconnectAttempts: number
        -reconnectDelay: number
        +controller: RconController
        +isConnected: bool
        +reportConnectionLost() void
        +manualReconnect() Promise
        +disconnect() void
        +dispose() void
        -attemptReconnect() Promise
    }

    class RconConnectionManagerHost {
        <<interface>>
        +write(text) void
        +showPrompt() void
        +onReconnected() void
    }

    EventEmitter <|-- RconProtocol
    EventEmitter <|-- SocketLike
    RconProtocol ..> SocketLike : createSocket()
    RconProtocol *-- PendingRequest
    RconController *-- RconProtocol : createProtocol()
    RconConnectionManager o-- RconController
    RconConnectionManager ..> RconController : controllerFactory()
    RconConnectionManager --> RconConnectionManagerHost
```

> **`RconController.send` serialization.** Every `send()` chains onto
> `sendQueue` so at most one RCON exchange is in flight at a time — concurrent
> exchanges over one socket make some servers drop the connection. See
> [TECHNICAL.md](TECHNICAL.md) for the deferred-fence reassembly that
> `RconProtocol.send`/`handlePacket` implement.

---

## 2. Command-knowledge layer

"What can the user type, and what does it mean." `CommandTreeCrawler`
orchestrates: it loads a cached tree or crawls `/help`, using the two pure
parsing modules to interpret responses, and persists via `CommandTreeCache`.
The tree itself is the `Parameter` discriminated union (`commandTree.ts`), read
back by the pure `getSuggestions` function.

```mermaid
classDiagram
    direction TB

    class CommandTreeCrawler {
        -rootCommands: Map~string, CommandNode~
        -supportsMinecraftNamespace: bool
        +isReady: bool
        -cache: CommandTreeCache
        +initialize(onProgress, forceRefresh) Promise
        +getSuggestions(input) SuggestionResult
        +fetchPaginatedCommand(command) Promise~string~
        +getCacheInfo() CacheInfo
        +clearCache() void
        -fetchRootCommands(pendingAliases) Promise
        -loadCommandDetails(...) Promise
        -loadSubcommandDetails(...) Promise
        -mergeHelpSources(help, mc, path) HelpLinesResult
    }

    class CommandTreeCache {
        -cacheVersion: 2.4.0
        -serverIdentifier: string
        +save(rootCommands) void
        +load() Map~string,CommandNode~
        +getInfo() CacheInfo
        +clear() void
    }

    class SuggestionResult {
        <<interface>>
        +suggestions: string[]
        +argumentHelp?: string
        +commandPath?: string
    }

    class brigadier {
        <<commandTreeParsingBrigadier.ts · pure>>
        +parseHelpResponse(text) ParsedHelpResponse
        +parseHelpLines(...) HelpLinesResult
        +classifyParameterTokens(...) ...
        +buildParameterStructureFromVariants(...) Parameter[]
        +isUnsupportedNamespaceError(s) bool
        +isGenericArgsPlaceholder(p) bool
        +hasRealUsage(s) bool
    }

    class bukkit {
        <<commandTreeParsingBukkit.ts · pure>>
        +extractBukkitUsageLines(text, path) string[]
        +extractBukkitAliases(text) string[]
    }

    class suggestions {
        <<commandTreeSuggestions.ts · pure>>
        +getSuggestions(rootCommands, isReady, input) SuggestionResult
    }

    CommandTreeCrawler *-- CommandTreeCache
    CommandTreeCrawler ..> brigadier : parse responses
    CommandTreeCrawler ..> bukkit : parse responses
    CommandTreeCrawler ..> suggestions : getSuggestions()
    CommandTreeCrawler --> RconController : sendCommand
    CommandTreeCrawler ..> SuggestionResult : returns
    suggestions ..> SuggestionResult : builds
```

### The `Parameter` model (`commandTree.ts`)

A recursive discriminated union tagged by `ParameterType`. A root command is a
`SubcommandParameter` aliased as `CommandNode`. Everything that builds a tree
produces `Parameter`s; everything that reads one (`commandTreeSuggestions`,
`displayArgumentHint`, `displayCommandTree`) consumes them.

```mermaid
classDiagram
    direction TB

    class ParameterType {
        <<enum>>
        ARGUMENT
        LITERAL
        CHOICE_LIST
        SUBCOMMAND
    }

    class ParameterBase {
        <<interface>>
        +optional: bool
        +position: number
    }

    class ArgumentParameter {
        +type: ARGUMENT
        +name: string
    }
    class LiteralParameter {
        +type: LITERAL
        +literal: string
    }
    class ChoiceListParameter {
        +type: CHOICE_LIST
        +choices: Parameter[]
    }
    class SubcommandParameter {
        +type: SUBCOMMAND
        +name: string
        +members: Parameter[]
        +isComplete: bool
    }

    ParameterBase <|-- ArgumentParameter
    ParameterBase <|-- LiteralParameter
    ParameterBase <|-- ChoiceListParameter
    ParameterBase <|-- SubcommandParameter
    ChoiceListParameter o-- Parameter : choices
    SubcommandParameter o-- Parameter : members
    SubcommandParameter --> CommandNode : «alias»

    note for SubcommandParameter "Parameter = Argument | Literal | ChoiceList | Subcommand. CommandNode = root SubcommandParameter."
```

> The crawl strategy itself — `/help` vs. `minecraft:help`, Brigadier vs.
> Bukkit grammars, source merging — is documented in
> [NO_PLUGIN_HELP_CRAWL.md](NO_PLUGIN_HELP_CRAWL.md).

---

## 3. Tab-completion engine

A pure reducer. `step(machine, event)` returns the next `Machine` plus a list
of declarative `Effect`s the shell executes; it never touches the network, the
clock, or the terminal. The `CompletionBackend` seam is where "where do
completions come from" is answered — once, by picking an implementation.

```mermaid
classDiagram
    direction LR

    class engine {
        <<completionEngine.ts · pure reducer>>
        +createMachine() Machine
        +step(m, event) StepResult
    }

    class Machine {
        <<interface>>
        +seq: number
        +phase: Phase
        +fetch: FetchState
    }
    class Phase {
        <<union>>
        closed
        open: query, items, selectedIndex, usage, mode
    }
    class FetchState {
        <<union>>
        idle
        busy: requestId, purpose, forLine, queued
    }
    class Effect {
        <<union>>
        fetchCompletions
        fetchUsage
        applySuggestion
        render
        hide
        restoreLine
    }
    class Event {
        <<union>>
        lineChanged | tab | shiftTab
        arrow | selectIndex | escape
        completionsResult | usageResult
    }
    class StepResult {
        <<interface>>
        +machine: Machine
        +effects: Effect[]
    }

    class CompletionBackend {
        <<interface>>
        +fetchCompletions(line) Promise~string[]~
        +fetchUsage(line) Promise~string~
    }
    class RconCompletionBackend {
        -getController: ControllerThunk
    }
    class LocalCompletionBackend {
        -commandTree: CommandTreeCrawler
        -cachedCommandPath: string
        -cachedHelp: string
    }

    Machine *-- Phase
    Machine *-- FetchState
    engine ..> Machine : reduces
    engine ..> Event : consumes
    engine ..> Effect : emits
    engine ..> StepResult : returns
    CompletionBackend <|.. RconCompletionBackend
    CompletionBackend <|.. LocalCompletionBackend
    RconCompletionBackend ..> RconController : tabcomplete / cmdusage
    LocalCompletionBackend --> CommandTreeCrawler
```

The engine's own behaviour — phases, modes, and how async races resolve — is
drawn as a state machine in [§8](#8-completion-engine-state-machine).

---

## 4. Terminal UI layer

Rendering and editing, independent of RCON. Each class talks to its host via a
narrow `*Host` interface (all supplied by `RconSession`). `SuggestionDisplay`
delegates argument-hint formatting to the pure `formatArgumentHint`.

```mermaid
classDiagram
    direction LR

    class LineEditor {
        -currentLine: string
        -cursorPosition: number
        -selection: Range
        -history: string[]
        -historyCursor: HistoryCursor
        +line: string
        +cursor: number
        +insertText(text) void
        +handleBackspace() void
        +killToEnd() string
        +killWordBack() string
        +navigateHistory(dir) void
        +replaceLine(newLine) void
        +redraw() void
    }
    class LineEditorHost {
        <<interface>>
        +write(text) void
        +promptText() string
        +onLineChanged(line) void
        +consumeOutputArtifacts() bool
    }

    class SuggestionDisplay {
        -currentSuggestions: string[]
        -visibleStart: number
        -maxVisible: 10
        +isShowing: bool
        +itemCount: number
        +render(items, selectedIndex, usage, currentLine) void
        +hide() void
        +clear() void
        +nextPageIndex() number
        +previousPageIndex() number
        -buildSuggestionListLines(currentLine) string[]
        -buildArgumentHintLines(display) string[]
        -renderSuggestionArea(lines) void
    }
    class SuggestionDisplayHost {
        <<interface>>
        +write(text) void
        +cursorColumn() number
    }

    class hint {
        <<displayArgumentHint.ts · pure>>
        +formatArgumentHint(usage, line) ArgumentHintDisplay
    }
    class ArgumentHintDisplay {
        <<interface>>
        +commandPrefixText: string
        +tokens: string[]
        +currentArgIndex: number
    }

    class HistoryStore {
        -file: string
        -maxEntries: 100
        +load() string[]
        +save(entries) void
    }
    class history {
        <<historyStore.ts search · pure>>
        +searchHistory(...) ...
        +startHistorySearch(...) HistorySearchState
        +cycleHistorySearch(...) HistorySearchState
    }
    class HistorySearchState {
        <<interface>>
        +query: string
        +items: string[]
        +selectedIndex: number
        +originalLine: string
    }

    LineEditor --> LineEditorHost
    SuggestionDisplay --> SuggestionDisplayHost
    SuggestionDisplay ..> hint : formatArgumentHint()
    hint ..> ArgumentHintDisplay : builds
    history ..> HistorySearchState : builds
```

---

## 5. Orchestration & host adapters

`RconSession` is the host-agnostic conductor: it owns one of everything above,
constructs the `*Host` implementations the components need, holds the engine's
`Machine` value, and is the only place that drives `step()`. It runs behind the
narrow `RconSessionHost` interface — implemented by `cli.ts`, which is also the
process the VS Code `extension.ts` spawns as its integrated terminal.

```mermaid
classDiagram
    direction TB

    class RconSession {
        -connectionManager: RconConnectionManager
        -lineEditor: LineEditor
        -suggestionDisplay: SuggestionDisplay
        -commandTree: CommandTreeCrawler
        -historyStore: HistoryStore
        -historySearch: HistorySearchState
        -engine: Machine
        -rconBackend: CompletionBackend
        -localBackend: CompletionBackend
        -pluginMode: bool
        +completionBackend: CompletionBackend
        +open() void
        +handleInput(data) void
        +close() void
        -dispatchToEngine(event) void
        -executeEngineEffect(effect) void
        -handleEnter() void
        -executeCommand(command) Promise
        -handleTabComplete() void
        -initializeCommands(forceRefresh) Promise
    }

    class RconSessionHost {
        <<interface>>
        +write(text) void
        +close(exitCode) void
        +clipboard: Clipboard
        +cacheDir: string
        +dimensions() Dimensions
        +historySize?: number
        +disablePlugin?: bool
    }

    class BuiltinCommand {
        <<interface>>
        +name: string
        +description: string
    }

    class cli {
        <<cli.ts · implements RconSessionHost>>
        +main() Promise
    }
    class cliConfig {
        <<cliConfig.ts · pure>>
        +readConfig / writeConfig
        +resolveHost / resolvePort
        +resolvePassword / resolveHistorySize
        +resolveLogLevel
    }
    class extension {
        <<extension.ts · VS Code entry point>>
        +activate(context) void
        +deactivate() void
    }

    RconSession *-- RconConnectionManager
    RconSession *-- LineEditor
    RconSession *-- SuggestionDisplay
    RconSession *-- CommandTreeCrawler
    RconSession *-- HistoryStore
    RconSession o-- Machine : engine value
    RconSession --> CompletionBackend : rcon / local
    RconSession --> RconSessionHost
    RconSession ..> BuiltinCommand : "/help, /clear, …"
    RconSessionHost <|.. cli
    cli ..> RconSession : constructs & open()
    cli ..> cliConfig : resolve config
    extension ..> cli : spawns dist/minercon.js

    note for extension "No module-level dependency on RconSession — it runs the bundled cli.ts as the terminal process via shellPath/shellArgs."
```

---

## 6. Shared utilities

- **`ansi.ts`** — named SGR escape codes and `style`/colour helpers, plus
  `formatMinecraftColors` / `stripColors` (the `§`-code ↔ ANSI translation).
  Pure; imported almost everywhere in the UI and orchestration layers.
- **`logger.ts`** — just `errorMessage(err): string`. Logging itself is
  [consola](https://github.com/unjs/consola)'s `ConsolaInstance`, constructed in
  `cli.ts`/`extension.ts` and passed by reference to every class that logs.
- **`commandLine.ts`** — `splitCommandLine(input): CommandLineParts`
  (`{ parts, hasTrailingSpace }`), the shared tokenizer used by the engine and
  the suggestion logic.
- **`completionQueries.ts`** — pure `build*Query` / `parse*Response` helpers
  bridging engine input lines and the `tabcomplete`/`cmdusage` wire strings,
  used by `RconCompletionBackend`.

---

## 7. Sequence diagrams

### 7.1 Typing a character (local mode)

A keystroke flows down to the line editor, back up as a `lineChanged` event
into the engine, out as a `fetchCompletions` effect, into the local tree, and
finally back into the engine as a result that produces a `render` effect.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant S as RconSession
    participant LE as LineEditor
    participant Eng as completionEngine.step
    participant BE as LocalCompletionBackend
    participant CT as CommandTreeCrawler

    User->>S: handleInput("g")
    S->>LE: insertText("g")
    LE-->>S: host.onLineChanged("/g")
    S->>Eng: step(machine, {lineChanged})
    Eng-->>S: effects: [fetchCompletions(reqId, "/g")]
    S->>BE: fetchCompletions("/g")
    BE->>CT: getSuggestions("/g")
    CT-->>BE: SuggestionResult
    BE-->>S: ["gamemode", "gamerule", …]
    S->>Eng: step(machine, {completionsResult, reqId})
    Eng-->>S: effects: [render(items, sel, usage)]
    S->>S: executeEngineEffect(render)
    S-->>User: suggestion list painted
```

> In **plugin mode** the only change is the backend: `RconCompletionBackend`
> replaces steps 7–9, issuing `tabcomplete /g` over RCON instead of querying
> the local tree. `RconSession` is mode-blind — it holds whichever backend
> `pluginMode` selected.

### 7.2 Executing a command (Enter)

Built-ins are handled in-process via a lookup table; anything else is sent to
the server, then recorded in history.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant S as RconSession
    participant CM as RconConnectionManager
    participant Ctl as RconController
    participant P as RconProtocol

    User->>S: handleEnter()
    alt line is a "/" built-in
        S->>S: builtinLookup(name).run()
        S-->>User: built-in output
    else RCON command
        S->>S: executeCommand(cmd)
        S->>CM: controller
        CM-->>S: RconController
        S->>Ctl: send(cmd)
        Ctl->>Ctl: chain onto sendQueue
        Ctl->>P: send(cmd)
        P-->>Ctl: response (reassembled)
        Ctl-->>S: response text
        S->>S: formatMinecraftColors(response) + write
        S->>LE: pushHistory(cmd)
        S->>HS: historyStore.save(entries)
    end
```

### 7.3 Connection drop and auto-reconnect

A failed in-flight `send` tells the manager the connection is gone; it backs
off, rebuilds the controller, and on success asks the session to reload its
command tree.

```mermaid
sequenceDiagram
    autonumber
    participant S as RconSession
    participant CM as RconConnectionManager
    participant Ctl as RconController (old)
    participant New as RconController (new)

    S->>Ctl: send(cmd)
    Ctl-->>S: throws (socket closed)
    S->>CM: reportConnectionLost()
    Note over CM: _isConnected = false<br/>grace delay, then retry
    CM->>CM: attemptReconnect()
    CM->>New: controllerFactory(host, port, pw)
    CM->>New: connect()
    alt connect succeeds
        New-->>CM: ok
        CM->>S: host.onReconnected()
        S->>S: initializeCommands()
        Note over S: reload command tree / re-probe plugin
    else still failing
        Note over CM: exponential backoff<br/>1s → 32s, capped at 5 attempts
        CM->>CM: schedule next attemptReconnect()
    end
```

---

## 8. Completion-engine state machine

The shape behind `completionEngine.ts`. The visible **phase** is `closed` or
`open`; while open, a **mode** distinguishes live previewing from Tab-driven
cycling. Orthogonally, a **fetch** sub-state tracks the single in-flight request
and the newest line queued behind it — this is where every async race (a reply
landing after the user typed more, overlapping requests) is resolved as an
ordinary transition rather than ad-hoc guard code.

```mermaid
stateDiagram-v2
    [*] --> Closed

    state "phase: closed" as Closed
    state "phase: open" as Open {
        state "mode: preview" as Preview
        state "mode: cycling" as Cycling
        [*] --> Preview
        Preview --> Cycling : tab / shiftTab (applies a suggestion)
        Cycling --> Cycling : tab / shiftTab (advance)
        Cycling --> Preview : line edited away from applied text
    }

    Closed --> Open : lineChanged / tab (completions or usage to show)
    Open --> Closed : escape, or line no longer a command
    Cycling --> Closed : escape (restoreLine to pre-Tab query)

    note right of Open
        Orthogonal fetch sub-state (FetchState):
        idle ──fetch dispatched──▶ busy{requestId, forLine, queued}
        busy ──result for current reqId──▶ idle (apply) 
        busy ──newer line while busy──▶ stays busy, updates `queued`
        Stale results (reqId ≠ current) are dropped.
        usage: none → loading(forQuery) → ready(forQuery, text)
    end note
```

> The argument-hint behaviour layered on top of `usage` (when it appears,
> sticks, and is re-fetched) is specified story-by-story in
> [ARGUMENT_HINT_UX_STORIES.md](ARGUMENT_HINT_UX_STORIES.md).
