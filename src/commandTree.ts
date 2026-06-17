// src/commandTree.ts
//
// The command tree model: a discriminated union `Parameter`, used both for
// root commands (the entries in `CommandTreeCrawler`'s `rootCommands` map,
// aliased here as `CommandNode`) and for every argument/subcommand/choice
// nested beneath them. The `type` tag selects the variant, and each variant
// carries exactly the fields that apply to it - so consumers `switch` on
// `type` and get the right fields narrowed, with no `param.choices!` /
// `param.name || param.literal` defensiveness.
//
// Everything that builds it lives in commandTreeParsingBrigadier.ts/
// commandTreeParsingBukkit.ts; everything that reads it lives in
// commandTreeSuggestions.ts/displayArgumentHint.ts; `commandTreeCrawler.ts` is the
// stateful orchestration that ties construction and the cache together.

export enum ParameterType {
  ARGUMENT = 'argument',          // <n>
  LITERAL = 'literal',            // literal text
  CHOICE_LIST = 'choice_list',    // (option1|option2)
  SUBCOMMAND = 'subcommand'        // subcommand with its own members
}

/** Fields shared by every parameter: where it sits among its siblings. */
interface ParameterBase {
  optional: boolean;              // whether this position may be omitted
  position: number;               // order in its parent's parameter list
}

/** A named value to be supplied by the user, e.g. `<target>` / `[<target>]`. */
export interface ArgumentParameter extends ParameterBase {
  type: ParameterType.ARGUMENT;
  name: string;
}

/** A fixed word that must be typed verbatim, e.g. `confirm` / `[confirm]`. */
export interface LiteralParameter extends ParameterBase {
  type: ParameterType.LITERAL;
  literal: string;
}

/** A `(a|b|c)` alternation; each choice is itself a parameter. */
export interface ChoiceListParameter extends ParameterBase {
  type: ParameterType.CHOICE_LIST;
  choices: Parameter[];
}

/** A subcommand verb with its own nested parameters, e.g. `team add ...`. */
export interface SubcommandParameter extends ParameterBase {
  type: ParameterType.SUBCOMMAND;
  name: string;
  members: Parameter[];           // this subcommand's own parameters
  isComplete: boolean;            // whether we've fetched all its members
}

export type Parameter =
  | ArgumentParameter
  | LiteralParameter
  | ChoiceListParameter
  | SubcommandParameter;

/**
 * A root command discovered while crawling `/help`/`minecraft:help` - a
 * `SubcommandParameter` whose `members` are its own arguments/subcommands.
 * `optional`/`position` don't carry meaning at the root (there are no
 * siblings to be ordered among or omitted relative to); `newCommandNode`
 * fills them with the inert `false`/`0` so every node is uniformly shaped.
 */
export type CommandNode = SubcommandParameter;

/** A fresh, not-yet-loaded root command node for `name`. */
export function newCommandNode(name: string): CommandNode {
  return { type: ParameterType.SUBCOMMAND, name, optional: false, position: 0, members: [], isComplete: false };
}

/**
 * The bare display label of a parameter: an argument/subcommand name, a
 * literal's text, or a choice list joined with `|`. The single source of
 * truth both display sites (`commandTreeSuggestions`, `displayCommandTree`)
 * use to render a parameter's inner token, so neither has to narrow the
 * union by hand.
 */
export function parameterLabel(p: Parameter): string {
  switch (p.type) {
    case ParameterType.ARGUMENT:    return p.name;
    case ParameterType.LITERAL:     return p.literal;
    case ParameterType.SUBCOMMAND:  return p.name;
    case ParameterType.CHOICE_LIST: return p.choices.map(parameterLabel).join('|');
  }
}
