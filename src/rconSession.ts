// src/rconSession.ts
//
// Host-agnostic RCON session orchestrator. Contains all interactive-terminal
// logic (key dispatch, tab completion, command routing, reconnect handling)
// behind a narrow `RconSessionHost` seam whose only hard requirement is a
// function that writes ANSI text to a terminal-shaped output stream.
//
// Two implementations of the host exist:
//   - `RconTerminal` (rconTerminal.ts) — wraps vscode.Pseudoterminal
//   - the CLI adapter (cli.ts) — wraps process.stdout / raw-mode stdin

import { RconController } from './rconClient';
import { CommandAutocomplete } from './commandAutocomplete';
import { formatMinecraftColors } from './helpTextParsing';
import {
  Machine, Event as EngineEvent, Effect as EngineEffect,
  createMachine, step, applySuggestion,
} from './completionEngine';
import { CompletionsBackend, RconCompletionsBackend, LocalCompletionsBackend } from './completionsBackend';
import { LineEditor } from './lineEditor';
import { SuggestionDisplay } from './suggestionDisplay';
import { ConnectionManager } from './connectionManager';
import { Logger, errorMessage } from './logger';

export interface RconSessionHost {
  write(text: string): void;
  close(exitCode: number): void;
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  cacheDir: string;
  dimensions(): { columns: number; rows: number } | undefined;
}

export class RconSession {
  private connectionManager: ConnectionManager;
  private lineEditor: LineEditor;

  private readonly serverHost: string;
  private readonly serverPort: number;
  private isExecutingCommand: boolean = false;

  private autocomplete: CommandAutocomplete;
  private suggestionDisplay: SuggestionDisplay;

  private pluginMode: boolean = false;
  private engine: Machine = createMachine();
  private rconBackend: CompletionsBackend;
  private localBackend: CompletionsBackend;
  private get completionsBackend(): CompletionsBackend {
    return this.pluginMode ? this.rconBackend : this.localBackend;
  }

  private lastCommandOutputLines: number = 0;

  constructor(
    controller: RconController,
    host: string,
    port: number,
    password: string,
    logger: Logger,
    private readonly sessionHost: RconSessionHost
  ) {
    this.serverHost = host;
    this.serverPort = port;

    this.connectionManager = new ConnectionManager(host, port, password, logger, controller, {
      write: (text) => sessionHost.write(text),
      showPrompt: () => this.showPrompt(),
      onReconnected: () => this.initializeCommands(),
    });

    this.autocomplete = new CommandAutocomplete(
      async (cmd) => {
        const result = await this.connectionManager.controller.send(cmd);
        return result ?? '';
      },
      logger,
      sessionHost.cacheDir,
      host,
      port
    );

    this.rconBackend = new RconCompletionsBackend(() => this.connectionManager.controller);
    this.localBackend = new LocalCompletionsBackend(this.autocomplete);

    this.suggestionDisplay = new SuggestionDisplay({
      write: (text) => sessionHost.write(text),
      cursorColumn: () => {
        // Visual width of the prompt (ANSI codes stripped) plus cursor position
        // within the typed text — gives the terminal column the cursor sits on.
        const promptText = this.connectionManager.isReconnecting
          ? '\x1b[33m[reconnecting]\x1b[0m > '
          : this.connectionManager.isConnected
          ? '\x1b[32m>\x1b[0m '
          : '\x1b[31m[disconnected]\x1b[0m > ';
        const promptWidth = promptText.replace(/\x1b\[[0-9;]*m/g, '').length;
        return promptWidth + this.lineEditor.cursor;
      },
    });

    this.lineEditor = new LineEditor({
      write: (text) => sessionHost.write(text),
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

  open(_dimensions: { columns: number; rows: number } | undefined): void {
    this.writeWelcomeBanner();
    this.detectAndInitialize();
  }

  private writeWelcomeBanner(): void {
    this.sessionHost.write('\x1b[1;36mMinercon Terminal\x1b[0m\r\n');
    this.sessionHost.write('Connected to \x1b[33m' + this.serverHost + ':' + this.serverPort + '\x1b[0m\r\n\r\n');
    this.sessionHost.write('\x1b[2mUseful shortcuts:\x1b[0m\r\n');
    this.sessionHost.write('  \x1b[2mTab: Autocomplete commands\x1b[0m\r\n');
    this.sessionHost.write('  \x1b[2mCtrl+L: Clear screen  |  Ctrl+C: Cancel input\x1b[0m\r\n');
    this.sessionHost.write('  \x1b[2mUp/Down: Command history  |  Esc: Clear line\x1b[0m\r\n\r\n');
  }

  private async detectAndInitialize(): Promise<void> {
    try {
      const response = await this.connectionManager.controller.send('tabcomplete');
      if (response && response.includes('Returns tab completions for a partial command string')) {
        this.pluginMode = true;
        this.autocomplete.isReady = true;
        this.sessionHost.write('\r\n\x1b[32m✓ Server tab-complete plugin detected — using server-side completions\x1b[0m\r\n\r\n');
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
    const willLoadFromCache = !forceRefresh && cacheInfo.exists;

    if (!willLoadFromCache) {
      const reason = forceRefresh ? 'Forcing refresh...' :
                     !cacheInfo.exists ? 'No cache found...' :
                     'Cache outdated...';
      this.sessionHost.write('\r\n\x1b[33mLoading server commands (' + reason + ')\x1b[0m\r\n');
    }

    try {
      await this.autocomplete.initialize((progress, message) => {
        if (willLoadFromCache) {
          if (progress >= 100) {
            this.sessionHost.write('\r\n\x1b[32m✓ Commands loaded from cache!\x1b[0m\r\n\r\n');
            this.showPrompt();
          }
          return;
        }

        this.sessionHost.write('\r\x1b[K');

        const barWidth = 30;
        const filled = Math.round((progress / 100) * barWidth);
        const empty = barWidth - filled;

        let progressBar = '\x1b[33m[';
        progressBar += '█'.repeat(filled);
        progressBar += '░'.repeat(empty);
        progressBar += '] ';
        progressBar += Math.round(progress) + '%\x1b[0m';

        let phase = '';
        if (message.includes('Fetching')) {
          phase = ' Fetching commands...';
        } else if (message.includes('Loading')) {
          phase = ' Processing subcommands...';
        } else if (message.includes('Complete') || message.includes('loaded')) {
          phase = ' Complete!';
        }

        this.sessionHost.write(progressBar + '\x1b[90m' + phase + '\x1b[0m');

        if (progress >= 100) {
          this.sessionHost.write('\r\n');
          this.sessionHost.write('\x1b[32m✓ Commands loaded and cached!\x1b[0m\r\n\r\n');
          this.showPrompt();
        }
      }, forceRefresh);
    } catch (error) {
      this.sessionHost.write('\r\n\x1b[31m✗ Failed to load commands: ' + error + '\x1b[0m\r\n');
      this.sessionHost.write('\x1b[33mAutocomplete will be limited.\x1b[0m\r\n\r\n');
      this.showPrompt();
    }
  }

  close(): void {
    this.connectionManager.dispose();
  }

  private showPrompt(): void {
    if (this.isExecutingCommand) {
      return;
    }

    if (this.connectionManager.isReconnecting) {
      this.sessionHost.write('\x1b[33m[reconnecting]\x1b[0m > ');
    } else if (!this.connectionManager.isConnected) {
      this.sessionHost.write('\x1b[31m[disconnected]\x1b[0m > ');
    } else {
      this.sessionHost.write('\x1b[32m>\x1b[0m ');
    }
  }

  private readonly keyHandlers = this.buildKeyHandlers();

  private buildKeyHandlers(): Map<string, () => void> {
    // NOTE: built once as a class-field initializer — before the constructor
    // body assigns this.lineEditor — so handlers must look up this.lineEditor
    // lazily at call time, not capture it here.
    const bindings: { sequences: string[]; handler: () => void }[] = [
      { sequences: ['\t'],                                handler: () => this.handleTabComplete() },
      { sequences: ['\x1b[Z'],                            handler: () => this.handleShiftTab() },
      { sequences: ['\x1b'],                              handler: () => this.handleEscape() },
      { sequences: ['\x04'],                              handler: () => this.handleCtrlD() },
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
      { sequences: ['\x0b'],                              handler: () => this.killAndStash(() => this.lineEditor.killToEnd()) },
      { sequences: ['\x15'],                              handler: () => this.killAndStash(() => this.lineEditor.killToStart()) },
      { sequences: ['\x17', '\x1b\x7f', '\x1b\b'],        handler: () => this.killAndStash(() => this.lineEditor.killWordBack()) },
      { sequences: ['\x1bd'],                             handler: () => this.killAndStash(() => this.lineEditor.killWordForward()) },
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

  private killAndStash(fn: () => string): void {
    const text = fn();
    if (text) { this.sessionHost.clipboard.writeText(text); }
  }

  handleInput(data: string): void {
    if (this.isExecutingCommand) {
      return;
    }

    const handler = this.keyHandlers.get(data);
    if (handler) {
      handler();
      return;
    }

    if (data.charCodeAt(0) < 32 && data !== '\t') {
      return;
    }

    this.lineEditor.insertText(data);
  }

  private handleEscape(): void {
    if (this.suggestionDisplay.isShowing) {
      this.dispatchToEngine({ kind: 'escape' });
      return;
    }
    this.lineEditor.clearAndReset();
    this.showPrompt();
  }

  private handleCtrlD(): void {
    this.sessionHost.write('^D\r\n');
    this.sessionHost.write('Disconnecting...\r\n');
    this.sessionHost.close(0);
  }

  private handleCtrlC(): void {
    if (this.lineEditor.hasSelection()) {
      this.sessionHost.clipboard.writeText(this.lineEditor.getSelectedText());
      this.lineEditor.clearSelection();
      this.lineEditor.redraw();
    } else if (this.lineEditor.line.length > 0) {
      this.sessionHost.write('^C\r\n');
      this.lineEditor.clearAndReset();
      this.showPrompt();
    }
  }

  private handleCut(): void {
    if (!this.lineEditor.hasSelection()) {
      return;
    }
    this.sessionHost.clipboard.writeText(this.lineEditor.getSelectedText());
    this.lineEditor.deleteSelection();
    this.lineEditor.redraw();
  }

  private handlePaste(): void {
    this.sessionHost.clipboard.readText().then(text => {
      if (text) {
        this.lineEditor.insertText(text);
      }
    });
  }

  private handleClearScreen(): void {
    this.sessionHost.write('\x1b[2J\x1b[H');
    this.writeWelcomeBanner();
    this.showPrompt();
    this.sessionHost.write(this.lineEditor.line);
    if (this.lineEditor.cursor < this.lineEditor.line.length) {
      const moveBack = this.lineEditor.line.length - this.lineEditor.cursor;
      this.sessionHost.write('\x1b[' + moveBack + 'D');
    }
  }

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
    if (this.suggestionDisplay.isShowing) {
      this.suggestionDisplay.hide();
    }
    this.suggestionDisplay.clear();

    this.sessionHost.write('\r\n');

    const command = this.lineEditor.line.trim();

    this.lineEditor.resetLine();
    this.lineEditor.resetHistoryCursor();
    this.dispatchToEngine({ kind: 'lineChanged', line: '' });

    if (command) {
      if (command === '/reconnect') {
        this.connectionManager.manualReconnect();
      } else if (command === '/disconnect') {
        this.connectionManager.disconnect();
      } else if (command === '/clear') {
        this.sessionHost.write('\x1b[2J\x1b[H');
        this.showPrompt();
      } else if (command === '/help') {
        this.showHelp();
      } else if (command === '/reload-commands' || command === '/refresh-commands') {
        if (this.pluginMode) {
          this.sessionHost.write('\x1b[33mUsing server-side tab completion — no command cache to reload.\x1b[0m\r\n\r\n');
          this.showPrompt();
        } else {
          this.initializeCommands(true);
        }
      } else if (command === '/clear-cache') {
        if (this.pluginMode) {
          this.sessionHost.write('\x1b[33mUsing server-side tab completion — no cache.\x1b[0m\r\n\r\n');
          this.showPrompt();
        } else {
          this.autocomplete.clearCache();
          this.sessionHost.write('\x1b[33mCommand cache cleared.\x1b[0m\r\n\r\n');
          this.showPrompt();
        }
      } else if (command === '/cache-info') {
        if (this.pluginMode) {
          this.sessionHost.write('\x1b[33mUsing server-side tab completion — no cache.\x1b[0m\r\n\r\n');
          this.showPrompt();
        } else {
          const info = this.autocomplete.getCacheInfo();
          if (info.exists) {
            this.sessionHost.write('\x1b[36mCache Status:\x1b[0m\r\n');
            this.sessionHost.write('  Age: ' + info.age + '\r\n');
            this.sessionHost.write('  Last updated: ' + info.lastUpdated?.toLocaleString() + '\r\n\r\n');
          } else {
            this.sessionHost.write('\x1b[33mNo cache found.\x1b[0m\r\n\r\n');
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
    this.sessionHost.write('\x1b[1;36mBuilt-in Commands:\x1b[0m\r\n');
    this.sessionHost.write('  \x1b[33m/help\x1b[0m - Show this help message\r\n');
    this.sessionHost.write('  \x1b[33m/clear\x1b[0m - Clear the terminal screen\r\n');
    this.sessionHost.write('  \x1b[33m/reconnect\x1b[0m - Reconnect to the server\r\n');
    this.sessionHost.write('  \x1b[33m/disconnect\x1b[0m - Disconnect from the server\r\n');
    this.sessionHost.write('  \x1b[33m/reload-commands\x1b[0m - Force reload command database from server\r\n');
    this.sessionHost.write('  \x1b[33m/clear-cache\x1b[0m - Clear cached command database\r\n');
    this.sessionHost.write('  \x1b[33m/cache-info\x1b[0m - Show command cache information\r\n');
    this.sessionHost.write('\r\n');
    this.sessionHost.write('\x1b[1;36mKeyboard Shortcuts:\x1b[0m\r\n');
    this.sessionHost.write('  \x1b[2mTab - Autocomplete commands and cycle suggestions\x1b[0m\r\n');
    this.sessionHost.write('  \x1b[2mUp/Down or Ctrl+P/Ctrl+N - Navigate command history\x1b[0m\r\n');
    this.sessionHost.write('  \x1b[2mCtrl+A/Ctrl+E - Start/end of line  |  Ctrl+B/Ctrl+F - Move by character\x1b[0m\r\n');
    this.sessionHost.write('  \x1b[2mAlt+B/Alt+F - Move by word  |  Ctrl+T - Transpose characters\x1b[0m\r\n');
    this.sessionHost.write('  \x1b[2mCtrl+K - Kill to end of line  |  Ctrl+U - Kill to start of line\x1b[0m\r\n');
    this.sessionHost.write('  \x1b[2mCtrl+W/Alt+Backspace - Delete word back  |  Alt+D - Delete word forward\x1b[0m\r\n');
    this.sessionHost.write('  \x1b[2mCtrl+Y - Yank  |  Ctrl+L - Clear screen  |  Esc - Clear current line\x1b[0m\r\n');
    this.sessionHost.write('  \x1b[2mCtrl+C - Cancel input  |  Ctrl+D - Disconnect\x1b[0m\r\n');
    this.sessionHost.write('\r\n');
    this.showPrompt();
  }

  private async executeCommand(command: string): Promise<void> {
    if (this.connectionManager.isReconnecting) {
      this.sessionHost.write('\x1b[33mReconnecting... Please wait.\x1b[0m\r\n\r\n');
      this.showPrompt();
      return;
    }

    if (!this.connectionManager.isConnected) {
      this.sessionHost.write('\x1b[31mNot connected. Type \x1b[33m/reconnect\x1b[0m to reconnect.\x1b[0m\r\n\r\n');
      this.showPrompt();
      return;
    }

    this.isExecutingCommand = true;
    let outputLineCount = 0;

    try {
      const response = await this.connectionManager.controller.send(command);

      if (response && response.trim()) {
        const formatted = formatMinecraftColors(response);
        const lines = formatted.split('\n');
        outputLineCount = lines.length;

        lines.forEach(line => {
          this.sessionHost.write(`${line}\r\n`);
        });
      } else {
        this.sessionHost.write('\x1b[2m(no response)\x1b[0m\r\n');
        outputLineCount = 1;
      }

      this.sessionHost.write('\r\n');
      outputLineCount++;

    } catch (err) {
      const message = errorMessage(err);
      this.sessionHost.write(`\x1b[31mError: ${message}\x1b[0m\r\n`);
      outputLineCount = 1;

      const errorMsg = message.toLowerCase();
      if (errorMsg.includes('econnreset') ||
          errorMsg.includes('econnrefused') ||
          errorMsg.includes('epipe') ||
          errorMsg.includes('not connected') ||
          errorMsg.includes('connection closed') ||
          errorMsg.includes('socket') ||
          errorMsg.includes('timeout')) {

        this.sessionHost.write('\x1b[33m⚠  Connection lost. Auto-reconnecting...\x1b[0m\r\n');
        outputLineCount++;

        this.connectionManager.reportConnectionLost();
      } else {
        this.sessionHost.write('\r\n');
        outputLineCount++;
      }
    } finally {
      this.lastCommandOutputLines = outputLineCount;
      if (outputLineCount > 10) {
        this.suggestionDisplay.markNeedsClearOnNextRender();
      }

      this.isExecutingCommand = false;
      this.showPrompt();
    }
  }
}
