// src/ansi.ts
//
// Named ANSI SGR (Select Graphic Rendition) escape codes for terminal
// output, plus small `style`/color helpers that wrap text and reset
// afterward. Centralizes the raw `\x1b[...m` literals previously scattered
// across rconSession.ts, suggestionDisplay.ts, lineEditor.ts,
// connectionManager.ts, and cli.ts.
//
// This is unrelated to helpTextParsing.ts's Minecraft `§`-color-code table,
// which translates a different (server-controlled) input alphabet to ANSI.

export const RESET = '\x1b[0m';

export const DIM = '\x1b[2m';
export const REVERSE = '\x1b[7m';
export const REVERSE_OFF = '\x1b[27m';
export const HIDDEN = '\x1b[8m';

export const RED = '\x1b[31m';
export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const CYAN = '\x1b[36m';
export const GRAY = '\x1b[90m';
export const BRIGHT_YELLOW = '\x1b[93m';

export const BOLD_RED = '\x1b[1;31m';
export const BOLD_GREEN = '\x1b[1;32m';
export const BOLD_CYAN = '\x1b[1;36m';
export const BOLD_BRIGHT_WHITE = '\x1b[1;97m';

/** Wraps `text` in `code`, resetting afterward. */
export function style(code: string, text: string): string {
  return `${code}${text}${RESET}`;
}

export const red = (text: string): string => style(RED, text);
export const green = (text: string): string => style(GREEN, text);
export const yellow = (text: string): string => style(YELLOW, text);
export const cyan = (text: string): string => style(CYAN, text);
export const gray = (text: string): string => style(GRAY, text);
export const dim = (text: string): string => style(DIM, text);
export const brightYellow = (text: string): string => style(BRIGHT_YELLOW, text);
export const boldRed = (text: string): string => style(BOLD_RED, text);
export const boldGreen = (text: string): string => style(BOLD_GREEN, text);
export const boldCyan = (text: string): string => style(BOLD_CYAN, text);
export const boldBrightWhite = (text: string): string => style(BOLD_BRIGHT_WHITE, text);
export const reverse = (text: string): string => style(REVERSE, text);
export const hidden = (text: string): string => style(HIDDEN, text);
