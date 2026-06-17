// src/commandTreeSuggestions.ts
//
// Pure suggestion generation: given the command tree `CommandTreeCrawler`
// builds and the user's current input line, work out what to suggest next
// and what argument-help text to show. No state, no IO — a deterministic
// function of the tree and the input.

import { ParameterType, Parameter, CommandNode, parameterLabel } from './commandTree';
import { splitCommandLine } from './commandLine';

export interface SuggestionResult {
  suggestions: string[];
  argumentHelp?: string;
  /**
   * The command path consumed so far - the root command name plus any
   * literal/subcommand tokens navigated past (e.g. "mvp config" for
   * `/mvp config <property> <value>`), but NOT argument values the user has
   * typed (e.g. a player name). Paired with `argumentHelp`, this reconstructs
   * a usage line in the same shape as the server's `cmdusage` response (e.g.
   * "clear [<targets>] [<item>]"), which `formatArgumentHint` expects.
   * Present iff `argumentHelp` is.
   */
  commandPath?: string;
}

/**
 * Get suggestions based on current input
 */
export function getSuggestions(
  rootCommands: Map<string, CommandNode>,
  isReady: boolean,
  input: string
): SuggestionResult {
  if (!isReady) {
    return { suggestions: [], argumentHelp: undefined };
  }

  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return { suggestions: [], argumentHelp: undefined };
  }

  const { parts, hasTrailingSpace } = splitCommandLine(input);
  const commandName = parts[0];

  // Handle root command suggestions
  if (parts.length === 0 || (parts.length === 1 && !hasTrailingSpace)) {
    const suggestions = Array.from(rootCommands.keys())
      .filter(cmd => cmd.startsWith(commandName || ''))
      .sort();
    return { suggestions, argumentHelp: undefined };
  }

  // Find the command node
  const rootNode = rootCommands.get(commandName);
  if (!rootNode) {
    return { suggestions: [], argumentHelp: undefined };
  }

  // Navigate through the parameter tree
  let currentParameters = rootNode.members;
  let paramIndex = 1; // Start after the command name

  // The command path consumed so far (root command + any literal/subcommand
  // tokens navigated past) - see SuggestionResult.commandPath.
  const pathParts = [commandName];

  // Navigate through completed parts (not including what we're currently typing)
  const partsToNavigate = hasTrailingSpace ? parts.length : parts.length - 1;

  while (paramIndex < partsToNavigate && currentParameters.length > 0) {
    const currentPart = parts[paramIndex];
    let navigated = false;

    // Get the first parameter at this position
    const firstParam = currentParameters[0];

    if (firstParam.type === ParameterType.SUBCOMMAND) {
      // Direct subcommand
      if (firstParam.name === currentPart) {
        currentParameters = firstParam.members;
        navigated = true;
      }
    } else if (firstParam.type === ParameterType.CHOICE_LIST) {
      // Choice list - find matching choice and navigate into it
      for (const choice of firstParam.choices) {
        if (choice.type === ParameterType.SUBCOMMAND && choice.name === currentPart) {
          // IMPORTANT: Navigate into the selected choice's members
          currentParameters = choice.members;
          navigated = true;
          break;
        } else if (choice.type === ParameterType.LITERAL && choice.literal === currentPart) {
          // For literal choices, move to next parameter position
          currentParameters = currentParameters.slice(1);
          navigated = true;
          break;
        }
      }
    } else if (firstParam.type === ParameterType.LITERAL && firstParam.literal === currentPart) {
      // Literal parameter
      currentParameters = currentParameters.slice(1);
      navigated = true;
    }

    paramIndex++;
    if (navigated) {
      pathParts.push(currentPart);
    } else {
      // It's an argument value, skip to next position
      currentParameters = currentParameters.slice(1);
    }
  }

  // Build argument help from current position
  const argumentHelp = buildArgumentHelp(currentParameters);
  const commandPath = pathParts.join(' ');

  // Generate suggestions for the current position. A trailing space means the
  // user is starting the next token, so match against an empty prefix (every
  // candidate); otherwise match the partial token they're still typing.
  const typedPrefix = hasTrailingSpace ? '' : (parts[parts.length - 1] || '');
  const suggestions = suggestionsMatchingPrefix(currentParameters, typedPrefix);

  return { suggestions, argumentHelp, commandPath };
}

/**
 * Suggestions for the parameter position represented by `parameters`, limited
 * to the candidates that start with `prefix` (pass `''` to get them all — e.g.
 * after a trailing space, when the user is starting a fresh token). Only the
 * first parameter at this position is suggestable; ARGUMENT positions have no
 * fixed candidates and yield nothing.
 */
function suggestionsMatchingPrefix(parameters: Parameter[], prefix: string): string[] {
  if (parameters.length === 0) { return []; }
  const param = parameters[0];

  // A CHOICE_LIST contributes each of its subcommand/literal choices; a bare
  // SUBCOMMAND/LITERAL contributes itself; an ARGUMENT contributes nothing.
  const candidates =
    param.type === ParameterType.CHOICE_LIST
      ? param.choices.filter(c => c.type === ParameterType.SUBCOMMAND || c.type === ParameterType.LITERAL)
      : (param.type === ParameterType.SUBCOMMAND || param.type === ParameterType.LITERAL)
        ? [param]
        : [];

  return candidates
    .map(parameterLabel)
    .filter(label => label.startsWith(prefix))
    .sort();
}

/**
 * Build argument help string from parameters
 */
function buildArgumentHelp(parameters: Parameter[]): string {
  if (parameters.length === 0) { return ''; }

  return parameters.map(param => {
    switch (param.type) {
      case ParameterType.ARGUMENT:
        return param.optional ? `[<${param.name}>]` : `<${param.name}>`;
      case ParameterType.CHOICE_LIST:
        return `(${param.choices.map(parameterLabel).join('|')})`;
      case ParameterType.LITERAL:
        return param.literal;
      case ParameterType.SUBCOMMAND:
        return param.name; // Show subcommand name
    }
  }).join(' ');
}
