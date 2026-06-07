// src/argumentHint.ts
//
// Pure formatting for the "argument hint" display: given a command's usage
// string (e.g. "gamemode <mode> [<target>]") and the line the user has typed
// so far, work out which argument position they're at and which token in the
// usage string corresponds to it (so it can be highlighted).
//
// This is presentation logic, not decision logic — it has no notion of
// fetching, timing, or staleness — so it lives apart from completionEngine's
// state machine, as its own pure, independently-testable function.

const ARGUMENT_TOKEN_PATTERN = /(<[^>]+>|\[[^\]]+\]|\([^)]+\))/g;

export interface ArgumentHintDisplay {
  /** The literal command-path prefix (with leading slash), e.g. "/gamemode". */
  commandPrefixText: string;
  /** Argument tokens parsed out of the usage string, in order, e.g. ["<mode>", "[<target>]"]. */
  tokens: string[];
  /** Index into `tokens` of the argument currently being typed, or -1 if still on the command path. */
  currentArgIndex: number;
}

/** Returns null when there's no usage text to show anything for. */
export function formatArgumentHint(usage: string, line: string): ArgumentHintDisplay | null {
  if (!usage) { return null; }

  const tokens = usage.match(ARGUMENT_TOKEN_PATTERN) || [];

  // The literal words before the first argument token are the command path —
  // derived straight from the usage string so we don't need a separate
  // "commandPath" concept threaded in from wherever the usage came from.
  const firstTokenStart = usage.search(ARGUMENT_TOKEN_PATTERN);
  const literalPrefix = (firstTokenStart >= 0 ? usage.slice(0, firstTokenStart) : usage).trim();
  const commandPrefixWordCount = literalPrefix.length > 0 ? literalPrefix.split(/\s+/).length : 0;
  const commandPrefixText = '/' + literalPrefix;

  const parts = line.trim().split(' ').filter(p => p.length > 0);
  const hasTrailingSpace = line.endsWith(' ');
  const argumentCount = Math.max(0, parts.length - commandPrefixWordCount);

  let currentArgIndex: number;
  if (argumentCount === 0 && !hasTrailingSpace) {
    currentArgIndex = -1;                  // still typing the command/subcommand itself
  } else if (hasTrailingSpace) {
    currentArgIndex = argumentCount;       // ready for the next argument
  } else {
    currentArgIndex = argumentCount - 1;   // currently typing this argument
  }

  return { commandPrefixText, tokens, currentArgIndex };
}
