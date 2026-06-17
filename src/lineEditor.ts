// src/lineEditor.ts
//
// Owns the input line itself: the text, cursor position, selection range,
// and command history, plus every operation that mutates them — character
// insertion/deletion, cursor and selection movement, kill/yank-style word and
// line edits, and history navigation. It also owns redrawing the line (with
// or without selection highlighting) to the terminal.
//
// This is the "what does typing do to the buffer, and how does that get
// painted" layer — it knows nothing about RCON, tab completion, or connection
// state. Where it needs the host terminal to do something on its behalf (emit
// ANSI, know the current prompt text, react to the line changing), it goes
// through the small `LineEditorHost` interface below, so it stays testable
// and reusable independent of `vscode.Pseudoterminal` plumbing.

import * as ansi from './ansi';

export interface LineEditorHost {
  /** Write raw text/ANSI escape sequences to the terminal. */
  write(text: string): void;
  /** The current colored prompt string (depends on connection state, which the host owns). */
  promptText(): string;
  /** Called whenever the line's text changes, so the host can re-derive completions/hints. */
  onLineChanged(line: string): void;
  /** Called immediately before the line is wiped (Ctrl+C/U, Esc, Enter, ...) so the host can clear any display anchored to the old line (e.g. the argument hint). */
  beforeLineCleared(): void;
  /**
   * Returns true if stale rendering artifacts from a large command-output
   * dump need clearing before typing continues — and resets that tracking
   * state. The caller (insertText) is responsible for actually repainting the
   * prompt + line-so-far, since only it knows the current line/cursor.
   */
  consumeOutputArtifacts(): boolean;
}

export class LineEditor {
  private currentLine: string = '';
  private cursorPosition: number = 0;

  // The active selection, or null when there's none. `anchor` is the fixed end
  // (where the gesture started); `head` is the moving end, kept in step with the
  // cursor. A collapsed selection (anchor === head) counts as none — see
  // hasSelection.
  private selection: { anchor: number; head: number } | null = null;

  private history: string[] = [];
  // Non-null while the user is navigating history; null when at the live line.
  // Bundles the navigation index and the line saved on first Up-arrow so they
  // stay in sync and can be reset atomically.
  private historyCursor: { index: number; savedLine: string } | null = null;

  constructor(private host: LineEditorHost, private readonly maxHistorySize: number = 100) {}

  get line(): string {
    return this.currentLine;
  }

  get cursor(): number {
    return this.cursorPosition;
  }

  // ── selection ──

  hasSelection(): boolean {
    return this.selection !== null && this.selection.anchor !== this.selection.head;
  }

  clearSelection(): void {
    this.selection = null;
  }

  /** The selection's bounds as `[start, end)`, low-to-high — only valid when `hasSelection()`. */
  private selectionRange(): { start: number; end: number } {
    const { anchor, head } = this.selection!;
    return { start: Math.min(anchor, head), end: Math.max(anchor, head) };
  }

  getSelectedText(): string {
    if (!this.hasSelection()) { return ''; }
    const { start, end } = this.selectionRange();
    return this.currentLine.slice(start, end);
  }

  deleteSelection(): void {
    if (!this.hasSelection()) { return; }
    this.deleteSelectionInternal();
    this.host.onLineChanged(this.currentLine);
  }

  /** `deleteSelection` without the host notification — for compound edits (insertText) that notify once themselves, with the final line. */
  private deleteSelectionInternal(): void {
    if (!this.hasSelection()) { return; }
    const { start, end } = this.selectionRange();

    this.currentLine = this.currentLine.slice(0, start) + this.currentLine.slice(end);
    this.cursorPosition = start;
    this.clearSelection();
  }

  /**
   * Extend (or begin) the selection so its moving end lands at `newPos`: anchor
   * at the current cursor if there isn't a selection yet, then move both the
   * cursor and the selection's moving end to `newPos` and repaint. Every
   * select* operation is this — they differ only in how they pick `newPos`.
   */
  private extendSelectionTo(newPos: number): void {
    if (!this.hasSelection()) {
      this.selection = { anchor: this.cursorPosition, head: this.cursorPosition };
    }
    this.cursorPosition = newPos;
    this.selection!.head = newPos;
    this.redraw();
  }

  selectLeft(): void {
    if (this.cursorPosition > 0) { this.extendSelectionTo(this.cursorPosition - 1); }
  }

  selectRight(): void {
    if (this.cursorPosition < this.currentLine.length) { this.extendSelectionTo(this.cursorPosition + 1); }
  }

  selectWordLeft(): void {
    this.extendSelectionTo(this.findWordLeft());
  }

  selectWordRight(): void {
    this.extendSelectionTo(this.findWordRight());
  }

  selectToStart(): void {
    if (this.cursorPosition > 0) { this.extendSelectionTo(0); }
  }

  selectToEnd(): void {
    if (this.cursorPosition < this.currentLine.length) { this.extendSelectionTo(this.currentLine.length); }
  }

  // ── cursor movement ──

  moveLeft(): void {
    const hadSelection = this.hasSelection();
    if (hadSelection) { this.clearSelection(); }

    if (this.cursorPosition > 0) {
      this.cursorPosition--;
      if (hadSelection) {
        this.redraw();
      } else {
        this.host.write('\x1b[D');
      }
    } else if (hadSelection) {
      this.redraw();
    }
  }

  moveRight(): void {
    const hadSelection = this.hasSelection();
    if (hadSelection) { this.clearSelection(); }

    if (this.cursorPosition < this.currentLine.length) {
      this.cursorPosition++;
      if (hadSelection) {
        this.redraw();
      } else {
        this.host.write('\x1b[C');
      }
    } else if (hadSelection) {
      this.redraw();
    }
  }

  moveWordLeft(): void {
    const newPos = this.findWordLeft();
    if (newPos !== this.cursorPosition) {
      this.clearSelection();
      this.cursorPosition = newPos;
      this.redraw();
    }
  }

  moveWordRight(): void {
    const newPos = this.findWordRight();
    if (newPos !== this.cursorPosition) {
      this.clearSelection();
      this.cursorPosition = newPos;
      this.redraw();
    }
  }

  moveToStart(): void {
    const hadSelection = this.hasSelection();
    this.clearSelection();
    if (this.cursorPosition > 0) {
      this.cursorPosition = 0;
      if (hadSelection) {
        this.redraw();
      } else {
        this.host.write('\r');
        this.host.write(this.host.promptText());
        this.host.write(this.currentLine);
        const moveBack = this.currentLine.length;
        if (moveBack > 0) {
          this.host.write('\x1b[' + moveBack + 'D');
        }
      }
    } else if (hadSelection) {
      this.redraw();
    }
  }

  moveToEnd(): void {
    const hadSelection = this.hasSelection();
    this.clearSelection();
    const moveForward = this.currentLine.length - this.cursorPosition;
    if (moveForward > 0) {
      this.cursorPosition = this.currentLine.length;
      if (hadSelection) {
        this.redraw();
      } else {
        this.host.write('\x1b[' + moveForward + 'C');
      }
    } else if (hadSelection) {
      this.redraw();
    }
  }

  // ── editing ──

  insertText(text: string): void {
    if (this.host.consumeOutputArtifacts()) {
      this.host.write('\x1b[2K');
      this.host.write('\r');
      this.host.write(this.host.promptText());
      this.host.write(this.currentLine.substring(0, this.cursorPosition));
    }

    if (this.hasSelection()) {
      this.deleteSelectionInternal();
    }

    const filteredText = text.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, '');
    if (filteredText.length === 0) { return; }

    this.currentLine = this.currentLine.slice(0, this.cursorPosition) +
                      filteredText +
                      this.currentLine.slice(this.cursorPosition);

    const restOfLine = this.currentLine.slice(this.cursorPosition + filteredText.length);
    this.host.write(filteredText + restOfLine);

    this.cursorPosition += filteredText.length;

    if (restOfLine.length > 0) {
      this.host.write('\x1b[' + restOfLine.length + 'D');
    }

    this.clearSelection();
    this.host.onLineChanged(this.currentLine);
  }

  handleBackspace(): void {
    if (this.hasSelection()) {
      this.deleteSelection();
      this.redraw();
    } else if (this.cursorPosition > 0) {
      this.currentLine = this.currentLine.slice(0, this.cursorPosition - 1) +
                        this.currentLine.slice(this.cursorPosition);
      this.cursorPosition--;

      this.host.write('\b');
      const restOfLine = this.currentLine.slice(this.cursorPosition);
      this.host.write(restOfLine + ' ');
      this.host.write('\x1b[' + (restOfLine.length + 1) + 'D');

      this.host.onLineChanged(this.currentLine);
    }
  }

  deleteForward(): void {
    if (this.hasSelection()) {
      this.deleteSelection();
      this.redraw();
    } else if (this.cursorPosition < this.currentLine.length) {
      this.currentLine = this.currentLine.slice(0, this.cursorPosition) +
                        this.currentLine.slice(this.cursorPosition + 1);
      const restOfLine = this.currentLine.slice(this.cursorPosition);
      this.host.write(restOfLine + ' ');
      this.host.write('\x1b[' + (restOfLine.length + 1) + 'D');

      this.host.onLineChanged(this.currentLine);
    }
  }

  /**
   * Repaint the line after a kill: step the cursor `cursorShiftLeft` columns
   * left to the new insertion point (for backward kills), clear to end of line,
   * then write the surviving `tail` and step back onto its start. Shared by all
   * four kill operations — they differ only in `tail` and the shift.
   */
  private repaintAfterKill(tail: string, cursorShiftLeft: number = 0): void {
    if (cursorShiftLeft > 0) { this.host.write('\x1b[' + cursorShiftLeft + 'D'); }
    this.host.write('\x1b[K');
    this.host.write(tail);
    if (tail.length > 0) { this.host.write('\x1b[' + tail.length + 'D'); }
  }

  // emacs: unix-line-discard — kill from cursor to start of line
  killToStart(): string {
    if (this.cursorPosition > 0) {
      const killed = this.currentLine.slice(0, this.cursorPosition);
      const afterCursor = this.currentLine.slice(this.cursorPosition);
      this.currentLine = afterCursor;
      this.cursorPosition = 0;
      this.clearSelection();

      this.repaintAfterKill(afterCursor, killed.length);
      this.host.onLineChanged(this.currentLine);
      return killed;
    }
    return '';
  }

  // emacs: kill-line — kill from cursor to end of line
  killToEnd(): string {
    if (this.cursorPosition < this.currentLine.length) {
      const killed = this.currentLine.slice(this.cursorPosition);
      this.currentLine = this.currentLine.slice(0, this.cursorPosition);
      this.clearSelection();
      this.repaintAfterKill('');
      this.host.onLineChanged(this.currentLine);
      return killed;
    }
    return '';
  }

  // emacs: backward-kill-word (Ctrl+W / Alt+Backspace)
  killWordBack(): string {
    if (this.cursorPosition > 0) {
      const beforeCursor = this.currentLine.slice(0, this.cursorPosition);
      const afterCursor = this.currentLine.slice(this.cursorPosition);

      const newPos = this.findWordLeft();
      const killed = beforeCursor.slice(newPos);
      this.currentLine = beforeCursor.slice(0, newPos) + afterCursor;
      this.cursorPosition = newPos;
      this.clearSelection();

      this.repaintAfterKill(afterCursor, killed.length);
      this.host.onLineChanged(this.currentLine);
      return killed;
    }
    return '';
  }

  // emacs: kill-word (Alt+D) — delete from cursor to end of the word forward
  killWordForward(): string {
    const newPos = this.findWordRight();
    if (newPos > this.cursorPosition) {
      const beforeCursor = this.currentLine.slice(0, this.cursorPosition);
      const killed = this.currentLine.slice(this.cursorPosition, newPos);
      const afterDeleted = this.currentLine.slice(newPos);
      this.currentLine = beforeCursor + afterDeleted;
      this.clearSelection();

      this.repaintAfterKill(afterDeleted);
      this.host.onLineChanged(this.currentLine);
      return killed;
    }
    return '';
  }

  // emacs: transpose-chars — swap the two characters around the cursor
  transposeChars(): void {
    if (this.currentLine.length >= 2 && this.cursorPosition > 0) {
      // At end of line, transpose the last two characters; otherwise transpose
      // the character before the cursor with the one at the cursor.
      const pos = Math.min(this.cursorPosition, this.currentLine.length - 1);
      const chars = [...this.currentLine];
      [chars[pos - 1], chars[pos]] = [chars[pos], chars[pos - 1]];
      this.currentLine = chars.join('');
      this.cursorPosition = Math.min(pos + 1, this.currentLine.length);
      this.clearSelection();
      this.redraw();
      this.host.onLineChanged(this.currentLine);
    }
  }

  // ── whole-line operations ──

  redraw(): void {
    // Move cursor to start of line, clear it, redraw the prompt
    this.host.write('\r');
    this.host.write('\x1b[K');
    this.host.write(this.host.promptText());

    if (!this.hasSelection()) {
      this.host.write(this.currentLine);
    } else {
      const { start, end } = this.selectionRange();

      if (start > 0) {
        this.host.write(this.currentLine.slice(0, start));
      }
      this.host.write(ansi.REVERSE + this.currentLine.slice(start, end) + ansi.REVERSE_OFF);
      if (end < this.currentLine.length) {
        this.host.write(this.currentLine.slice(end));
      }
    }

    if (this.currentLine.length > this.cursorPosition) {
      const moveBack = this.currentLine.length - this.cursorPosition;
      this.host.write('\x1b[' + moveBack + 'D');
    }
  }

  /** Resets the line/cursor/selection to empty without writing anything — for callers (like Enter) that print their own newline and redraw the prompt themselves. */
  resetLine(): void {
    this.currentLine = '';
    this.cursorPosition = 0;
    this.clearSelection();
  }

  clearAndReset(): void {
    this.host.beforeLineCleared();

    this.host.write('\r');
    this.host.write('\x1b[K');

    this.currentLine = '';
    this.cursorPosition = 0;
    this.clearSelection();
    this.host.onLineChanged('');
  }

  /** Replaces the line wholesale (tab-completion splices, history recall, restore-on-escape) — sets the cursor to the end and redraws from scratch. */
  replaceLine(newLine: string): void {
    this.host.write('\r');
    this.host.write('\x1b[K');
    this.host.write(this.host.promptText());
    this.host.write(newLine);

    this.currentLine = newLine;
    this.cursorPosition = newLine.length;
    this.clearSelection();
  }

  // ── history ──

  /** Command history, oldest-first — e.g. for Ctrl+R search or persisting to disk. */
  get historyEntries(): readonly string[] {
    return this.history;
  }

  /** Seeds history (oldest-first) from persisted entries, e.g. loaded from disk at session start. Replaces any existing in-memory history. */
  loadHistory(entries: readonly string[]): void {
    this.history = entries.slice(-this.maxHistorySize);
  }

  pushHistory(command: string): void {
    if (this.history.length === 0 || this.history[this.history.length - 1] !== command) {
      this.history.push(command);
      if (this.history.length > this.maxHistorySize) {
        this.history.shift();
      }
    }
  }

  navigateHistory(direction: 'up' | 'down'): void {
    if (this.history.length === 0) { return; }

    if (direction === 'up') {
      if (this.historyCursor === null) {
        this.historyCursor = { index: 0, savedLine: this.currentLine };
        this.replaceLine(this.history[this.history.length - 1]);
      } else if (this.historyCursor.index < this.history.length - 1) {
        this.historyCursor.index++;
        this.replaceLine(this.history[this.history.length - 1 - this.historyCursor.index]);
      }
    } else {
      if (this.historyCursor === null) { return; }
      if (this.historyCursor.index > 0) {
        this.historyCursor.index--;
        this.replaceLine(this.history[this.history.length - 1 - this.historyCursor.index]);
      } else {
        const { savedLine } = this.historyCursor;
        this.historyCursor = null;
        this.replaceLine(savedLine);
      }
    }
  }

  resetHistoryCursor(): void {
    this.historyCursor = null;
  }

  // ── word-boundary helpers ──

  private findWordLeft(): number {
    if (this.cursorPosition === 0) { return 0; }

    let pos = this.cursorPosition - 1;
    // Skip whitespace
    while (pos > 0 && this.currentLine[pos] === ' ') {
      pos--;
    }
    // Skip word characters
    while (pos > 0 && this.currentLine[pos - 1] !== ' ') {
      pos--;
    }
    return pos;
  }

  private findWordRight(): number {
    if (this.cursorPosition >= this.currentLine.length) { return this.currentLine.length; }

    let pos = this.cursorPosition;

    // If we're in whitespace, skip to next word
    if (this.currentLine[pos] === ' ') {
      while (pos < this.currentLine.length && this.currentLine[pos] === ' ') {
        pos++;
      }
    } else {
      // Skip current word
      while (pos < this.currentLine.length && this.currentLine[pos] !== ' ') {
        pos++;
      }
    }

    return pos;
  }
}
