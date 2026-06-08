// src/rconTerminal.ts
import * as vscode from 'vscode';
import { RconController } from './rconClient';
import { CommandAutocomplete } from './commandAutocomplete';
import { formatMinecraftColors } from './helpTextParsing';
import {
  Machine, Event as EngineEvent, Effect as EngineEffect,
  createMachine, step, applySuggestion,
} from './completionEngine';
import { CompletionsBackend, RconCompletionsBackend, LocalCompletionsBackend } from './completionsBackend';
import { LineEditor, LineEditorHost } from './lineEditor';
import { SuggestionDisplay } from './suggestionDisplay';
import { ConnectionManager } from './connectionManager';
import { Logger, errorMessage } from './logger';

export class RconTerminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  onDidWrite: vscode.Event<string> = this.writeEmitter.event;

  private closeEmitter = new vscode.EventEmitter<number>();
  onDidClose: vscode.Event<number> = this.closeEmitter.event;

  private connectionManager: ConnectionManager;
  private lineEditor: LineEditor;

  // Connection info for reconnection
  private host: string;
  private port: number;
  private password: string;
  private isExecutingCommand: boolean = false;

  // Autocomplete system
  private autocomplete: CommandAutocomplete;
  private suggestionDisplay: SuggestionDisplay;

  // Tab completion — server-side (RconTabComplete plugin) or local (command
  // tree built from `help` output) — is driven entirely by the pure
  // completionEngine state machine; see dispatchToEngine/executeEngineEffect
  // below. `pluginMode` selects which CompletionsBackend answers the engine's
  // fetchCompletions/fetchUsage effects — that's the *only* place either mode
  // is named. Everything downstream (dispatch, effect execution, rendering)
  // is mode-blind: the suggestion items/selection/usage are populated purely
  // from the machine's render/hide effects.
  private pluginMode: boolean = false;
  private engine: Machine = createMachine();
  private rconBackend: CompletionsBackend;
  private localBackend: CompletionsBackend;
  private get completionsBackend(): CompletionsBackend {
    return this.pluginMode ? this.rconBackend : this.localBackend;
  }

  // For handling terminal resize
  private lastCommandOutputLines: number = 0;

  // Extension context for caching
  private context: vscode.ExtensionContext;

  constructor(
    controller: RconController,
    host: string,
    port: number,
    password: string,
    logger: Logger,
    context: vscode.ExtensionContext
  ) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.context = context;

    this.connectionManager = new ConnectionManager(host, port, password, logger, controller, {
      write: (text) => this.writeEmitter.fire(text),
      showPrompt: () => this.showPrompt(),
      onReconnected: () => this.initializeCommands(),
    });

    // Initialize autocomplete with all required parameters
    this.autocomplete = new CommandAutocomplete(
      async (cmd) => {
        const result = await this.connectionManager.controller.send(cmd);
        return result ?? '';
      },
      logger,
      context,
      host,
      port
    );

    this.rconBackend = new RconCompletionsBackend(() => this.connectionManager.controller);
    this.localBackend = new LocalCompletionsBackend(this.autocomplete);

    this.suggestionDisplay = new SuggestionDisplay({
      write: (text) => this.writeEmitter.fire(text),
    });

    this.lineEditor = new LineEditor({
      write: (text) => this.writeEmitter.fire(text),
      promptText: () => {
        if (this.connectionManager.isReconnecting) { return '\x1b[33m[reconnecting]\x1b[0m > '; }
        if (!this.connectionManager.isConnected) { return '\x1b[31m[disconnected]\x1b[0m > '; }
        return '\x1b[32m>\x1b[0m ';
      },
      onLineChanged: (line) => this.dispatchToEngine({ kind: 'lineChanged', line }),
      beforeLineCleared: () => this.suggestionDisplay.clear(),
      consumeOutputArtifacts: () => {
        if (this.lastCommandOutputLines > 10) {
          this.lastCommandOutputLines = 0;
          return true;
        }
        return false;
      },
    });
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.writeWelcomeBanner();

    // Detect plugin or load command tree
    this.detectAndInitialize();

  }

  private writeWelcomeBanner(): void {
    this.writeEmitter.fire('\x1b[1;36mMinecraft RCON Terminal\x1b[0m\r\n');
    this.writeEmitter.fire('Connected to \x1b[33m' + this.host + ':' + this.port + '\x1b[0m\r\n\r\n');
    this.writeEmitter.fire('\x1b[2mUseful shortcuts:\x1b[0m\r\n');
    this.writeEmitter.fire('  \x1b[2mTab: Autocomplete commands\x1b[0m\r\n');
    this.writeEmitter.fire('  \x1b[2mCtrl+L: Clear screen  |  Ctrl+C: Cancel input\x1b[0m\r\n');
    this.writeEmitter.fire('  \x1b[2mUp/Down: Command history  |  Esc: Clear line\x1b[0m\r\n\r\n');
  }

  private async detectAndInitialize(): Promise<void> {
    try {
      const response = await this.connectionManager.controller.send('tabcomplete');
      if (response && response.includes('Returns tab completions for a partial command string')) {
        this.pluginMode = true;
        this.autocomplete.isReady = true;
        this.writeEmitter.fire('\r\n\x1b[32m✓ Server tab-complete plugin detected — using server-side completions\x1b[0m\r\n\r\n');
        this.showPrompt();
        return;
      }
    } catch {
      // probe failed, fall through to normal init
    }
    await this.initializeCommands();
  }

  private async initializeCommands(forceRefresh: boolean = false): Promise<void> {
    const cacheInfo = this.autocomplete.getCacheInfo();
    
    // Determine if we'll be loading from cache
    const willLoadFromCache = !forceRefresh && cacheInfo.exists;
    
    if (!willLoadFromCache) {
      const reason = forceRefresh ? 'Forcing refresh...' : 
                     !cacheInfo.exists ? 'No cache found...' : 
                     'Cache outdated...';
      this.writeEmitter.fire('\r\n\x1b[33mLoading server commands (' + reason + ')\x1b[0m\r\n');
    }
    
    try {
      await this.autocomplete.initialize((progress, message) => {
        // If loading from cache, just show the success message when complete
        if (willLoadFromCache) {
          if (progress >= 100) {
            this.writeEmitter.fire('\r\n\x1b[32m✓ Commands loaded from cache!\x1b[0m\r\n\r\n');
            this.showPrompt();
          }
          return; // Skip all progress bar rendering
        }
        
        // Only show progress bar when NOT loading from cache
        // Clear previous line
        this.writeEmitter.fire('\r\x1b[K');
        
        // Draw progress bar
        const barWidth = 30;
        const filled = Math.round((progress / 100) * barWidth);
        const empty = barWidth - filled;
        
        let progressBar = '\x1b[33m[';
        progressBar += '█'.repeat(filled);
        progressBar += '░'.repeat(empty);
        progressBar += '] ';
        progressBar += Math.round(progress) + '%\x1b[0m';
        
        // Show current phase in gray
        let phase = '';
        if (message.includes('Fetching')) {
          phase = ' Fetching commands...';
        } else if (message.includes('Loading')) {
          phase = ' Processing subcommands...';
        } else if (message.includes('Complete') || message.includes('loaded')) {
          phase = ' Complete!';
        }
        
        this.writeEmitter.fire(progressBar + '\x1b[90m' + phase + '\x1b[0m');
        
        if (progress >= 100) {
          this.writeEmitter.fire('\r\n');
          this.writeEmitter.fire('\x1b[32m✓ Commands loaded and cached!\x1b[0m\r\n\r\n');
          this.showPrompt();
        }
      }, forceRefresh);
    } catch (error) {
      this.writeEmitter.fire('\r\n\x1b[31m✗ Failed to load commands: ' + error + '\x1b[0m\r\n');
      this.writeEmitter.fire('\x1b[33mAutocomplete will be limited.\x1b[0m\r\n\r\n');
      this.showPrompt();
    }
  }


  close(): void {
    this.connectionManager.dispose();
  }

  private showPrompt(): void {
    if (this.isExecutingCommand) {
      return; // Don't show prompt while executing
    }

    if (this.connectionManager.isReconnecting) {
      this.writeEmitter.fire('\x1b[33m[reconnecting]\x1b[0m > ');
    } else if (!this.connectionManager.isConnected) {
      this.writeEmitter.fire('\x1b[31m[disconnected]\x1b[0m > ');
    } else {
      this.writeEmitter.fire('\x1b[32m>\x1b[0m ');
    }
  }

  private readonly keyHandlers = this.buildKeyHandlers();

  private buildKeyHandlers(): Map<string, () => void> {
    // NOTE: this map is built once, as a class-field initializer — which runs
    // *before* the constructor body assigns `this.lineEditor` (field
    // initializers always run before constructor-body statements, regardless
    // of declaration order in the source). So handlers must look up
    // `this.lineEditor` lazily at call time rather than capturing it into a
    // local here — capturing would freeze every line-editor binding on
    // `undefined` and throw as soon as one of these handlers is invoked.
    const bindings: { sequences: string[]; handler: () => void }[] = [
      { sequences: ['\t'],                                handler: () => this.handleTabComplete() },
      { sequences: ['\x1b[Z'],                            handler: () => this.handleShiftTab() },
      { sequences: ['\x1b'],                              handler: () => this.handleEscape() },
      { sequences: ['\x04'],                              handler: () => this.connectionManager.disconnect() },
      { sequences: ['\x03'],                              handler: () => this.handleCtrlC() },
      { sequences: ['\x18'],                              handler: () => this.handleCut() },
      { sequences: ['\x16', '\x19'],                      handler: () => this.handlePaste() },
      { sequences: ['\x0c'],                              handler: () => this.handleClearScreen() },
      { sequences: ['\x1b[A', '\x10'],                    handler: () => this.handleHistoryOrSuggestionArrow('up') },
      { sequences: ['\x1b[B', '\x0e'],                    handler: () => this.handleHistoryOrSuggestionArrow('down') },
      { sequences: ['\x1b[5~'],                           handler: () => this.handlePagePrevious() },
      { sequences: ['\x1b[6~'],                           handler: () => this.handlePageNext() },
      { sequences: ['\x1b[1;2D'],                         handler: () => this.lineEditor.selectLeft() },
      { sequences: ['\x1b[1;2C'],                         handler: () => this.lineEditor.selectRight() },
      { sequences: ['\x1b[1;5D', '\x1b[5D', '\x1bb'],     handler: () => this.lineEditor.moveWordLeft() },
      { sequences: ['\x1b[1;5C', '\x1b[5C', '\x1bf'],     handler: () => this.lineEditor.moveWordRight() },
      { sequences: ['\x1b[1;6D'],                         handler: () => this.lineEditor.selectWordLeft() },
      { sequences: ['\x1b[1;6C'],                         handler: () => this.lineEditor.selectWordRight() },
      { sequences: ['\x1b[1;2H', '\x1b[1;2~'],            handler: () => this.lineEditor.selectToStart() },
      { sequences: ['\x1b[1;2F', '\x1b[1;2$'],            handler: () => this.lineEditor.selectToEnd() },
      { sequences: ['\x1b[D', '\x02'],                    handler: () => this.lineEditor.moveLeft() },
      { sequences: ['\x1b[C', '\x06'],                    handler: () => this.lineEditor.moveRight() },
      { sequences: ['\x1b[H', '\x1bOH', '\x1b[1~', '\x01'], handler: () => this.lineEditor.moveToStart() },
      { sequences: ['\x1b[F', '\x1bOF', '\x1b[4~', '\x05'], handler: () => this.lineEditor.moveToEnd() },
      { sequences: ['\x1b[3~'],                           handler: () => this.lineEditor.deleteForward() },
      { sequences: ['\x0b'],                              handler: () => this.lineEditor.killToEnd() },
      { sequences: ['\x15'],                              handler: () => this.lineEditor.killToStart() },
      { sequences: ['\x17', '\x1b\x7f', '\x1b\b'],        handler: () => this.lineEditor.killWordBack() },
      { sequences: ['\x1bd'],                             handler: () => this.lineEditor.killWordForward() },
      { sequences: ['\x14'],                              handler: () => this.lineEditor.transposeChars() },
      { sequences: ['\r', '\n'],                          handler: () => this.handleEnter() },
      { sequences: ['\x7f', '\b'],                        handler: () => this.lineEditor.handleBackspace() },
    ];

    const map = new Map<string, () => void>();
    for (const { sequences, handler } of bindings) {
      for (const seq of sequences) {
        map.set(seq, handler);
      }
    }
    return map;
  }

  handleInput(data: string): void {
    // Prevent input during command execution
    if (this.isExecutingCommand) {
      return;
    }

    const handler = this.keyHandlers.get(data);
    if (handler) {
      handler();
      return;
    }

    // Ignore other control characters except tab
    if (data.charCodeAt(0) < 32 && data !== '\t') {
      return;
    }

    // Regular character input
    this.lineEditor.insertText(data);
  }

  // Escape: cancel autocomplete, or clear the line
  private handleEscape(): void {
    if (this.suggestionDisplay.isShowing) {
      this.dispatchToEngine({ kind: 'escape' });
      return;
    }
    this.lineEditor.clearAndReset();
    this.showPrompt();
  }

  // Ctrl+C: copy selected text, or cancel current input
  private handleCtrlC(): void {
    if (this.lineEditor.hasSelection()) {
      vscode.env.clipboard.writeText(this.lineEditor.getSelectedText());
      this.lineEditor.clearSelection();
      this.lineEditor.redraw();
    } else if (this.lineEditor.line.length > 0) {
      this.writeEmitter.fire('^C\r\n');
      this.lineEditor.clearAndReset();
      this.showPrompt();
    }
  }

  // Ctrl+X: cut selected text
  private handleCut(): void {
    if (!this.lineEditor.hasSelection()) {
      return;
    }
    vscode.env.clipboard.writeText(this.lineEditor.getSelectedText());
    this.lineEditor.deleteSelection();
    this.lineEditor.redraw();
  }

  // Ctrl+V / Ctrl+Y (paste — Ctrl+Y is the emacs/readline "yank" binding;
  // we don't maintain a separate kill-ring, so both pull from the system
  // clipboard, which is the more useful behavior in an editor-hosted terminal)
  private handlePaste(): void {
    vscode.env.clipboard.readText().then(text => {
      if (text) {
        this.lineEditor.insertText(text);
      }
    });
  }

  // Ctrl+L: clear screen and redraw the banner, prompt, and current line
  private handleClearScreen(): void {
    this.writeEmitter.fire('\x1b[2J\x1b[H');
    this.writeWelcomeBanner();
    this.showPrompt();
    this.writeEmitter.fire(this.lineEditor.line);
    if (this.lineEditor.cursor < this.lineEditor.line.length) {
      const moveBack = this.lineEditor.line.length - this.lineEditor.cursor;
      this.writeEmitter.fire('\x1b[' + moveBack + 'D');
    }
  }

  // Up/Down (and Ctrl+P/Ctrl+N): navigate suggestions if showing, else command history
  private handleHistoryOrSuggestionArrow(direction: 'up' | 'down'): void {
    if (this.suggestionDisplay.isShowing) {
      this.dispatchToEngine({ kind: 'arrow', direction });
      return;
    }
    if (this.lineEditor.hasSelection()) {
      this.lineEditor.clearSelection();
      this.lineEditor.redraw();
    }
    this.lineEditor.navigateHistory(direction);
  }

  private handlePagePrevious(): void {
    const i = this.suggestionDisplay.previousPageIndex();
    if (i !== null) {
      this.dispatchToEngine({ kind: 'selectIndex', index: i });
    }
  }

  private handlePageNext(): void {
    const i = this.suggestionDisplay.nextPageIndex();
    if (i !== null) {
      this.dispatchToEngine({ kind: 'selectIndex', index: i });
    }
  }


  // ── tab completion: drive the pure completionEngine state machine ──
  //
  // dispatchToEngine feeds an event through the reducer, adopts the resulting
  // machine state, and executes whatever Effects come back. Everything that
  // used to be scattered mutable-flag bookkeeping (isLoadingCompletions,
  // tabMode, lastTabTime, originalInput, staleness checks against currentLine,
  // commandArgumentCache, ...) now lives in completionEngine.ts as a pure,
  // testable reducer — this is just the imperative shell that runs its effects.

  private dispatchToEngine(event: EngineEvent): void {
    const { machine, effects } = step(this.engine, event);
    this.engine = machine;
    for (const effect of effects) {
      this.executeEngineEffect(effect);
    }
  }

  private executeEngineEffect(effect: EngineEffect): void {
    switch (effect.kind) {
      case 'fetchCompletions':
        this.runEngineCompletionsFetch(effect.requestId);
        break;
      case 'fetchUsage':
        this.runEngineUsageFetch(effect.requestId);
        break;
      case 'applySuggestion': {
        const query = this.engine.phase.kind === 'open' ? this.engine.phase.query : this.lineEditor.line;
        this.applySuggestionText(query, effect.text);
        break;
      }
      case 'render':
        // `effect.usage` is only ever a single, resolved usage line — the
        // engine (parseUsageResponse) already collapses "(too broad...)"
        // failures *and* multi-candidate ambiguous-prefix responses (e.g.
        // "mvp c" matching both "mvp create" and "mvp config") down to empty,
        // so a non-null usage here means the command portion is fully
        // resolved. That's true independent of how many *argument*-level
        // completions remain — so `SuggestionDisplay.render` shows it
        // alongside the list whenever it's available, not just when the list
        // itself has narrowed to one item.
        this.suggestionDisplay.render(effect.items, effect.selectedIndex, effect.usage, this.lineEditor.line);
        break;
      case 'hide':
        this.suggestionDisplay.hide();
        break;
      case 'restoreLine':
        this.lineEditor.replaceLine(effect.text);
        break;
    }
  }

  // The engine guarantees at most one completions fetch and one usage fetch
  // is outstanding at a time (that's what makes RCON-serialization safe), so
  // we can fire-and-forget through whichever backend is current and feed the
  // result back in as an event — the requestId pairs it to whatever request
  // is still current by the time it resolves, so stale answers are ignored.
  // `forLine` (not `effect.query`, which is backend-specific wire format) is
  // the raw input line both backends actually need.
  private async runEngineCompletionsFetch(requestId: number): Promise<void> {
    const line = this.engine.fetch.kind === 'busy' ? this.engine.fetch.forLine : this.lineEditor.line;
    let items: string[] = [];
    try {
      items = await this.completionsBackend.fetchCompletions(line);
    } catch {
      items = [];
    }
    this.dispatchToEngine({ kind: 'completionsResult', requestId, items, now: Date.now() });
  }

  private async runEngineUsageFetch(requestId: number): Promise<void> {
    const line = this.engine.fetch.kind === 'busy' ? this.engine.fetch.forLine : this.lineEditor.line;
    let text = '';
    try {
      text = await this.completionsBackend.fetchUsage(line);
    } catch {
      text = '';
    }
    this.dispatchToEngine({ kind: 'usageResult', requestId, text });
  }

  // Reconciles a raw completion candidate against what's typed so far and
  // pushes the result into the line — see `applySuggestion` (completionEngine.ts)
  // for the splicing rules and why naive "replace the last word" guessing
  // doesn't hold up against selector/NBT syntax.
  private applySuggestionText(query: string, suggestionText: string): void {
    this.lineEditor.replaceLine(applySuggestion(query, suggestionText));
  }

  private handleTabComplete(): void {
    this.dispatchToEngine({ kind: 'tab', line: this.lineEditor.line, now: Date.now() });
  }

  private handleShiftTab(): void {
    this.dispatchToEngine({ kind: 'shiftTab', line: this.lineEditor.line, now: Date.now() });
  }

  private handleEnter(): void {
    // Clear suggestions and argument display before processing
    if (this.suggestionDisplay.isShowing) {
      this.suggestionDisplay.hide();
    }
    this.suggestionDisplay.clear();

    this.writeEmitter.fire('\r\n');

    const command = this.lineEditor.line.trim();

    // Clear current line state — pure reset (no redraw: we just printed our
    // own \r\n, so a redraw here would draw a duplicate/misplaced prompt)
    this.lineEditor.resetLine();
    this.lineEditor.resetHistoryCursor();
    this.dispatchToEngine({ kind: 'lineChanged', line: '' });

    if (command) {
      // Handle special commands
      if (command === '/reconnect') {
        this.connectionManager.manualReconnect();
      } else if (command === '/disconnect') {
        this.connectionManager.disconnect();
      } else if (command === '/clear') {
        this.writeEmitter.fire('\x1b[2J\x1b[H');
        this.showPrompt();
      } else if (command === '/help') {
        this.showHelp();
      } else if (command === '/reload-commands' || command === '/refresh-commands') {
        if (this.pluginMode) {
          this.writeEmitter.fire('\x1b[33mUsing server-side tab completion — no command cache to reload.\x1b[0m\r\n\r\n');
          this.showPrompt();
        } else {
          this.initializeCommands(true); // Force refresh
        }
      } else if (command === '/clear-cache') {
        if (this.pluginMode) {
          this.writeEmitter.fire('\x1b[33mUsing server-side tab completion — no cache.\x1b[0m\r\n\r\n');
          this.showPrompt();
        } else {
          this.autocomplete.clearCache();
          this.writeEmitter.fire('\x1b[33mCommand cache cleared.\x1b[0m\r\n\r\n');
          this.showPrompt();
        }
      } else if (command === '/cache-info') {
        if (this.pluginMode) {
          this.writeEmitter.fire('\x1b[33mUsing server-side tab completion — no cache.\x1b[0m\r\n\r\n');
          this.showPrompt();
        } else {
          const info = this.autocomplete.getCacheInfo();
          if (info.exists) {
            this.writeEmitter.fire('\x1b[36mCache Status:\x1b[0m\r\n');
            this.writeEmitter.fire('  Age: ' + info.age + '\r\n');
            this.writeEmitter.fire('  Last updated: ' + info.lastUpdated?.toLocaleString() + '\r\n\r\n');
          } else {
            this.writeEmitter.fire('\x1b[33mNo cache found.\x1b[0m\r\n\r\n');
          }
          this.showPrompt();
        }
      } else {
        this.lineEditor.pushHistory(command);
        this.executeCommand(command);
      }
    } else {
      this.showPrompt();
    }
  }

  private showHelp(): void {
    this.writeEmitter.fire('\x1b[1;36mBuilt-in Commands:\x1b[0m\r\n');
    this.writeEmitter.fire('  \x1b[33m/help\x1b[0m - Show this help message\r\n');
    this.writeEmitter.fire('  \x1b[33m/clear\x1b[0m - Clear the terminal screen\r\n');
    this.writeEmitter.fire('  \x1b[33m/reconnect\x1b[0m - Reconnect to the server\r\n');
    this.writeEmitter.fire('  \x1b[33m/disconnect\x1b[0m - Disconnect from the server\r\n');
    this.writeEmitter.fire('  \x1b[33m/reload-commands\x1b[0m - Force reload command database from server\r\n');
    this.writeEmitter.fire('  \x1b[33m/clear-cache\x1b[0m - Clear cached command database\r\n');
    this.writeEmitter.fire('  \x1b[33m/cache-info\x1b[0m - Show command cache information\r\n');
    this.writeEmitter.fire('\r\n');
    this.writeEmitter.fire('\x1b[1;36mKeyboard Shortcuts:\x1b[0m\r\n');
    this.writeEmitter.fire('  \x1b[2mTab - Autocomplete commands and cycle suggestions\x1b[0m\r\n');
    this.writeEmitter.fire('  \x1b[2mUp/Down or Ctrl+P/Ctrl+N - Navigate command history\x1b[0m\r\n');
    this.writeEmitter.fire('  \x1b[2mCtrl+A/Ctrl+E - Start/end of line  |  Ctrl+B/Ctrl+F - Move by character\x1b[0m\r\n');
    this.writeEmitter.fire('  \x1b[2mAlt+B/Alt+F - Move by word  |  Ctrl+T - Transpose characters\x1b[0m\r\n');
    this.writeEmitter.fire('  \x1b[2mCtrl+K - Kill to end of line  |  Ctrl+U - Kill to start of line\x1b[0m\r\n');
    this.writeEmitter.fire('  \x1b[2mCtrl+W/Alt+Backspace - Delete word back  |  Alt+D - Delete word forward\x1b[0m\r\n');
    this.writeEmitter.fire('  \x1b[2mCtrl+Y - Paste (yank)  |  Ctrl+L - Clear screen  |  Esc - Clear current line\x1b[0m\r\n');
    this.writeEmitter.fire('  \x1b[2mCtrl+C - Cancel input  |  Ctrl+D - Disconnect\x1b[0m\r\n');
    this.writeEmitter.fire('\r\n');
    this.showPrompt();
  }

  // UPDATED: Track output in executeCommand method
  private async executeCommand(command: string): Promise<void> {
    if (this.connectionManager.isReconnecting) {
      this.writeEmitter.fire('\x1b[33mReconnecting... Please wait.\x1b[0m\r\n\r\n');
      this.showPrompt();
      return;
    }

    if (!this.connectionManager.isConnected) {
      this.writeEmitter.fire('\x1b[31mNot connected. Type \x1b[33m/reconnect\x1b[0m to reconnect.\x1b[0m\r\n\r\n');
      this.showPrompt();
      return;
    }

    this.isExecutingCommand = true;
    
    // NEW: Track output lines for rendering management
    let outputLineCount = 0;

    try {
      const response = await this.connectionManager.controller.send(command);
      
      if (response && response.trim()) {
        // Apply Minecraft color codes
        const formatted = formatMinecraftColors(response);
        const lines = formatted.split('\n');
        outputLineCount = lines.length;
        
        lines.forEach(line => {
          this.writeEmitter.fire(`${line}\r\n`);
        });
      } else {
        this.writeEmitter.fire('\x1b[2m(no response)\x1b[0m\r\n');
        outputLineCount = 1;
      }
      
      this.writeEmitter.fire('\r\n');
      outputLineCount++; // For the extra newline
      
    } catch (err) {
      const message = errorMessage(err);
      this.writeEmitter.fire(`\x1b[31mError: ${message}\x1b[0m\r\n`);
      outputLineCount = 1;

      const errorMsg = message.toLowerCase();
      if (errorMsg.includes('econnreset') || 
          errorMsg.includes('econnrefused') ||
          errorMsg.includes('epipe') ||
          errorMsg.includes('not connected') ||
          errorMsg.includes('connection closed') ||
          errorMsg.includes('socket') ||
          errorMsg.includes('timeout')) {
        
        this.writeEmitter.fire('\x1b[33m⚠  Connection lost. Auto-reconnecting...\x1b[0m\r\n');
        outputLineCount++;

        this.connectionManager.reportConnectionLost();
      } else {
        this.writeEmitter.fire('\r\n');
        outputLineCount++;
      }
    } finally {
      // NEW: Store output lines and set flag if output was large
      this.lastCommandOutputLines = outputLineCount;
      if (outputLineCount > 10) {
        this.suggestionDisplay.markNeedsClearOnNextRender();
      }
      
      this.isExecutingCommand = false;
      this.showPrompt();
    }
  }
}