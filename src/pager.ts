// src/pager.ts
//
// A `more`-style, append-only terminal pager for large command output.
//
// Why append-only (and not a `less`-style repaint): the server-side
// de-pagination (the `rcat` plugin wrap) hands us the *full* output in one
// response, which can be hundreds of lines. We page it at the terminal's real
// height — but the paged content MUST remain in the terminal's scrollback after
// the pager exits (an alternate-screen / repaint pager would restore the screen
// and wipe it, a regression). So we only ever print *forward*, below what's
// already shown, and draw a one-line status prompt that is erased in place
// before the next batch. Backward viewing is the terminal's own scrollback,
// which works precisely because nothing is ever cleared.
//
// The pager reads from a `LineSource` rather than a fixed array so a future
// just-in-time "fetch the next page as you scroll" source (the deferred
// no-plugin option C) can drop into the same UI unchanged.

import { dim, stripAnsi } from './ansi';

/** A sequence of already-formatted (ANSI-colored) output lines. */
export interface LineSource {
  length(): number;
  lineAt(index: number): string;
}

/** The trivial in-memory source: the whole response, split into lines. */
export class ArrayLineSource implements LineSource {
  constructor(private readonly lines: string[]) {}
  length(): number { return this.lines.length; }
  lineAt(index: number): string { return this.lines[index]; }
}

/** Just the slice of the terminal session the pager needs. */
export interface PagerHost {
  write(text: string): void;
  dimensions(): { columns: number; rows: number } | undefined;
}

export const FALLBACK_ROWS = 24;
export const FALLBACK_COLS = 80;

/**
 * Number of visual terminal rows a single (possibly ANSI-styled) source line
 * occupies once the terminal soft-wraps it at `columns`. ANSI-aware: color/
 * style escapes are stripped before measuring so they don't count toward width,
 * and — because we only *count* here and let the terminal do the actual wrap —
 * no escape sequence is ever split. An empty line still occupies one row.
 */
export function visualRowCount(line: string, columns: number): number {
  const width = stripAnsi(line).length;
  if (width === 0) { return 1; }
  return Math.ceil(width / Math.max(1, columns));
}

/**
 * Drives one paging interaction over `source`. Created and `start()`ed once the
 * session decides the output is too tall for the window; fed keystrokes via
 * `handleKey` until it calls `onDone` (which restores the prompt).
 */
export class Pager {
  // Index of the next not-yet-printed source line.
  private next = 0;
  // Whether a status prompt line is currently drawn on the cursor's row.
  private statusShown = false;
  private finished = false;

  constructor(
    private readonly host: PagerHost,
    private readonly source: LineSource,
    private readonly onDone: () => void,
  ) {}

  /** True once the pager has exited (so the session can drop its reference). */
  get isFinished(): boolean { return this.finished; }

  /** Prints the first screenful and the status prompt. */
  start(): void {
    this.advancePage();
  }

  private rows(): number { return this.host.dimensions()?.rows ?? FALLBACK_ROWS; }
  private columns(): number { return this.host.dimensions()?.columns ?? FALLBACK_COLS; }

  /** Reserve one row for the status prompt; never less than one content row. */
  private pageHeight(): number { return Math.max(1, this.rows() - 1); }

  private clearStatus(): void {
    if (this.statusShown) {
      // Return to column 0 and clear the line in place — never clears the
      // screen, never touches the alternate buffer, so scrollback is retained.
      this.host.write('\r\x1b[K');
      this.statusShown = false;
    }
  }

  private drawStatus(): void {
    const shown = this.next;
    const total = this.source.length();
    this.host.write(dim(`-- More -- (${shown}/${total})  Space: more · G: all · q: quit`));
    this.statusShown = true;
  }

  /** Prints source lines (recomputing height each call) until `maxRows` visual rows are used or the source is exhausted. */
  private printRows(maxRows: number): void {
    const cols = this.columns();
    let used = 0;
    while (this.next < this.source.length() && used < maxRows) {
      const line = this.source.lineAt(this.next);
      this.host.write(`${line}\r\n`);
      used += visualRowCount(line, cols);
      this.next++;
    }
  }

  private atEnd(): boolean { return this.next >= this.source.length(); }

  /** After printing a batch: either redraw the status prompt, or finish if done. */
  private afterBatch(): void {
    if (this.atEnd()) {
      this.finish();
    } else {
      this.drawStatus();
    }
  }

  private advancePage(): void {
    this.clearStatus();
    this.printRows(this.pageHeight());
    this.afterBatch();
  }

  private advanceLine(): void {
    this.clearStatus();
    this.printRows(1);
    this.afterBatch();
  }

  private printAllRemaining(): void {
    this.clearStatus();
    this.printRows(Number.POSITIVE_INFINITY);
    this.finish();
  }

  private finish(): void {
    this.clearStatus();
    this.finished = true;
    this.onDone();
  }

  /**
   * Handles one input chunk while the pager is active. Forward-only by design;
   * scrolling back up is the terminal's native scrollback.
   */
  handleKey(data: string): void {
    if (this.finished) { return; }
    switch (data) {
      case ' ':
      case 'f':
      case '\x1b[6~': // PageDown
        this.advancePage();
        break;
      case '\r':
      case '\n':
      case '\x1b[B': // Down arrow
      case 'j':
        this.advanceLine();
        break;
      case 'G':
        this.printAllRemaining();
        break;
      case 'q':
      case '\x03': // Ctrl+C
        this.finish();
        break;
      default:
        // Ignore everything else (incl. attempts to scroll up — use the
        // terminal's own scrollback).
        break;
    }
  }
}
