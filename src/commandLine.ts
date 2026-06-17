// src/commandLine.ts
//
// Splitting a *typed command invocation* into its space-separated words —
// the shared counterpart to commandTreeParsingBrigadier's
// `tokenizeParameterString`, which tokenizes a *usage/grammar string*.
//
// The distinction matters: a usage string uses `<>`/`[]`/`()` as structural
// metacharacters (and `tokenizeParameterString` keeps those groups whole),
// whereas a command line the user is typing carries those same characters as
// literal argument data — target selectors (`@e[type=cow]`), NBT (`{...}`),
// coordinates — where only whitespace separates arguments and a half-typed
// bracket is just text. So command lines are split here, plainly on
// whitespace, and never run through the grammar tokenizer.

export interface CommandLineParts {
  /** The whitespace-separated words after a leading `/`, empties removed. */
  parts: string[];
  /**
   * Whether the raw input ends in a space — i.e. the user has finished the
   * current token and is positioned for the next one. Tracked separately
   * because `parts` alone can't distinguish "gamemode" from "gamemode ".
   */
  hasTrailingSpace: boolean;
}

/**
 * Split a typed command line into its words, dropping a single leading `/`
 * if present. Callers that care whether the input *is* a command (starts with
 * `/`) should check that themselves; this only parses the words out.
 */
export function splitCommandLine(input: string): CommandLineParts {
  const hasTrailingSpace = input.endsWith(' ');
  const body = input.trim().replace(/^\//, '');
  const parts = body.split(/\s+/).filter(p => p.length > 0);
  return { parts, hasTrailingSpace };
}
