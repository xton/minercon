// src/commandSuggestions.ts
//
// Pure suggestion generation: given the command tree `LocalCommandTree`
// builds and the user's current input line, work out what to suggest next
// and what argument-help text to show. No state, no IO — a deterministic
// function of the tree and the input.

import { ParameterType, Parameter } from './helpTextParsing';
import { CommandNode } from './localCommandTree';

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

  const hasTrailingSpace = input.endsWith(' ');
  const parts = trimmed.slice(1).split(' ').filter(p => p.length > 0);
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
  let currentParameters = rootNode.parameters;
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
      if (firstParam.name === currentPart || firstParam.literal === currentPart) {
        currentParameters = firstParam.members || [];
        navigated = true;
      }
    } else if (firstParam.type === ParameterType.CHOICE_LIST && firstParam.choices) {
      // Choice list - find matching choice and navigate into it
      for (const choice of firstParam.choices) {
        if (choice.type === ParameterType.SUBCOMMAND &&
          (choice.name === currentPart || choice.literal === currentPart)) {
          // IMPORTANT: Navigate into the selected choice's members
          currentParameters = choice.members || [];
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

  // Generate suggestions based on current position
  let suggestions: string[] = [];

  if (hasTrailingSpace) {
    // We want suggestions for the NEXT parameter
    suggestions = generateSuggestionsForNextPosition(currentParameters);
  } else {
    // We're typing something, get matching suggestions
    const currentPart = parts[parts.length - 1] || '';
    suggestions = generateSuggestionsForCurrentPart(currentParameters, currentPart);
  }

  return { suggestions, argumentHelp, commandPath };
}

/**
 * Generate suggestions for what we're currently typing
 * Must handle CHOICE_LIST parameters properly
 */
function generateSuggestionsForCurrentPart(
  parameters: Parameter[],
  currentPart: string
): string[] {
  const suggestions: string[] = [];

  for (const param of parameters) {
    if (param.type === ParameterType.SUBCOMMAND) {
      // Direct subcommand
      const name = param.name || param.literal || '';
      if (name.startsWith(currentPart)) {
        suggestions.push(name);
      }
    } else if (param.type === ParameterType.CHOICE_LIST && param.choices) {
      // Choice list - add all matching choices
      for (const choice of param.choices) {
        if (choice.type === ParameterType.SUBCOMMAND) {
          const name = choice.name || choice.literal || '';
          if (name.startsWith(currentPart)) {
            suggestions.push(name);
          }
        } else if (choice.type === ParameterType.LITERAL) {
          const literal = choice.literal || '';
          if (literal.startsWith(currentPart)) {
            suggestions.push(literal);
          }
        }
      }
    } else if (param.type === ParameterType.LITERAL) {
      const literal = param.literal || '';
      if (literal.startsWith(currentPart)) {
        suggestions.push(literal);
      }
    }
    // We only process the first parameter position
    break;
  }

  return suggestions.sort();
}

/**
 * Generate suggestions for the next parameter position
 * Must handle CHOICE_LIST parameters properly
 */
function generateSuggestionsForNextPosition(
  parameters: Parameter[]
): string[] {
  const suggestions: string[] = [];

  if (parameters.length === 0) { return suggestions; }

  const firstParam = parameters[0];

  if (firstParam.type === ParameterType.SUBCOMMAND) {
    // Direct subcommand
    suggestions.push(firstParam.name || firstParam.literal || '');
  } else if (firstParam.type === ParameterType.CHOICE_LIST && firstParam.choices) {
    // Choice list - add all choices as suggestions
    for (const choice of firstParam.choices) {
      if (choice.type === ParameterType.SUBCOMMAND) {
        suggestions.push(choice.name || choice.literal || '');
      } else if (choice.type === ParameterType.LITERAL) {
        suggestions.push(choice.literal || '');
      }
    }
  } else if (firstParam.type === ParameterType.LITERAL) {
    suggestions.push(firstParam.literal || '');
  }
  // Don't suggest anything for ARGUMENT types

  return suggestions.sort();
}

/**
 * Build argument help string from parameters
 */
function buildArgumentHelp(parameters: Parameter[]): string {
  if (parameters.length === 0) { return ''; }

  return parameters.map(param => {
    if (param.type === ParameterType.ARGUMENT) {
      return param.optional ? `[<${param.name}>]` : `<${param.name}>`;
    } else if (param.type === ParameterType.CHOICE_LIST && param.choices) {
      const choices = param.choices.map(c => c.literal).join('|');
      return `(${choices})`;
    } else if (param.type === ParameterType.LITERAL) {
      return param.literal;
    } else if (param.type === ParameterType.SUBCOMMAND) {
      return param.name; // Show subcommand name
    }
    return '';
  }).join(' ');
}
