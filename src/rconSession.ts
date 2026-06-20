// src/rconSession.ts
//
// Host-agnostic RCON session orchestrator. Contains all interactive-terminal
// logic (key dispatch, tab completion, command routing, reconnect handling)
// behind a narrow `RconSessionHost` seam whose only hard requirement is a
// function that writes ANSI text to a terminal-shaped output stream.
//
// `cli.ts` is the sole host adapter — it wraps process.stdout / raw-mode
// stdin. The VS Code extension no longer runs a session in-process; it runs
// the built CLI as the terminal's process (see extension.ts).

import { RconController } from './rconClient';
import { CommandTreeCrawler, ProgressPhase } from './commandTreeCrawler';
import {
  Machine, Event as EngineEvent, Effect as EngineEffect,
  createMachine, step, applySuggestion,
} from './completionEngine';
import { CompletionBackend, RconCompletionBackend, LocalCompletionBackend } from './completionBackend';
import { LineEditor } from './lineEditor';
import { SuggestionDisplay } from './displaySuggestion';
import type { ConsolaInstance } from 'consola';
import { RconConnectionManager, ControllerFactory } from './rconConnectionManager';
import { errorMessage } from './logger';
import { HistoryStore, HistorySearchState, startHistorySearch, setHistorySearchQuery, cycleHistorySearch } from './historyStore';
import * as ansi from './ansi';
import { progress } from '@clack/prompts';
import { formatCommandTree, formatCommandLog } from './displayCommandTree';

export interface RconSessionHost {
  write(text: string): void;
  close(exitCode: number): void;
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  cacheDir: string;
  dimensions(): { columns: number; rows: number } | undefined;
  /** Number of commands to remember in history (in-memory and persisted to disk). Defaults to 100. */
  historySize?: number;
  /** Skips the server-side tab-complete plugin probe, forcing the help-crawl-based local completion path. For manual testing only. */
  disablePlugin?: boolean;
  /** Diagnostic logs are going to a file rather than the console — report command-tree-loading progress via the logger instead of a clack progress bar. */
  logToFile?: boolean;
}

/** Phase labels shown on the command-tree-loading progress bar / logged when `logToFile` is set. */
function progressPhaseLabel(phase: ProgressPhase): string {
  switch (phase) {
    case 'fetching': return 'Fetching commands...';
    case 'loading': return 'Processing subcommands...';
    case 'complete': return 'Commands loaded and cached!';
    case 'cache-hit': return 'Commands loaded from cache!';
  }
}

/** A terminal-side `.` command: dispatched by name/alias, listed (by name only) in .help. */
interface BuiltinCommand {
  name: string;
  description: string;
  /** Alternate names that dispatch to the same command but aren't listed in .help. */
  aliases?: string[];
  run: (args: string) => void;
}

/** A command response taller than this many lines is treated as a screen-disrupting dump that the next prompt/suggestion render must clear past. */
const LARGE_OUTPUT_LINE_THRESHOLD = 10;

/** Commands to remember (in-memory and persisted) when the host doesn't specify a `historySize`. */
const DEFAULT_HISTORY_SIZE = 100;

/** Substring the TabComplete plugin's `tabcomplete` help text contains — how `detectAndInitialize` recognizes plugin mode. */
const TAB_COMPLETE_PROBE_MARKER = 'Returns tab completions for a partial command string';

export class RconSession {
  private connectionManager: RconConnectionManager;
  private lineEditor: LineEditor;

  private readonly serverHost: string;
  private readonly serverPort: number;
  private isExecutingCommand: boolean = false;

  private commandTree: CommandTreeCrawler;
  private suggestionDisplay: SuggestionDisplay;

  private pluginMode: boolean = false;
  private engine: Machine = createMachine();
  private rconBackend: CompletionBackend;
  private localBackend: CompletionBackend;
  private get completionBackend(): CompletionBackend {
    const inner = this.pluginMode ? this.rconBackend : this.localBackend;
    const builtinNames = this.builtinCommands.map(c => c.name);
    return {
      fetchCompletions: async (line: string) => {
        if (line.startsWith('.')) { return builtinNames.filter(n => n.startsWith(line)); }
        return inner.fetchCompletions(line);
      },
      fetchUsage: async (line: string) => {
        if (line.startsWith('.')) { return ''; }
        return inner.fetchUsage(line);
      },
    };
  }

  private lastCommandOutputLines: number = 0;

  private historyStore: HistoryStore;
  private historySearch: HistorySearchState | null = null;
  private readonly historySearchLabel = '(reverse-i-search): ';

  constructor(
    controller: RconController,
    host: string,
    port: number,
    password: string,
    private readonly logger: ConsolaInstance,
    private readonly sessionHost: RconSessionHost,
    controllerFactory?: ControllerFactory
  ) {
    this.serverHost = host;
    this.serverPort = port;

    const historySize = sessionHost.historySize ?? DEFAULT_HISTORY_SIZE;

    this.connectionManager = new RconConnectionManager(host, port, password, logger, controller, {
      write: (text) => sessionHost.write(text),
      showPrompt: () => this.showPrompt(),
      onReconnected: () => this.initializeCommands(),
    }, controllerFactory);

    this.commandTree = new CommandTreeCrawler(
      (cmd) => this.connectionManager.controller.send(cmd),
      logger,
      sessionHost.cacheDir,
      host,
      port
    );

    this.rconBackend = new RconCompletionBackend(() => this.connectionManager.controller);
    this.localBackend = new LocalCompletionBackend(this.commandTree);

    this.suggestionDisplay = new SuggestionDisplay({
      write: (text) => sessionHost.write(text),
      cursorColumn: () => {
        // Visual width of the prompt (ANSI codes stripped) plus cursor position
        // within the typed text — gives the cursor's offset from the start of
        // the prompt. When that exceeds the terminal width, the line has
        // wrapped onto a later row, so reduce it mod the column count to get
        // the cursor's actual column on that row.
        const terminalWidth = this.sessionHost.dimensions()?.columns;
        if (this.historySearch) {
          const column = this.historySearchLabel.length + this.historySearch.query.length;
          return terminalWidth ? column % terminalWidth : column;
        }
        const promptWidth = ansi.stripAnsi(this.promptText()).length;
        const column = promptWidth + this.lineEditor.cursor;
        return terminalWidth ? column % terminalWidth : column;
      },
    });

    this.lineEditor = new LineEditor({
      write: (text) => sessionHost.write(text),
      promptText: () => this.promptText(),
      onLineChanged: (line) => this.dispatchToEngine({ kind: 'lineChanged', line }),
      beforeLineCleared: () => this.suggestionDisplay.clear(),
      consumeOutputArtifacts: () => {
        if (this.lastCommandOutputLines > LARGE_OUTPUT_LINE_THRESHOLD) {
          this.lastCommandOutputLines = 0;
          return true;
        }
        return false;
      },
    }, historySize);

    this.historyStore = new HistoryStore(sessionHost.cacheDir, host, port, logger, historySize);
    this.lineEditor.loadHistory(this.historyStore.load());

    this.keyHandlers = this.buildKeyHandlers();
    this.builtinCommands = this.buildBuiltinCommands();
    this.builtinLookup = new Map(
      this.builtinCommands.flatMap(cmd => [cmd.name, ...(cmd.aliases ?? [])].map(name => [name, cmd] as const))
    );
  }

  open(): void {
    this.writeWelcomeBanner();
    this.detectAndInitialize();
  }

  private writeWelcomeBanner(): void {
    this.sessionHost.write(ansi.boldCyan('Minercon Terminal') + '\r\n');
    this.sessionHost.write('Connected to ' + ansi.yellow(this.serverHost + ':' + this.serverPort) + '\r\n\r\n');
    this.sessionHost.write(ansi.dim('Useful shortcuts:') + '\r\n');
    this.sessionHost.write('  ' + ansi.dim('Tab: Autocomplete commands  |  Type ') + ansi.yellow('.help') + ansi.dim(' for built-in commands') + '\r\n');
    this.sessionHost.write('  ' + ansi.dim('Ctrl+L: Clear screen  |  Ctrl+C: Cancel input') + '\r\n');
    this.sessionHost.write('  ' + ansi.dim('Up/Down: Command history  |  Ctrl+R: Search history  |  Esc: Clear line') + '\r\n\r\n');
  }

  private async detectAndInitialize(): Promise<void> {
    if (this.sessionHost.disablePlugin) {
      this.sessionHost.write('\r\n' + ansi.yellow('Server tab-complete plugin probe disabled — using local completions') + '\r\n\r\n');
      await this.initializeCommands();
      return;
    }
    try {
      const response = await this.connectionManager.controller.send('tabcomplete');
      if (response && response.includes(TAB_COMPLETE_PROBE_MARKER)) {
        this.pluginMode = true;
        this.commandTree.isReady = true;
        this.sessionHost.write('\r\n' + ansi.green('✓ Server tab-complete plugin detected — using server-side completions') + '\r\n\r\n');
        this.showPrompt();
        return;
      }
    } catch {
      // probe failed, fall through to normal init
    }
    await this.initializeCommands();
  }

  private async initializeCommands(forceRefresh: boolean = false): Promise<void> {
    const cacheInfo = this.commandTree.getCacheInfo();
    const willLoadFromCache = !forceRefresh && cacheInfo.exists;
    const reason = forceRefresh ? 'Forcing refresh...' :
      !cacheInfo.exists ? 'No cache found...' :
        'Cache outdated...';

    // Three progress-reporting strategies for the same underlying crawl,
    // chosen by host/cache state: log lines (file logging), a one-shot cache
    // notice, or a live clack progress bar for a fresh crawl.
    if (this.sessionHost.logToFile) {
      await this.loadCommandsLogged(willLoadFromCache, reason, forceRefresh);
    } else if (willLoadFromCache) {
      await this.loadCommandsFromCache(forceRefresh);
    } else {
      await this.loadCommandsWithProgressBar(reason, forceRefresh);
    }
  }

  /** Command-tree load for the file-logging host: narrate progress through the logger rather than a progress bar. */
  private async loadCommandsLogged(willLoadFromCache: boolean, reason: string, forceRefresh: boolean): Promise<void> {
    if (!willLoadFromCache) {
      this.logger.info(`Loading server commands (${reason})`);
    }
    try {
      await this.commandTree.initialize((progressPct, phase) => {
        if (willLoadFromCache) {
          if (progressPct >= 100) {
            this.logger.success('Commands loaded from cache!');
            this.showPrompt();
          }
          return;
        }

        this.logger.info(`${progressPhaseLabel(phase)} (${Math.round(progressPct)}%)`);

        if (progressPct >= 100) {
          this.logger.success('Commands loaded and cached!');
          this.showPrompt();
        }
      }, undefined, forceRefresh);
    } catch (error) {
      this.logger.error(`Failed to load commands: ${error}`);
      this.logger.warn('Autocomplete will be limited.');
      this.showPrompt();
    }
  }

  /**
   * Command-tree load on a cache hit (terminal host): resolves in a single
   * synchronous step, so skip the progress bar entirely (and the raw-mode
   * dance its start/stop incurs).
   */
  private async loadCommandsFromCache(forceRefresh: boolean): Promise<void> {
    try {
      await this.commandTree.initialize((progressPct) => {
        if (progressPct >= 100) {
          this.sessionHost.write(ansi.green('✓ Commands loaded from cache!') + '\r\n\r\n');
          this.showPrompt();
        }
      }, undefined, forceRefresh);
    } catch (error) {
      this.sessionHost.write(ansi.red(`✗ Failed to load commands: ${error}`) + '\r\n');
      this.sessionHost.write(ansi.yellow('Autocomplete will be limited.') + '\r\n\r\n');
      this.showPrompt();
    }
  }

  /** Command-tree load for a fresh crawl (terminal host): a clack progress bar narrating phases and per-command messages. */
  private async loadCommandsWithProgressBar(reason: string, forceRefresh: boolean): Promise<void> {
    const bar = progress({ style: 'block' });
    bar.start(`Loading server commands (${reason})`);
    let lastProgress = 0;

    // clack's progress bar, on stop/error, closes the readline interface it
    // created over stdin — which pauses stdin and puts it back into cooked
    // mode. Undo both so the REPL keeps reading input a keystroke at a time.
    const restoreStdin = (): void => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    };

    try {
      await this.commandTree.initialize((progressPct, phase) => {
        // During 'loading', leave the message alone — `onMessage` (below)
        // narrates per-command progress there, and immediately overwriting
        // it with the phase label would make that narration flash by unseen.
        if (phase === 'loading') {
          bar.advance(progressPct - lastProgress);
        } else {
          bar.advance(progressPct - lastProgress, progressPhaseLabel(phase));
        }
        lastProgress = progressPct;

        if (progressPct >= 100) {
          bar.stop('Commands loaded and cached!');
          restoreStdin();
          this.showPrompt();
        }
      }, (message) => bar.message(message), forceRefresh);
    } catch (error) {
      bar.error(`Failed to load commands: ${error}`);
      restoreStdin();
      this.showPrompt();
    }
  }

  close(): void {
    this.connectionManager.dispose();
  }

  /** The current colored prompt string — the single source of truth for what the prompt looks like in each connection state. */
  private promptText(): string {
    if (this.connectionManager.isReconnecting) { return ansi.yellow('[reconnecting]') + ' > '; }
    if (!this.connectionManager.isConnected) { return ansi.red('[disconnected]') + ' > '; }
    return ansi.green('>') + ' ';
  }

  private showPrompt(): void {
    if (this.isExecutingCommand) {
      return;
    }
    this.sessionHost.write(this.promptText());
  }

  private readonly keyHandlers: Map<string, () => void>;

  private buildKeyHandlers(): Map<string, () => void> {
    const bindings: { sequences: string[]; handler: () => void }[] = [
      { sequences: ['\t'], handler: () => this.handleTabComplete() },
      { sequences: ['\x1b[Z'], handler: () => this.handleShiftTab() },
      { sequences: ['\x1b'], handler: () => this.handleEscape() },
      { sequences: ['\x04'], handler: () => this.handleCtrlD() },
      { sequences: ['\x03'], handler: () => this.handleCtrlC() },
      { sequences: ['\x18'], handler: () => this.handleCut() },
      { sequences: ['\x16', '\x19'], handler: () => this.handlePaste() },
      { sequences: ['\x0c'], handler: () => this.handleClearScreen() },
      { sequences: ['\x12'], handler: () => this.startHistorySearch() },
      { sequences: ['\x1b[A', '\x10'], handler: () => this.handleHistoryOrSuggestionArrow('up') },
      { sequences: ['\x1b[B', '\x0e'], handler: () => this.handleHistoryOrSuggestionArrow('down') },
      { sequences: ['\x1b[5~'], handler: () => this.handlePagePrevious() },
      { sequences: ['\x1b[6~'], handler: () => this.handlePageNext() },
      { sequences: ['\x1b[1;2D'], handler: () => this.lineEditor.selectLeft() },
      { sequences: ['\x1b[1;2C'], handler: () => this.lineEditor.selectRight() },
      { sequences: ['\x1b[1;5D', '\x1b[5D', '\x1bb'], handler: () => this.lineEditor.moveWordLeft() },
      { sequences: ['\x1b[1;5C', '\x1b[5C', '\x1bf'], handler: () => this.lineEditor.moveWordRight() },
      { sequences: ['\x1b[1;6D'], handler: () => this.lineEditor.selectWordLeft() },
      { sequences: ['\x1b[1;6C'], handler: () => this.lineEditor.selectWordRight() },
      { sequences: ['\x1b[1;2H', '\x1b[1;2~'], handler: () => this.lineEditor.selectToStart() },
      { sequences: ['\x1b[1;2F', '\x1b[1;2$'], handler: () => this.lineEditor.selectToEnd() },
      { sequences: ['\x1b[D', '\x02'], handler: () => this.lineEditor.moveLeft() },
      { sequences: ['\x1b[C', '\x06'], handler: () => this.lineEditor.moveRight() },
      { sequences: ['\x1b[H', '\x1bOH', '\x1b[1~', '\x01'], handler: () => this.lineEditor.moveToStart() },
      { sequences: ['\x1b[F', '\x1bOF', '\x1b[4~', '\x05'], handler: () => this.lineEditor.moveToEnd() },
      { sequences: ['\x1b[3~'], handler: () => this.lineEditor.deleteForward() },
      { sequences: ['\x0b'], handler: () => this.killAndStash(() => this.lineEditor.killToEnd()) },
      { sequences: ['\x15'], handler: () => this.killAndStash(() => this.lineEditor.killToStart()) },
      { sequences: ['\x17', '\x1b\x7f', '\x1b\b'], handler: () => this.killAndStash(() => this.lineEditor.killWordBack()) },
      { sequences: ['\x1bd'], handler: () => this.killAndStash(() => this.lineEditor.killWordForward()) },
      { sequences: ['\x14'], handler: () => this.lineEditor.transposeChars() },
      { sequences: ['\r', '\n'], handler: () => this.handleEnter() },
      { sequences: ['\x7f', '\b'], handler: () => this.lineEditor.handleBackspace() },
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

    if (this.historySearch) {
      this.handleHistorySearchInput(data);
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
    if (this.lineEditor.line.length > 0) {
      this.lineEditor.deleteForward();
      return;
    }
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

  // ── Ctrl+R: reverse history search ──
  //
  // While active, keystrokes edit the search query (not the line) and the
  // matching history entries are shown in the same popup tab-completion uses
  // (SuggestionDisplay), most-recently-used first. handleInput routes
  // everything here instead of through keyHandlers until the search ends.

  private startHistorySearch(): void {
    if (this.suggestionDisplay.isShowing) {
      this.dispatchToEngine({ kind: 'escape' });
    }
    this.historySearch = startHistorySearch(this.lineEditor.historyEntries, this.lineEditor.line);
    this.renderHistorySearch();
  }

  private handleHistorySearchInput(data: string): void {
    switch (data) {
      case '\x12':                 // Ctrl+R again: cycle to the next-older match
      case '\t':                   // Tab: cycle to the next-older match
        this.cycleHistorySearch(1);
        return;
      case '\x1b[A': case '\x10':  // Up / Ctrl+P: move visual selection up (newer)
        this.cycleHistorySearch(-1);
        return;
      case '\x1b[B': case '\x0e':  // Down / Ctrl+N: move visual selection down (older)
        this.cycleHistorySearch(1);
        return;
      case '\x1b[Z':               // Shift-Tab: cycle to the next-newer match
        this.cycleHistorySearch(-1);
        return;
      case '\x1b': case '\x07': case '\x03':  // Escape / Ctrl+G / Ctrl+C: cancel
        this.cancelHistorySearch();
        return;
      case '\r': case '\n':        // Enter: load the match for further editing
        this.acceptHistorySearch();
        return;
      case '\x7f': case '\b':      // Backspace: shrink the query
        this.setHistorySearchQuery(this.historySearch!.query.slice(0, -1));
        return;
      default:
        if (data.charCodeAt(0) >= 32) {
          this.setHistorySearchQuery(this.historySearch!.query + data);
        }
        return;
    }
  }

  private setHistorySearchQuery(query: string): void {
    this.historySearch = setHistorySearchQuery(this.lineEditor.historyEntries, this.historySearch!, query);
    this.renderHistorySearch();
  }

  private cycleHistorySearch(delta: number): void {
    this.historySearch = cycleHistorySearch(this.historySearch!, delta);
    this.renderHistorySearch();
  }

  private acceptHistorySearch(): void {
    const search = this.historySearch!;
    const selected = search.items[search.selectedIndex] ?? search.originalLine;
    this.suggestionDisplay.hide();
    this.historySearch = null;
    this.lineEditor.replaceLine(selected);
  }

  private cancelHistorySearch(): void {
    const search = this.historySearch!;
    this.suggestionDisplay.hide();
    this.historySearch = null;
    this.lineEditor.replaceLine(search.originalLine);
  }

  private renderHistorySearch(): void {
    const search = this.historySearch!;
    this.sessionHost.write('\r\x1b[K');
    this.sessionHost.write(ansi.cyan(this.historySearchLabel) + search.query);
    this.suggestionDisplay.render(search.items, search.selectedIndex, null, '');
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

  /** The input line the current in-flight fetch is resolving for (or the live line if somehow idle). */
  private fetchLine(): string {
    return this.engine.fetch.kind === 'busy' ? this.engine.fetch.forLine : this.lineEditor.line;
  }

  /** Await `p`, falling back to `fallback` if it rejects — a failed fetch is just "no result". */
  private async settleOr<T>(p: Promise<T>, fallback: T): Promise<T> {
    try { return await p; } catch { return fallback; }
  }

  private async runEngineCompletionsFetch(requestId: number): Promise<void> {
    const items = await this.settleOr(this.completionBackend.fetchCompletions(this.fetchLine()), []);
    this.dispatchToEngine({ kind: 'completionsResult', requestId, items });
  }

  private async runEngineUsageFetch(requestId: number): Promise<void> {
    const text = await this.settleOr(this.completionBackend.fetchUsage(this.fetchLine()), '');
    this.dispatchToEngine({ kind: 'usageResult', requestId, text });
  }

  private applySuggestionText(query: string, suggestionText: string): void {
    this.lineEditor.replaceLine(applySuggestion(query, suggestionText));
  }

  private handleTabComplete(): void {
    this.dispatchToEngine({ kind: 'tab', line: this.lineEditor.line });
  }

  private handleShiftTab(): void {
    this.dispatchToEngine({ kind: 'shiftTab', line: this.lineEditor.line });
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
      // Record every command, including minercon's own built-ins, so they're
      // recallable via Up/Ctrl+R and listed by .history — just like a shell's
      // history includes "history" itself. .history is the one exception:
      // it's recorded after displaying, so its own listing reflects the
      // history *before* this invocation, not including itself.
      if (command !== '.history') {
        this.lineEditor.pushHistory(command);
        this.historyStore.save(this.lineEditor.historyEntries);
      }

      const spaceIdx = command.indexOf(' ');
      const cmdName = spaceIdx === -1 ? command : command.slice(0, spaceIdx);
      const cmdArgs = spaceIdx === -1 ? '' : command.slice(spaceIdx + 1).trim();
      const builtin = this.builtinLookup.get(cmdName);
      if (builtin) {
        builtin.run(cmdArgs);
      } else {
        this.executeCommand(command);
      }
    } else {
      this.showPrompt();
    }
  }

  // ── built-in `.` commands ──
  //
  // One table drives both dispatch (handleEnter → builtinLookup) and the
  // command list .help prints — adding a command here is the whole job.
  // Same lookup-table pattern as buildKeyHandlers; like there, the run()
  // closures resolve collaborators lazily at call time.

  private readonly builtinCommands: BuiltinCommand[];
  private readonly builtinLookup: Map<string, BuiltinCommand>;

  private buildBuiltinCommands(): BuiltinCommand[] {
    /** Writes the "this is plugin mode, there's no local cache" notice — shared by every cache-related command. */
    const pluginModeNotice = (text: string): void => {
      this.sessionHost.write(ansi.yellow(text) + '\r\n\r\n');
      this.showPrompt();
    };

    return [
      {
        name: '.help', description: 'Show this help message',
        run: (_) => this.showHelp(),
      },
      {
        name: '.clear', description: 'Clear the terminal screen',
        run: (_) => {
          this.sessionHost.write('\x1b[2J\x1b[H');
          this.showPrompt();
        },
      },
      {
        name: '.history', description: 'Show command history',
        run: (_) => {
          this.showHistory();
          this.lineEditor.pushHistory('.history');
          this.historyStore.save(this.lineEditor.historyEntries);
        },
      },
      {
        name: '.reconnect', description: 'Reconnect to the server',
        run: (_) => { this.connectionManager.manualReconnect(); },
      },
      {
        name: '.disconnect', description: 'Disconnect from the server',
        run: (_) => this.connectionManager.disconnect(),
      },
      {
        name: '.reload-commands', description: 'Force reload command database from server',
        aliases: ['.refresh-commands'],
        run: (_) => {
          if (this.pluginMode) {
            pluginModeNotice('Using server-side tab completion — no command cache to reload.');
          } else {
            this.initializeCommands(true);
          }
        },
      },
      {
        name: '.clear-cache', description: 'Clear cached command database',
        run: (_) => {
          if (this.pluginMode) {
            pluginModeNotice('Using server-side tab completion — no cache.');
          } else {
            this.commandTree.clearCache();
            this.sessionHost.write(ansi.yellow('Command cache cleared.') + '\r\n\r\n');
            this.showPrompt();
          }
        },
      },
      {
        name: '.cache-info', description: 'Show command cache information',
        run: (_) => {
          if (this.pluginMode) {
            pluginModeNotice('Using server-side tab completion — no cache.');
            return;
          }
          const info = this.commandTree.getCacheInfo();
          if (info.exists) {
            this.sessionHost.write(ansi.cyan('Cache Status:') + '\r\n');
            this.sessionHost.write('  Age: ' + info.age + '\r\n');
            this.sessionHost.write('  Last updated: ' + info.lastUpdated?.toLocaleString() + '\r\n\r\n');
          } else {
            this.sessionHost.write(ansi.yellow('No cache found.') + '\r\n\r\n');
          }
          this.showPrompt();
        },
      },
      {
        name: '.tree', description: 'Print command tree. Usage: .tree [<command>]',
        run: (args) => {
          if (this.pluginMode) {
            pluginModeNotice('Using server-side tab completion — no local command tree.');
            return;
          }
          if (!this.commandTree.isReady) {
            this.sessionHost.write(ansi.yellow('Command tree not yet loaded.') + '\r\n\r\n');
            this.showPrompt();
            return;
          }
          const cmdArg = args.trim() || undefined;
          const output = formatCommandTree(this.commandTree.commands, cmdArg);
          output.split('\n').forEach(line => this.sessionHost.write(line + '\r\n'));
          if (cmdArg) {
            const name = cmdArg.startsWith('/') ? cmdArg.slice(1) : cmdArg;
            const logOutput = formatCommandLog(this.commandTree.getCommandLog(name));
            if (logOutput) {
              logOutput.split('\n').forEach(line => this.sessionHost.write(line + '\r\n'));
            }
          }
          this.showPrompt();
        },
      },
    ];
  }

  private showHistory(): void {
    const entries = this.lineEditor.historyEntries;
    if (entries.length === 0) {
      this.sessionHost.write(ansi.gray('(no history yet)') + '\r\n');
    } else {
      const width = String(entries.length).length;
      entries.forEach((entry, index) => {
        const number = String(index + 1).padStart(width, ' ');
        this.sessionHost.write(ansi.gray(number) + '  ' + entry + '\r\n');
      });
    }
    this.showPrompt();
  }

  private showHelp(): void {
    this.sessionHost.write(ansi.boldCyan('Built-in Commands:') + '\r\n');
    for (const { name, description } of this.builtinCommands) {
      this.sessionHost.write('  ' + ansi.yellow(name) + ' - ' + description + '\r\n');
    }
    this.sessionHost.write('\r\n');
    this.sessionHost.write(ansi.boldCyan('Keyboard Shortcuts:') + '\r\n');
    this.sessionHost.write('  ' + ansi.dim('Tab - Autocomplete commands and cycle suggestions') + '\r\n');
    this.sessionHost.write('  ' + ansi.dim('Up/Down or Ctrl+P/Ctrl+N - Navigate command history') + '\r\n');
    this.sessionHost.write('  ' + ansi.dim('Ctrl+R - Reverse search command history') + '\r\n');
    this.sessionHost.write('  ' + ansi.dim('Ctrl+A/Ctrl+E - Start/end of line  |  Ctrl+B/Ctrl+F - Move by character') + '\r\n');
    this.sessionHost.write('  ' + ansi.dim('Alt+B/Alt+F - Move by word  |  Ctrl+T - Transpose characters') + '\r\n');
    this.sessionHost.write('  ' + ansi.dim('Ctrl+K - Kill to end of line  |  Ctrl+U - Kill to start of line') + '\r\n');
    this.sessionHost.write('  ' + ansi.dim('Ctrl+W/Alt+Backspace - Delete word back  |  Alt+D - Delete word forward') + '\r\n');
    this.sessionHost.write('  ' + ansi.dim('Ctrl+Y - Yank  |  Ctrl+L - Clear screen  |  Esc - Clear current line') + '\r\n');
    this.sessionHost.write('  ' + ansi.dim('Ctrl+C - Cancel input  |  Ctrl+D - Disconnect') + '\r\n');
    this.sessionHost.write('\r\n');
    this.showPrompt();
  }

  private async executeCommand(command: string): Promise<void> {
    if (this.connectionManager.isReconnecting) {
      this.sessionHost.write(ansi.yellow('Reconnecting... Please wait.') + '\r\n\r\n');
      this.showPrompt();
      return;
    }

    if (!this.connectionManager.isConnected) {
      this.sessionHost.write(ansi.red('Not connected. Type ' + ansi.yellow('.reconnect') + ' to reconnect.') + '\r\n\r\n');
      this.showPrompt();
      return;
    }

    this.isExecutingCommand = true;
    let outputLineCount = 0;

    try {
      const response = await this.connectionManager.controller.send(command);

      if (response && response.trim()) {
        const formatted = ansi.formatMinecraftColors(response);
        const lines = formatted.split('\n');
        outputLineCount = lines.length;

        lines.forEach(line => {
          this.sessionHost.write(`${line}\r\n`);
        });
      } else {
        this.sessionHost.write(ansi.dim('(no response)') + '\r\n');
        outputLineCount = 1;
      }

      this.sessionHost.write('\r\n');
      outputLineCount++;

    } catch (err) {
      const message = errorMessage(err);
      this.sessionHost.write(ansi.red(`Error: ${message}`) + '\r\n');
      outputLineCount = 1;

      // Ask the controller whether the connection actually died rather than
      // sniffing the error text for socket-ish substrings — a slow command's
      // "Command timeout" used to match 'timeout' and tear down a perfectly
      // healthy connection.
      if (!this.connectionManager.controller.isConnected()) {
        this.sessionHost.write(ansi.yellow('⚠  Connection lost. Auto-reconnecting...') + '\r\n');
        outputLineCount++;

        this.connectionManager.reportConnectionLost();
      } else {
        this.sessionHost.write('\r\n');
        outputLineCount++;
      }
    } finally {
      this.lastCommandOutputLines = outputLineCount;
      if (outputLineCount > LARGE_OUTPUT_LINE_THRESHOLD) {
        this.suggestionDisplay.markNeedsClearOnNextRender();
      }

      this.isExecutingCommand = false;
      this.showPrompt();
    }
  }
}
