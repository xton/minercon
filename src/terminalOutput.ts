// src/terminalOutput.ts
//
// Coordinates the CLI's logger output with in-place terminal redraws (the
// command-loading progress bar, the line editor's prompt, ...). Kept
// separate from cli.ts (which wires it to process.stdout and argv) so it can
// be unit-tested without a real TTY.

import * as ansi from './ansi';
import { Logger, LogLevel, meetsLogLevel } from './logger';
import * as fs from 'fs';

/** Formats a Date as "HH:MM:SS.mmm" — used to timestamp debug log lines down to the millisecond. */
function formatTimestamp(d: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Tracks the content of the terminal's current line - the bytes written
 * since the last `\r`/`\n` that haven't yet been followed by another
 * `\r`/`\n` - so log lines can be interleaved cleanly with in-place redraws
 * like the command-loading progress bar: clear the current line, print the
 * log line on its own line, then redraw whatever was there underneath it
 * (the "scrolling log pane below a fixed status line" behavior).
 */
export interface TerminalWriter {
  write(text: string): void;
  writeLogLine(line: string): void;
}

export function createTerminalWriter(sink: (text: string) => void): TerminalWriter {
  let currentLine = '';
  return {
    write(text: string): void {
      sink(text);
      const lastCr = text.lastIndexOf('\r');
      currentLine = lastCr === -1 ? currentLine + text : text.slice(lastCr + 1);
      const lastNl = currentLine.lastIndexOf('\n');
      if (lastNl !== -1) {
        currentLine = currentLine.slice(lastNl + 1);
      }
    },
    writeLogLine(line: string): void {
      if (currentLine) {
        this.write('\r\x1b[K' + line + currentLine);
      } else {
        this.write(line);
      }
    },
  };
}

/**
 * A `Logger` that writes through `terminal` (stdout) or, if `logFile` is
 * given, appends to that file instead. Messages below `logLevel` (default
 * "info", so "debug" is suppressed) are dropped entirely. Debug lines are
 * additionally prefixed with a millisecond-resolution timestamp, since
 * they're meant for performance investigation.
 */
export function createCliLogger(terminal: TerminalWriter, logFile?: string, logLevel: LogLevel = 'info'): Logger {
  function write(level: LogLevel, label: string, color: string, msg: string): void {
    if (!meetsLogLevel(level, logLevel)) { return; }

    const prefix = level === 'debug' ? `${formatTimestamp(new Date())} ${label}` : label;
    if (logFile) {
      // Synchronous append: log lines are infrequent, and a WriteStream's
      // async open left a window where a write could be queued before the
      // file existed on disk, racing readers (and CI) that check it back.
      fs.appendFileSync(logFile, `${prefix} ${msg}\n`);
    } else {
      terminal.writeLogLine(`${ansi.style(color, prefix)} ${msg}\n`);
    }
  }

  return {
    error:   (msg) => write('error',   'ERROR', ansi.RED,   msg),
    warning: (msg) => write('warning', 'WARN',  ansi.YELLOW, msg),
    info:    (msg) => write('info',    'INFO',  ansi.CYAN,  msg),
    debug:   (msg) => write('debug',   'DEBUG', ansi.GRAY,  msg),
  };
}
