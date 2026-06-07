// src/argumentHint.ts
//
// Pure formatting for the "argument hint" display: given a command's usage
// string (e.g. "gamemode <mode> [<target>]") and the line the user has typed
// so far, work out which argument position they're at, which parts of the
// usage are already typed, and what (if any) contextual hint to show for the
// argument they're currently entering.
//
// This is presentation logic, not decision logic — it has no notion of
// fetching, timing, or staleness — so it lives apart from completionEngine's
// state machine, as its own pure, independently-testable function.

const ARGUMENT_TOKEN_PATTERN = /(<[^>]+>|\[[^\]]+\]|\([^)]+\))/g;

export interface ArgumentHintDisplay {
  /** The literal command-path prefix (with leading slash) to render concealed, e.g. "/gamemode". */
  commandPrefixText: string;
  /** Argument tokens parsed out of the usage string, in order, e.g. ["<mode>", "[<target>]"]. */
  tokens: string[];
  /** The argument words the user has actually typed so far (excludes the command path). */
  argumentParts: string[];
  /** How many of `tokens` correspond to arguments the user has already finished typing. */
  completedArgCount: number;
  /** Index into `tokens` of the argument currently being typed, or -1 if still on the command path. */
  currentArgIndex: number;
  /** A short contextual hint for the current argument, if we have one for its shape. */
  hint: string | null;
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
  const argumentParts = parts.slice(commandPrefixWordCount);

  let completedArgCount = 0;
  if (hasTrailingSpace) {
    completedArgCount = argumentParts.length;
  } else if (argumentParts.length > 0) {
    completedArgCount = argumentParts.length - 1;
  }

  let currentArgIndex: number;
  if (argumentParts.length === 0 && !hasTrailingSpace) {
    currentArgIndex = -1;        // still typing the command/subcommand itself
  } else if (hasTrailingSpace) {
    currentArgIndex = argumentParts.length;       // ready for the next argument
  } else {
    currentArgIndex = argumentParts.length - 1;   // currently typing this argument
  }

  const hint = (currentArgIndex >= 0 && currentArgIndex < tokens.length)
    ? hintForToken(tokens[currentArgIndex])
    : null;

  return { commandPrefixText, tokens, argumentParts, completedArgCount, currentArgIndex, hint };
}

function hintForToken(token: string): string | null {
  if (token.startsWith('(') && token.endsWith(')')) {
    return 'Choose one: ' + token.slice(1, -1).replace(/\|/g, ', ');
  }

  const argName = token.replace(/[<>[\]()]/g, '');
  if (argName.includes('player') || argName.includes('target')) { return 'Player name or @selector (@p, @a, @r, @e, @s)'; }
  if (argName.includes('team')) { return 'Team name or identifier'; }
  if (argName.includes('key')) { return 'Configuration key or setting name'; }
  if (argName.includes('value')) { return 'Value for the specified option'; }
  if (argName.includes('item')) { return 'Item ID (e.g., minecraft:diamond, stone, iron_sword)'; }
  if (argName.includes('block')) { return 'Block ID (e.g., minecraft:stone, dirt, oak_planks)'; }
  if (argName.includes('count') || argName.includes('amount')) { return 'Number (1-64 for most items)'; }
  if (argName.includes('data')) { return 'Data value or NBT tags'; }
  if (argName.includes('pos') || argName.includes('x') || argName.includes('y') || argName.includes('z')) { return 'Coordinates (x y z) or relative (~x ~y ~z)'; }
  if (argName.includes('message') || argName.includes('text')) { return 'Text string (use quotes for spaces)'; }
  if (argName.includes('mode')) { return 'Game mode option'; }
  if (argName.includes('rule')) { return 'Game rule name'; }
  if (argName === 'args' || argName === 'arguments') { return 'Additional arguments specific to this command'; }
  return null;
}
