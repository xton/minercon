// src/helpTextParsing.ts
//
// Pure parsing of Minecraft `/help` output into a `Parameter` tree. No
// state, no IO — every export here is a deterministic function of its
// arguments, which is what makes them directly unit-testable without
// constructing a `CommandAutocomplete`.
//
// `stripColors` (used throughout to normalize input before parsing) and the
// `formatMinecraftColors`/ANSI rendering side live in ansi.ts.

import { stripColors } from './ansi';

// Parameter types
export enum ParameterType {
  ARGUMENT = 'argument',          // <n>
  LITERAL = 'literal',            // literal text
  CHOICE_LIST = 'choice_list',    // (option1|option2)
  SUBCOMMAND = 'subcommand'        // subcommand with its own members
}

export interface Parameter {
  type: ParameterType;
  name?: string;                  // For arguments and subcommands
  literal?: string;                // For literal text
  optional: boolean;
  choices?: Parameter[];           // For choice lists
  position: number;                // Order in parameter list
  members?: Parameter[];           // For subcommand's parameters
  isComplete?: boolean;            // For subcommands - whether we've fetched all its members
}

/**
 * Tokenize parameter string handling nested structures
 */
export function tokenizeParameterString(str: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let depth = 0;
  let inBrackets = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if ((char === '<' || char === '[' || char === '(')) {
      if (depth === 0) {
        if (current.trim()) {
          // This is a literal
          tokens.push(current.trim());
          current = '';
        }
        inBrackets = true;
      }
      depth++;
      current += char;
    } else if ((char === '>' || char === ']' || char === ')')) {
      depth--;
      current += char;
      if (depth === 0) {
        tokens.push(current.trim());
        current = '';
        inBrackets = false;
      }
    } else if (char === ' ' && depth === 0 && !inBrackets) {
      if (current.trim()) {
        tokens.push(current.trim());
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    tokens.push(current.trim());
  }

  return tokens;
}

/**
 * Parse a single parameter token
 */
export function parseParameter(token: string, position: number): Parameter | null {
  // Check for choice list (option1|option2|...)
  if (token.startsWith('(') && token.endsWith(')')) {
    const choicesStr = token.slice(1, -1);
    const choices = choicesStr.split('|').map((choice, idx) => ({
      type: ParameterType.LITERAL,
      literal: choice.trim(),
      optional: false,
      position: idx
    } as Parameter));

    return {
      type: ParameterType.CHOICE_LIST,
      choices,
      optional: false,
      position
    };
  }

  // Check for optional argument [name] or [<name>]
  if (token.startsWith('[') && token.endsWith(']')) {
    let name = token.slice(1, -1); // Remove [ and ]
    // Also remove inner angle brackets if present
    if (name.startsWith('<') && name.endsWith('>')) {
      name = name.slice(1, -1); // Remove < and >
      return {
        type: ParameterType.ARGUMENT,
        name,
        optional: true,
        position
      };
    }
    // For [literal] without angle brackets, this could be an optional subcommand
    // Return as LITERAL but we'll handle it specially in loadCommandDetails
    return {
      type: ParameterType.LITERAL,
      literal: name,  // Store WITHOUT the brackets
      optional: true,
      position
    };
  }

  // Check for required argument <name>
  if (token.startsWith('<') && token.endsWith('>')) {
    const name = token.slice(1, -1);
    return {
      type: ParameterType.ARGUMENT,
      name,
      optional: false,
      position
    };
  }

  // Otherwise it's a literal (could be a subcommand name)
  // We'll determine if it's actually a subcommand later when we see it has members
  return {
    type: ParameterType.LITERAL,
    literal: token,
    optional: false,
    position
  };
}

/**
 * Parse command help output to extract parameters
 */
export function parseCommandHelp(helpText: string): Parameter[] {
  const parameters: Parameter[] = [];
  const stripped = stripColors(helpText).trim();

  // Remove the command name from the beginning if present
  const syntaxMatch = stripped.match(/^\/?\w+\s+(.*)/);
  const paramString = syntaxMatch ? syntaxMatch[1] : stripped;

  // Split into tokens - handle nested brackets/parens
  const tokens = tokenizeParameterString(paramString);

  tokens.forEach((token, index) => {
    const param = parseParameter(token, index);
    if (param) {
      parameters.push(param);
    }
  });

  return parameters;
}

/**
 * Result of classifying the first token of a `/help <command> ...` syntax
 * line: either it's a literal/subcommand name introducing a variant (with
 * the rest of the tokens as that variant's own parameters), or it's an
 * argument/choice-list, meaning every token is a direct parameter of the
 * command itself. `null` means there were no tokens to classify.
 */
export type ParameterTokenClassification =
  | { kind: 'variant'; name: string; optional: boolean; parameters: Parameter[] }
  | { kind: 'direct'; parameters: Parameter[] }
  | null;

/**
 * Classify a tokenized parameter string as either a named subcommand variant
 * or a direct parameter list, parsing the relevant tokens along the way.
 */
export function classifyParameterTokens(tokens: string[]): ParameterTokenClassification {
  if (tokens.length === 0) {
    return null;
  }

  const firstToken = tokens[0];

  // Determine if first token is a literal/subcommand or an argument
  // FIXED: Better detection for optional subcommands vs optional arguments
  let isArgument = false;
  if (firstToken.startsWith('<')) {
    // <arg> - required argument
    isArgument = true;
  } else if (firstToken.startsWith('[') && firstToken.endsWith(']')) {
    // Could be [<arg>] or [subcommand]
    const inner = firstToken.slice(1, -1);
    if (inner.startsWith('<') && inner.endsWith('>')) {
      // [<arg>] - optional argument
      isArgument = true;
    } else {
      // [subcommand] - optional subcommand, treat as subcommand
      isArgument = false;
    }
  } else if (firstToken.startsWith('(') && firstToken.endsWith(')')) {
    // (choice1|choice2) - choice list, treat as argument
    isArgument = true;
  }

  if (isArgument) {
    // Every token is a direct parameter of the command/subcommand itself
    const parameters: Parameter[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const param = parseParameter(tokens[i], i);
      if (param) {
        parameters.push(param);
      }
    }
    return { kind: 'direct', parameters };
  }

  // First token is a literal/subcommand name introducing a variant
  let name = firstToken;
  let optional = false;

  // Strip optional brackets if present
  if (name.startsWith('[') && name.endsWith(']')) {
    name = name.slice(1, -1); // Remove [ and ]
    optional = true;
  }

  const parameters: Parameter[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const param = parseParameter(tokens[i], i - 1);
    if (param) {
      parameters.push(param);
    }
  }

  return { kind: 'variant', name, optional, parameters };
}

/**
 * Result of parsing every `<commandPath> ...` syntax line out of a help
 * response: either a set of named subcommand variants (first token a
 * literal), or a single direct parameter list (first token an argument or
 * choice-list — the last such line wins), or both empty if nothing matched.
 */
/**
 * The argument list following a named subcommand variant (e.g. "[<value>]"
 * in "/gamerule doDaylightCycle [<value>]"), plus whether the variant's name
 * itself came from a `[bracketed]` token (e.g. "[peaceful]" in
 * "/minecraft:difficulty [peaceful]") vs a bare/required one (e.g. "list" in
 * "/team list [<team>]"). `optional` distinguishes a subcommand verb (which
 * may have further syntax discoverable via its own `help`/`minecraft:help`
 * fetch) from one literal value of an enum-style argument (which never does)
 * - see `loadSubcommandDetails`.
 */
export interface VariantInfo {
  optional: boolean;
  members: Parameter[];
}

export interface HelpLinesResult {
  variants: Map<string, VariantInfo>;
  direct: Parameter[] | null;
}

/**
 * True iff `helpText` looks like a Bukkit `/help <command>` page - a
 * "§e--------- §fHelp: /<cmd> ----...§e" banner line, typically followed by
 * Description:/Usage:/Aliases: lines - rather than a flat Brigadier blob
 * (`minecraft:help`, or vanilla's `help <path>`) that packs multiple
 * `/cmd ...` entries with no separators.
 *
 * This distinguishes which normalizer to apply: concatenated Brigadier blobs
 * never contain a `---` banner line and are safe to re-split on `/`
 * (`splitConcatenatedHelpLines`), but Bukkit's hand-written Usage strings are
 * inconsistent across commands/plugins and occasionally use `/` inside
 * argument brackets (e.g. `[foo/bar]`) - re-splitting those would corrupt
 * them, so Bukkit pages must go through `extractBukkitUsageLines` instead,
 * which extracts the Usage line(s) verbatim.
 */
export function looksLikeBukkitHelpPage(helpText: string): boolean {
  return helpText.split('\n').some(line => stripColors(line).trim().startsWith('---'));
}

/**
 * Re-split a help response that packs multiple `/cmd ...` entries onto one
 * line with no separators (e.g. a `minecraft:help` blob, or vanilla's `help
 * <path>` for a multi-variant command like `gamerule`/`team`/`debug`) into
 * one entry per line, ready for `parseHelpResponse`/`parseHelpLines`.
 *
 * Header/separator (`---...`) and blank lines are dropped first, so a
 * `§e--------- §fHelp: /<cmd> §e----...` banner line - which itself contains
 * a `/` - doesn't get re-split into a bogus `/<cmd> ----...` entry.
 */
export function splitConcatenatedHelpLines(text: string): string {
  return text.split('\n')
    .filter(line => {
      const stripped = stripColors(line).trim();
      return stripped && !stripped.startsWith('---');
    })
    .join('\n')
    .replace(/\//g, '\n/');
}

/**
 * An alias-to-target mapping extracted from a `<alias> -> <target>` redirect
 * line, as returned by `parseAliasRedirect`.
 */
export interface AliasRedirect {
  alias: string;
  target: string;
}

/**
 * Parse a single (already `stripColors`'d and trimmed) help line as a
 * vanilla `minecraft:help` alias redirect of the form `/<alias> -> <target>`
 * (e.g. `/tp -> teleport`, `/minecraft:xp -> experience`). Either side may
 * carry a namespace prefix (e.g. `minecraft:`); namespace prefixes are
 * preserved verbatim on both sides - per "ingest everything", a namespaced
 * alias like `minecraft:tp` is its own root command, not folded into `tp`.
 * Returns `null` if `line` doesn't match this shape.
 */
export function parseAliasRedirect(line: string): AliasRedirect | null {
  const match = line.match(/^\/([a-zA-Z0-9_:-]+)\s*->\s*([a-zA-Z0-9_:-]+)$/);
  if (!match) {
    return null;
  }
  return { alias: match[1], target: match[2] };
}

/**
 * Parse every line of `text` that describes `commandPath`'s syntax (an
 * optional leading `/`, then `commandPath` with internal spaces matching
 * runs of whitespace, then the argument tokens), collecting subcommand
 * variants and/or a direct parameter list. Lines for other commands, alias
 * redirects (`-> target`), and lines with no arguments at all are ignored.
 *
 * `text` is matched line-by-line (split on `\n`) — callers whose source may
 * pack multiple commands' syntax onto one line without separators (e.g. a
 * `minecraft:help` blob, where consecutive commands are simply concatenated)
 * must first replace `/` with `\n/` to re-split it into one command per line.
 */
export function parseHelpLines(text: string, commandPath: string): HelpLinesResult {
  const escaped = commandPath
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/ /g, '\\s+');
  const pattern = new RegExp(`^/?${escaped}(?::)?\\s*(.*)$`, 'i');

  const variants: Map<string, VariantInfo> = new Map();
  let direct: Parameter[] | null = null;

  for (const rawLine of text.split('\n')) {
    const stripped = stripColors(rawLine).trim();
    if (!stripped || stripped.startsWith('---')) { continue; }

    const match = stripped.match(pattern);
    if (!match) { continue; }

    const afterCommand = match[1] || '';
    if (!afterCommand || afterCommand.startsWith('->')) { continue; }

    const tokens = tokenizeParameterString(afterCommand);
    const classified = classifyParameterTokens(tokens);
    if (classified?.kind === 'variant') {
      variants.set(classified.name, { optional: classified.optional, members: classified.parameters });
    } else if (classified?.kind === 'direct') {
      direct = classified.parameters;
    }
  }

  return { variants, direct };
}

/**
 * True iff `parameters` is exactly a bare `<args>`/`[<args>]` placeholder -
 * the generic stand-in Bukkit emits (e.g. for `minecraft:help <cmd>` on
 * commands that aren't Brigadier-backed, like `version`/`reload`/`plugins`)
 * when it has no real argument info, regardless of whether it's optional.
 */
function isArgsPlaceholder(parameters: Parameter[]): boolean {
  return parameters.length === 1
    && parameters[0].type === ParameterType.ARGUMENT
    && parameters[0].name === 'args';
}

/**
 * True iff `parameters` is exactly the generic `[<args>]` placeholder Bukkit
 * emits for `minecraft:help <cmd>` on commands that aren't Brigadier-backed
 * (e.g. `version`, `reload`, `plugins`) — i.e. no real argument info.
 */
export function isGenericArgsPlaceholder(parameters: Parameter[]): boolean {
  return isArgsPlaceholder(parameters) && parameters[0].optional === true;
}

/**
 * True iff `members` carries real, usable argument info for a subcommand
 * variant - i.e. it's non-empty and not just an `<args>`/`[<args>]`
 * placeholder (which means "no info available", whether or not it's
 * optional). Used to decide whether the usage already parsed from a parent
 * command's help output is trustworthy enough to skip a further per-subcommand
 * help round trip.
 */
export function hasUsableArguments(members: Parameter[]): boolean {
  return members.length > 0 && !isArgsPlaceholder(members);
}

/**
 * True iff `response` is the Brigadier "unknown namespace" syntax error
 * returned for `minecraft:help` on servers where the `minecraft:` command
 * namespace prefix isn't registered (vanilla/fabric) — distinct from the
 * normal "Unknown command or insufficient permissions" not-found message.
 */
export function isUnsupportedNamespaceError(response: string): boolean {
  return /^Unknown or incomplete command/i.test(stripColors(response).trim());
}

/**
 * Extract the `Usage: ...` line(s) from a Bukkit-style `/help <command>`
 * response (e.g. "Description: ...\nUsage: /version [plugin name]\nAliases:
 * ..."), normalized so each reads as `<commandPath> ...` for `parseHelpLines`.
 * Returns `[]` if there's no Usage line, or if its content is just the bare
 * command name with nothing after it — the generic response Bukkit gives for
 * Brigadier-backed (vanilla) commands ("Description: A Mojang provided
 * command.\nUsage: <name>"), which carries no argument info.
 */
export function extractBukkitUsageLines(helpText: string, commandPath: string): string[] {
  const lines = stripColors(helpText).split('\n').map(line => line.trim());
  const usageIndex = lines.findIndex(line => /^Usage:\s*/i.test(line));
  if (usageIndex === -1) {
    return [];
  }

  const result: string[] = [lines[usageIndex].replace(/^Usage:\s*/i, '')];
  for (let i = usageIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^[A-Za-z][A-Za-z ]*:/.test(line) || line.startsWith('---')) {
      break;
    }
    result.push(line);
  }

  const normalizedPath = commandPath.toLowerCase();
  return result.filter(line => line.replace(/^\//, '').toLowerCase() !== normalizedPath);
}

/**
 * Extract alias names from a Bukkit-style `/help <command>` response's
 * `Aliases: a, b, c` line (e.g. "Description: ...\nUsage: ...\nAliases: ver,
 * about"). Returns `[]` if there's no Aliases line.
 */
export function extractBukkitAliases(helpText: string): string[] {
  const lines = stripColors(helpText).split('\n').map(line => line.trim());
  const aliasesLine = lines.find(line => /^Aliases:\s*/i.test(line));
  if (!aliasesLine) {
    return [];
  }

  return aliasesLine.replace(/^Aliases:\s*/i, '')
    .split(',')
    .map(alias => alias.trim())
    .filter(alias => alias.length > 0);
}

/**
 * Build the parameter structure representing a set of collected variants:
 * a single SUBCOMMAND if there's only one, or a CHOICE_LIST wrapping a
 * SUBCOMMAND for each variant (in encounter order) otherwise.
 */
export function buildParameterStructureFromVariants(variants: Map<string, VariantInfo>): Parameter[] {
  if (variants.size === 0) {
    return [];
  }

  const subcommandChoices: Parameter[] = [];

  for (const [name, { optional, members }] of variants) {
    subcommandChoices.push({
      type: ParameterType.SUBCOMMAND,
      name,
      literal: name,
      optional,
      position: subcommandChoices.length,
      members,
      isComplete: false
    });
  }

  // If there's only one variant, use it directly; otherwise wrap in a choice list
  if (subcommandChoices.length === 1) {
    return [subcommandChoices[0]];
  }

  return [{
    type: ParameterType.CHOICE_LIST,
    optional: false,
    position: 0,
    choices: subcommandChoices
  }];
}
