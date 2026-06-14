# Contributing to Minercon

## Development Setup

### Prerequisites
- Node.js 22+
- VS Code
- Git

### Getting Started

1. **Clone the repository**
   ```bash
   git clone https://github.com/xton/minercon.git
   cd minercon
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Compile TypeScript**
   ```bash
   npm run compile
   ```

4. **Run in development mode**
   - Open the project in VS Code
   - Press `F5` to launch Extension Development Host
   - A new VS Code window opens with the extension loaded

### Project Structure

```
minercon/
├── src/
│   ├── extension.ts            # VS Code extension entry point
│   ├── rconTerminal.ts         # vscode.Pseudoterminal adapter over RconSession
│   ├── cli.ts                  # Standalone CLI entry point
│   ├── cliConfig.ts            # CLI config resolution (flags/env/saved config)
│   ├── rconSession.ts          # Host-agnostic session orchestrator
│   ├── connectionManager.ts    # Connect/reconnect lifecycle, backoff
│   ├── rconClient.ts           # RconController — send queue over RconProtocol
│   ├── rconProtocol.ts         # RCON wire protocol, framing, fence packet
│   ├── localCommandTree.ts     # /help-crawl orchestration, command tree
│   ├── commandSuggestions.ts   # Pure suggestion generation from the tree
│   ├── commandTreeCache.ts     # On-disk command tree cache
│   ├── helpTextParsing.ts      # Pure Brigadier /help text → Parameter tree parsing
│   ├── bukkitHelpParsing.ts    # Pure Bukkit Description:/Usage:/Aliases: page parsing
│   ├── completionEngine.ts     # Pure tab-completion state machine
│   ├── completionsBackend.ts   # Plugin-mode vs local-mode completions seam
│   ├── argumentHint.ts         # Argument-hint formatting
│   ├── lineEditor.ts           # Input line: editing, cursor, history
│   ├── suggestionDisplay.ts    # Suggestion/argument-hint popup rendering
│   ├── historySearch.ts        # Ctrl+R reverse history search state
│   ├── historyStore.ts         # On-disk command history
│   ├── ansi.ts                 # ANSI styling + § color code helpers
│   └── logger.ts               # Logger interface (output channel/stderr/file)
├── src/test/                   # Unit tests (mocha, via vscode-test)
├── src/test/functional/        # Functional tests against a live server
├── paper-plugin/                # Paper server-side TabComplete plugin (paperweight-userdev, typed Brigadier)
├── spigot-plugin/               # Spigot server-side TabComplete plugin (reflection-based Brigadier access)
├── fabric-mod/                  # Fabric server-side TabComplete mod
├── docs/
│   ├── ARCHITECTURE.md         # Module-by-module tour + dependency diagram
│   └── TECHNICAL.md            # RCON protocol/fence packet deep dive
├── package.json                # Extension manifest
└── tsconfig.json               # TypeScript configuration
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for what each module is
responsible for and how they fit together.

## Making Changes

### Code Style
- Use TypeScript strict mode
- Follow existing code patterns
- Add JSDoc comments for public methods
- Keep functions focused and small

### Testing Your Changes

1. **Unit tests** (`npm test`) — runs the full mocha suite via `vscode-test`,
   including the record/replay RCON protocol harness, the line editor,
   completion engine, and command-tree parsing. This is the fast,
   no-server-needed feedback loop; run it before every commit.

2. **Functional tests** (`npm run test:functional`) — compile then run
   `src/test/functional/**` against a real Minecraft server (configured via
   env vars; see that directory). `test:functional:local` and
   `test:functional:plugin` isolate the local-mode (`--no-plugin`) and
   plugin-mode paths respectively — see "Local mode"/"Plugin mode" in
   [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#terminology).

3. **Manual Testing**
   - Connect to a test Minecraft server
   - Verify basic commands work
   - Test edge cases (large outputs, disconnections, hyphenated commands
     like `/titanium-rewards`)

4. **Debug Output**
   - VS Code: View → Output → Select "Minercon"
   - CLI: pass `--log-level debug` (or set `MCRCON_LOG_LEVEL=debug`) for
     per-command RCON send/recv logging (see `docs/TECHNICAL.md`)

### Submitting Changes

1. Create a feature branch
2. Make your changes
3. Test thoroughly
4. Commit with clear messages
5. Submit a pull request

## Architecture Overview

The interactive session lives in `RconSession` (`src/rconSession.ts`), which
is host-agnostic — `RconTerminal` (VS Code) and `cli.ts` (standalone CLI) are
both thin adapters over it. For a full module-by-module tour and a dependency
diagram, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### RCON Protocol Layer
The `RconProtocol`/`RconController` classes (`rconProtocol.ts`/`rconClient.ts`)
handle:
- Socket communication, connect/auth, packet encoding/decoding
- Fragmentation handling via the deferred fence packet (see `docs/TECHNICAL.md`)
- Serializing all sends through `RconController`'s send queue

Reconnection lifecycle (exponential backoff, recreating the controller) is
`ConnectionManager`'s job (`connectionManager.ts`).

### Session Orchestration
The `RconSession` class (`rconSession.ts`) provides:
- Key dispatch and built-in `/` commands
- Command history (`/history`, Ctrl+R search)
- Autocomplete orchestration via the completion engine
- Reconnect handling

### Local Command Tree
The `LocalCommandTree` class (`localCommandTree.ts`) manages:
- Command discovery via `/help` crawling (`helpTextParsing.ts`)
- Suggestion generation (`commandSuggestions.ts`)
- Cache management (`commandTreeCache.ts`)

## Common Development Tasks

### Adding a New Built-in Command
Add an entry to the array returned by `buildBuiltinCommands()` in
`rconSession.ts`:
```typescript
{
    name: '/your-command', description: 'What it does',
    run: () => this.handleYourCommand(),
}
```
This single table drives both `handleEnter`'s dispatch (via `builtinLookup`)
and the `/help` listing — no separate registration step needed. Use
`aliases: [...]` for alternate names that should dispatch but not appear in
`/help`.

### Modifying Autocomplete Behavior
See `helpTextParsing.ts` and `commandSuggestions.ts`:
- `parseHelpLines()` / `parseCommandHelp()` - How help output is parsed
- `getSuggestions()` - How suggestions are generated

### Changing Terminal Rendering
Edit `suggestionDisplay.ts`:
- `SuggestionDisplay.render()` - Suggestion list and argument-hint display

## Debugging Tips

- Set breakpoints in VS Code
- Use the injected `Logger` (`this.logger.debug(...)`, etc.) for logging —
  it's level-aware and works in both the extension (Output channel) and the
  CLI (stderr/file), unlike a direct `OutputChannel` reference
- Check the Extensions view for runtime errors
- Use Developer Tools (Help → Toggle Developer Tools)

## Questions?

Open an issue on GitHub or join the discussion!