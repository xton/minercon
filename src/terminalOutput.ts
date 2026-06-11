// src/terminalOutput.ts
//
// Coordinates the CLI's logger output with in-place terminal redraws (the
// command-loading progress bar, the line editor's prompt, ...). Kept
// separate from cli.ts (which wires it to process.stdout and argv) so it can
// be unit-tested without a real TTY.

import * as ansi from './ansi';
import { Logger } from './logger';
import * as fs from 'fs';

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

/** A `Logger` that writes through `terminal` (stdout) or, if `logFile` is given, appends to that file instead. */
export function createCliLogger(terminal: TerminalWriter, logFile?: string): Logger {
  let stream: fs.WriteStream | undefined;
  if (logFile) {
    stream = fs.createWriteStream(logFile, { flags: 'a' });
  }

  function write(level: string, color: string, msg: string): void {
    const line = `${ansi.style(color, level)} ${msg}\n`;
    if (stream) {
      stream.write(`${level} ${msg}\n`);
    } else {
      terminal.writeLogLine(line);
    }
  }

  return {
    error:   (msg) => write('ERROR', ansi.RED, msg),
    warning: (msg) => write('WARN',  ansi.YELLOW, msg),
    info:    (msg) => write('INFO',  ansi.CYAN, msg),
  };
}
