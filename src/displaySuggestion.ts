// src/displaySuggestion.ts
//
// Owns the suggestion-list / argument-hint display: the items, the selected
// index, paging state, and the ANSI rendering/clearing of whatever's drawn
// below the prompt. Pulled out of RconTerminal as part of the mega-module
// split — see lineEditor.ts for the sibling extraction and its rationale.
//
// This class has no notion of the completionEngine or of dispatching events —
// RconSession remains the single place that talks to the engine (it's the
// one piece deliberately kept pure/central). Callers that need to know
// *whether* an action makes sense (page forward/back) ask the read-only
// `...Index()` queries, which return `number | null` — `null` meaning
// "nothing to do" — and decide for themselves whether to dispatch.

import { ArgumentHintDisplay, formatArgumentHint } from './displayArgumentHint';
import * as ansi from './ansi';

export interface SuggestionDisplayHost {
  write(text: string): void;
  cursorColumn(): number;
}

export class SuggestionDisplay {
  private currentSuggestions: string[] = [];
  private suggestionIndex: number = -1;
  private showing: boolean = false;
  private displayLines: number = 0;

  // Paging
  private visibleStart: number = 0;
  private readonly maxVisible: number = 10;

  private needsClearOnNextRender: boolean = false;

  constructor(private host: SuggestionDisplayHost) {}

  get isShowing(): boolean {
    return this.showing;
  }

  get itemCount(): number {
    return this.currentSuggestions.length;
  }

  private get totalPages(): number {
    return Math.ceil(this.currentSuggestions.length / this.maxVisible);
  }

  /** The 1-based page the selected item sits on (only meaningful while a list is showing). */
  private get currentPage(): number {
    return Math.floor(this.suggestionIndex / this.maxVisible) + 1;
  }

  /** Replaces the direct `needsClearBeforeSuggestions = true` assignment from `executeCommand` — the next render should wipe the screen below the cursor first (e.g. after a multi-line command response may have pushed the display area around). */
  markNeedsClearOnNextRender(): void {
    this.needsClearOnNextRender = true;
  }

  nextPageIndex(): number | null {
    if (!this.showing || this.currentSuggestions.length === 0 || this.totalPages <= 1) { return null; }
    const nextPageStart = this.currentPage * this.maxVisible;
    return nextPageStart < this.currentSuggestions.length ? nextPageStart : 0;
  }

  previousPageIndex(): number | null {
    if (!this.showing || this.currentSuggestions.length === 0 || this.totalPages <= 1) { return null; }
    return this.currentPage > 1
      ? (this.currentPage - 2) * this.maxVisible
      : (this.totalPages - 1) * this.maxVisible;
  }

  /**
   * Sets the displayed items/selection from the engine's `render` effect and
   * draws the appropriate combination of suggestion list and argument hint —
   * `usage` is only ever a single, resolved usage line (the engine collapses
   * "(too broad...)" failures and ambiguous-prefix multi-candidate responses
   * down to empty), so a non-null `display` here means the command portion is
   * fully resolved — independent of how many argument-level completions
   * remain, so it's shown alongside the list whenever available.
   */
  render(items: string[], selectedIndex: number, usage: string | null, currentLine: string): void {
    this.currentSuggestions = items;
    this.suggestionIndex = selectedIndex;
    this.clear();

    const display = usage ? formatArgumentHint(usage, currentLine) : null;
    let lines: string[] = [];
    if (items.length > 0) {
      this.showing = true;
      lines = this.buildSuggestionListLines(currentLine);
      if (display) {
        lines = lines.concat(this.buildArgumentHintLines(display));
      }
    } else {
      this.showing = false;
      if (display) { lines = this.buildArgumentHintLines(display); }
    }
    this.renderSuggestionArea(lines);
  }

  hide(): void {
    this.clear();
    this.showing = false;
    this.suggestionIndex = -1;
    this.currentSuggestions = [];
    this.visibleStart = 0;
  }

  /** Erases whatever's currently drawn in the display area — the single source of truth for "clear the old frame before drawing (or removing) the new one." */
  clear(): void {
    if (this.displayLines === 0) { return; }

    this.host.write('\r\n');  // Move to the display area

    for (let i = 0; i < this.displayLines; i++) {
      this.host.write('\x1b[2K'); // Clear entire line
      if (i < this.displayLines - 1) {
        this.host.write('\r\n');
      }
    }

    this.returnCursorToPrompt(this.displayLines);
    this.displayLines = 0;
  }

  /**
   * Returns the cursor to the prompt after drawing or erasing `lineCount` lines
   * in the area below it: up `lineCount` rows, back to column 0, then out to the
   * prompt's column. Uses a *relative* cursor-up (`\x1b[NA`) rather than an
   * absolute save/restore (`\x1b7`/`\x1b8`), because the `\r\n`s used to enter
   * the area may have scrolled the terminal and invalidated any saved row.
   */
  private returnCursorToPrompt(lineCount: number): void {
    this.host.write(`\x1b[${lineCount}A`);
    this.host.write('\r');
    const col = this.host.cursorColumn();
    if (col > 0) { this.host.write(`\x1b[${col}C`); }
  }

  /**
   * Builds the suggestion list's content lines — fully ANSI-styled, but with
   * no `\x1b[2K`/`\r\n` baked in. `renderSuggestionArea` is the single place
   * that turns a list of content strings into clear-and-draw ANSI, whether
   * it's drawing the list alone, the hint alone, or (when there's exactly one
   * suggestion left) both stacked together in one frame.
   */
  private buildSuggestionListLines(currentLine: string): string[] {
    // Calculate the visible window based on the selected index
    this.updateVisibleWindow();

    const lines: string[] = [];

    // Get only the completed parts of the command (everything before the last space or the whole line if no space)
    let completedText = '';
    if (currentLine.includes(' ')) {
      // If there's a space, get everything up to and including the last space
      const lastSpaceIndex = currentLine.lastIndexOf(' ');
      completedText = currentLine.substring(0, lastSpaceIndex + 1);
    }

    const prefix = completedText ? ansi.hidden(completedText) : '';

    // Show indicator if there are items above the visible window
    if (this.visibleStart > 0) {
      lines.push(prefix + ansi.gray('  ▲ (' + this.visibleStart + ' more above)'));
    }

    // Show visible suggestions in vertical list
    const visibleEnd = Math.min(
      this.visibleStart + this.maxVisible,
      this.currentSuggestions.length
    );

    for (let i = this.visibleStart; i < visibleEnd; i++) {
      // Show selection indicator and item
      if (i === this.suggestionIndex) {
        // Yellow for selected item with arrow indicator
        lines.push(prefix + ansi.brightYellow('→ ' + this.currentSuggestions[i]));
      } else {
        // Gray for other items with space for alignment
        lines.push(prefix + ansi.gray('  ' + this.currentSuggestions[i]));
      }
    }

    // Show indicator if there are items below the visible window
    if (visibleEnd < this.currentSuggestions.length) {
      const remaining = this.currentSuggestions.length - visibleEnd;
      lines.push(prefix + ansi.gray('  ▼ (' + remaining + ' more below)'));
    }

    // Show current position and page indicator at bottom
    lines.push(
      prefix + ansi.gray(
        '  [' + (this.suggestionIndex + 1) + '/' + this.currentSuggestions.length + '] ' +
        'Page ' + this.currentPage + '/' + this.totalPages
      )
    );

    return lines;
  }

  /**
   * Builds the argument-hint's content lines: the usage line, shown in full
   * and literally — with the argument the user is currently editing bolded
   * and everything else (command prefix and other tokens alike) gray. Same
   * "fully-styled content strings, no \x1b[2K/\r\n" convention as
   * `buildSuggestionListLines`, so `renderSuggestionArea` can draw either or
   * both in one frame.
   *
   * Shown alongside or in place of the suggestion list when a command has
   * argument structure worth showing — e.g. "/gamemode creative " (nothing
   * left to complete for the target selector, but worth showing what comes
   * next), or "/gamemode cr" (one match left — "creative" — where seeing the
   * full usage helps confirm that's the right command to commit to). The
   * actual parsing of `usage`/`line` into positions and hint text is pure —
   * see displayArgumentHint.ts — this is just the ANSI rendering of that
   * already-computed structure.
   */
  private buildArgumentHintLines(display: ArgumentHintDisplay): string[] {
    let usageLine = '  ' + ansi.gray(display.commandPrefixText);
    for (let i = 0; i < display.tokens.length; i++) {
      usageLine += ' ';
      usageLine += (i === display.currentArgIndex)
        ? ansi.boldBrightWhite(display.tokens[i])
        : ansi.gray(display.tokens[i]);
    }

    return [usageLine];
  }

  /**
   * Draws a single frame of suggestion-area content — one save/clear/restore
   * cycle, regardless of whether `lines` came from the list, the hint, or
   * both stacked together. `clear` (called centrally before this, by `render`)
   * has already erased whatever was there before, so this only ever draws
   * onto a blank area — each line gets its own `\x1b[2K` defensively, but
   * there's no "clear the old N lines" dance to duplicate here.
   */
  private renderSuggestionArea(lines: string[]): void {
    if (lines.length === 0) { return; }

    if (this.needsClearOnNextRender) {
      this.host.write('\x1b[J'); // Clear from cursor to end of screen
      this.needsClearOnNextRender = false;
    }

    this.host.write('\r\n');  // Move to the display area

    for (let i = 0; i < lines.length; i++) {
      this.host.write('\x1b[2K'); // Clear line first
      this.host.write(lines[i]);
      if (i < lines.length - 1) { this.host.write('\r\n'); }
    }

    this.displayLines = lines.length;
    this.returnCursorToPrompt(lines.length);
  }

  private updateVisibleWindow(): void {
    // Keep a buffer of 2 items above and below the selected item when possible
    const buffer = 2;

    // Update the visible window
    if (this.suggestionIndex < this.visibleStart + buffer) {
      // Scrolling up
      this.visibleStart = Math.max(0, this.suggestionIndex - buffer);
    } else if (this.suggestionIndex >= this.visibleStart + this.maxVisible - buffer) {
      // Scrolling down
      this.visibleStart = Math.min(
        this.suggestionIndex - this.maxVisible + buffer + 1,
        Math.max(0, this.currentSuggestions.length - this.maxVisible)
      );
    }

    // Final boundary check
    this.visibleStart = Math.max(0, this.visibleStart);
    this.visibleStart = Math.min(
      this.visibleStart,
      Math.max(0, this.currentSuggestions.length - this.maxVisible)
    );
  }
}
