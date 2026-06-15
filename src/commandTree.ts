// src/commandTree.ts
//
// The command tree model: one recursive `Parameter` type, used both for root
// commands (the entries in `LocalCommandTree`'s `rootCommands` map, aliased
// here as `CommandNode`) and for every argument/subcommand/choice nested
// beneath them. This file is just the shape of that tree.
//
// Everything that builds it lives in helpTextParsing.ts/bukkitHelpParsing.ts;
// everything that reads it lives in commandSuggestions.ts/argumentHint.ts;
// `localCommandTree.ts` is the stateful orchestration that ties construction
// and the cache together.

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
  optional?: boolean;              // For arguments, literals, and subcommands - whether this position may be omitted
  choices?: Parameter[];           // For choice lists
  position?: number;               // Order in its parent's parameter list
  members?: Parameter[];           // For subcommand's parameters
  isComplete?: boolean;            // For subcommands - whether we've fetched all its members
}

/**
 * A root command discovered while crawling `/help`/`minecraft:help` - a
 * SUBCOMMAND-shaped `Parameter` whose `members` are its own
 * arguments/subcommands. `optional`/`position`/`choices`/`literal` don't
 * apply at the root and are always absent.
 */
export type CommandNode = Parameter;

/** A fresh, not-yet-loaded root command node for `name`. */
export function newCommandNode(name: string): CommandNode {
  return { type: ParameterType.SUBCOMMAND, name, members: [], isComplete: false };
}
