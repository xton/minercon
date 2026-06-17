// src/completionQueries.ts
//
// Pure adapters between an input line and the server-side TabComplete plugin's
// `tabcomplete`/`cmdusage` wire format: build the argument string to send, and
// parse the response back. No state and no dependency on the completion state
// machine — shared by both `completionEngine` (which builds queries) and
// `RconCompletionBackend` (which builds queries and parses responses), so the
// backend needn't pull in the reducer just for these.

import { stripColors } from './ansi';
import { splitCommandLine } from './commandLine';

/**
 * Builds the argument string to send to the `tabcomplete` plugin command for
 * a given input line, or null if the line isn't a command at all.
 *
 * A trailing "-" is the plugin's convention for "the user typed a trailing
 * space here" (some RCON clients strip trailing whitespace before it reaches
 * the plugin). A bare "-" with no other parts asks for root-level completions:
 * Brigadier suggests by prefix-matching the *remaining* input, and an empty
 * remaining string matches every root command name.
 */
export function buildCompletionsQuery(input: string): string | null {
  if (!input.startsWith('/')) { return null; }
  const { parts, hasTrailingSpace } = splitCommandLine(input);

  if (parts.length === 0) { return '-'; }
  return hasTrailingSpace ? `${parts.join(' ')} -` : parts.join(' ');
}

/** Builds the argument string for `cmdusage`, or null if there's nothing to ask about yet. */
export function buildUsageQuery(input: string): string | null {
  if (!input.startsWith('/')) { return null; }
  const withoutSlash = input.slice(1).trim();
  return withoutSlash.length > 0 ? withoutSlash : null;
}

/** Every failure/meta message from both `tabcomplete` and `cmdusage` starts with "(". */
function isFailureResponse(response: string | undefined): boolean {
  return !response || response.trim().startsWith('(');
}

export function parseCompletionsResponse(response: string | undefined): string[] {
  if (isFailureResponse(response)) { return []; }
  return response!.split('\n').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * `cmdusage` resolves an input to one of three shapes: a clean failure like
 * "(too broad — use /help mvp or provide a subcommand)" (caught above), a
 * single matching command's usage line, or — when the input is still an
 * ambiguous prefix of multiple subcommands (e.g. "mvp c" matching both "mvp
 * create" and "mvp config") — one usage line per candidate, newline-separated.
 *
 * Only the single-match shape represents *the* usage for what's been typed —
 * multiple candidates means the command still hasn't resolved to one thing,
 * so (same as the explicit failure case) there's nothing unambiguous to show
 * yet. This is the actual "is there a single usage line" signal — the server
 * already does the resolution; we just need to recognize its shape.
 *
 * `cmdusage` echoes the command's help text verbatim, Minecraft `§` color
 * codes and all (e.g. "§b§bmvp create§b §a <portal-name> [destination]"). The
 * hint display applies its own ANSI styling on top of the plain usage string,
 * so any embedded color codes need to come out here, at the parsing boundary
 * — otherwise they show up as literal `§b` noise mixed in with our own escapes.
 */
export function parseUsageResponse(response: string | undefined): string {
  if (isFailureResponse(response)) { return ''; }

  const lines = response!.split('\n')
    .map(line => stripColors(line).trim())
    .filter(line => line.length > 0);

  return lines.length === 1 ? lines[0] : '';
}
