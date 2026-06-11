# Contributing to Minercon

## Development Setup

### Prerequisites
- Node.js 14+ 
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
│   ├── extension.ts          # Extension entry point
│   ├── rconClient.ts         # RCON client wrapper
│   ├── rconProtocol.ts       # Custom RCON protocol implementation
│   ├── rconTerminal.ts       # Terminal interface
│   └── commandAutocomplete.ts # Command autocomplete system
├── package.json              # Extension manifest
└── tsconfig.json            # TypeScript configuration
```

## Making Changes

### Code Style
- Use TypeScript strict mode
- Follow existing code patterns
- Add JSDoc comments for public methods
- Keep functions focused and small

### Testing Your Changes

1. **Manual Testing**
   - Connect to a test Minecraft server
   - Verify basic commands work
   - Test edge cases (large outputs, disconnections)

2. **Common Test Commands**
   ```
   /help              # Tests fragmentation
   /status            # Tests player list parsing  
   /gamemode          # Tests autocomplete
   /titanium-rewards  # Tests hyphenated commands
   ```

3. **Debug Output**
   - View → Output → Select "Minercon"
   - Check for error messages and warnings

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
- Socket communication, connect/auth/reconnect
- Packet encoding/decoding
- Fragmentation handling
- Response accumulation

### Session Orchestration
The `RconSession` class (`rconSession.ts`) provides:
- Key dispatch and built-in `/` commands
- Command history (`/history`, Ctrl+R search)
- Autocomplete orchestration via the completion engine
- Reconnect handling

### Command Autocomplete
The `CommandAutocomplete` class (`commandAutocomplete.ts`) manages:
- Command discovery via `/help` crawling (`helpTextParsing.ts`)
- Suggestion generation (`commandSuggestions.ts`)
- Cache management (`commandTreeCache.ts`)

## Common Development Tasks

### Adding a New Built-in Command
Edit `rconSession.ts` in the `handleEnter()` method:
```typescript
} else if (command === '/your-command') {
    this.handleYourCommand();
}
```
Don't forget to add it to the `/help` listing too.

### Modifying Autocomplete Behavior
See `helpTextParsing.ts` and `commandSuggestions.ts`:
- `parseHelpLines()` / `parseCommandHelp()` - How help output is parsed
- `getSuggestions()` - How suggestions are generated

### Changing Terminal Rendering
Edit `suggestionDisplay.ts`:
- `SuggestionDisplay.render()` - Suggestion list and argument-hint display

## Debugging Tips

- Set breakpoints in VS Code
- Use `this.output.appendLine()` for debug logging
- Check the Extensions view for runtime errors
- Use Developer Tools (Help → Toggle Developer Tools)

## Questions?

Open an issue on GitHub or join the discussion!