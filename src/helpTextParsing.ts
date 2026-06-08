// src/helpTextParsing.ts
//
// Pure parsing of Minecraft `/help` output into a `Parameter` tree, plus the
// color-code helpers used to render it. No state, no IO — every export here
// is a deterministic function of its arguments, which is what makes them
// directly unit-testable without constructing a `CommandAutocomplete`.

// Minecraft color codes to ANSI escape sequences
const COLOR_MAP: { [key: string]: string } = {
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
  '§r': '\x1b[0m',     // Reset
  '§l': '\x1b[1m',     // Bold
  '§o': '\x1b[3m',     // Italic
  '§n': '\x1b[4m',     // Underline
  '§m': '\x1b[9m',     // Strikethrough
  '§k': '\x1b[5m',     // Obfuscated (blinking)
};

// Parameter types - Now includes SUBCOMMAND
export enum ParameterType {
  ARGUMENT = 'argument',          // <n>
  LITERAL = 'literal',            // literal text
  CHOICE_LIST = 'choice_list',    // (option1|option2)
  SUBCOMMAND = 'subcommand'        // NEW: subcommand with its own members
}

export interface Parameter {
  type: ParameterType;
  name?: string;                  // For arguments and subcommands
  literal?: string;                // For literal text
  optional: boolean;
  choices?: Parameter[];           // For choice lists
  position: number;                // Order in parameter list
  members?: Parameter[];           // NEW: For subcommand's parameters
  isComplete?: boolean;            // NEW: For subcommands - whether we've fetched all its members
  rawHelp?: string;                // NEW: For subcommands - the raw help text
}

/**
 * Convert Minecraft color codes to ANSI escape sequences
 */
export function formatMinecraftColors(text: string): string {
  let result = text;
  for (const [code, ansi] of Object.entries(COLOR_MAP)) {
    result = result.replace(new RegExp(code.replace('§', '\\§'), 'g'), ansi);
  }
  if (!result.endsWith('\x1b[0m')) {
    result += '\x1b[0m';
  }
  return result;
}

/**
 * Remove Minecraft color codes for parsing
 */
export function stripColors(text: string): string {
  // Handle both § and Â§ encodings (UTF-8 issues)
  return text.replace(/[§Â]§[0-9a-fklmnor]/g, '')
    .replace(/§[0-9a-fklmnor]/g, '');
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
