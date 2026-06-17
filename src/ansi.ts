// src/ansi.ts
//
// Named ANSI SGR (Select Graphic Rendition) escape codes for terminal
// output, plus small `style`/color helpers that wrap text and reset
// afterward. Centralizes the raw `\x1b[...m` literals previously scattered
// across rconSession.ts, displaySuggestion.ts, lineEditor.ts,
// rconConnectionManager.ts, and cli.ts.
//
// Also home to `formatMinecraftColors`/`stripColors`, which translate the
// server-controlled Minecraft `§`-color-code alphabet to/from ANSI - a
// distinct input alphabet from the literals above, but the same output
// format, so it lives alongside them rather than in
// commandTreeParsingBrigadier.ts.

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

// Minecraft `§`-color codes to ANSI escape sequences
const MINECRAFT_COLOR_MAP: { [key: string]: string } = {
  '§0': '\x1b[30m',    // Black
  '§1': '\x1b[34m',    // Dark Blue
  '§2': '\x1b[32m',    // Dark Green
  '§3': '\x1b[36m',    // Dark Aqua
  '§4': '\x1b[31m',    // Dark Red
  '§5': '\x1b[35m',    // Dark Purple
  '§6': '\x1b[33m',    // Gold
  '§7': '\x1b[37m',    // Gray
  '§8': '\x1b[90m',    // Dark Gray
  '§9': '\x1b[94m',    // Blue
  '§a': '\x1b[92m',    // Green
  '§b': '\x1b[96m',    // Aqua
  '§c': '\x1b[91m',    // Red
  '§d': '\x1b[95m',    // Light Purple
  '§e': '\x1b[93m',    // Yellow
  '§f': '\x1b[97m',    // White
  '§r': RESET,         // Reset
  '§l': '\x1b[1m',     // Bold
  '§o': '\x1b[3m',     // Italic
  '§n': '\x1b[4m',     // Underline
  '§m': '\x1b[9m',     // Strikethrough
  '§k': '\x1b[5m',     // Obfuscated (blinking)
};

// Matches any single `§X` color/format code; the replacer looks each up in
// MINECRAFT_COLOR_MAP. The character class covers exactly that map's keys.
const MINECRAFT_COLOR_PATTERN = /§[0-9a-fklmnor]/g;

/**
 * Convert Minecraft `§`-color codes to ANSI escape sequences.
 */
export function formatMinecraftColors(text: string): string {
  // Collapse the `Â§` UTF-8 mojibake of the section sign first (same encodings
  // stripColors handles) — otherwise the orphaned `Â` is left in the colored
  // output once the `§x` after it is converted.
  let result = text.replace(/Â§/g, '§').replace(MINECRAFT_COLOR_PATTERN, code => MINECRAFT_COLOR_MAP[code] ?? '');
  if (!result.endsWith(RESET)) {
    result += RESET;
  }
  return result;
}

/**
 * Remove Minecraft `§`-color codes, e.g. before parsing.
 */
export function stripColors(text: string): string {
  // Handle both § and Â§ encodings (UTF-8 issues)
  return text.replace(/[§Â]§[0-9a-fklmnor]/g, '')
    .replace(/§[0-9a-fklmnor]/g, '');
}
