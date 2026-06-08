// src/commandAutocomplete.ts
import * as vscode from 'vscode';
import { Logger } from './logger';
import {
  ParameterType,
  Parameter,
  formatMinecraftColors,
  stripColors,
  tokenizeParameterString,
  parseParameter,
  parseCommandHelp,
} from './helpTextParsing';
import { CommandTreeCache } from './commandTreeCache';
import { getSuggestions, SuggestionResult } from './commandSuggestions';

export interface CommandNode {
  name: string;
  parameters: Parameter[];         // Now includes subcommands as parameters
  // NO MORE subcommands Map!
  rawHelp?: string;
  isComplete: boolean;
}

export class CommandAutocomplete {
  private rootCommands: Map<string, CommandNode> = new Map();
  private commandAliases: Map<string, string> = new Map();
  private isLoading: boolean = false;
  private loadingProgress: number = 0;
  private totalCommands: number = 0;
  public isReady: boolean = false;

  private readonly cache: CommandTreeCache;

  constructor(
    private sendCommand: (command: string) => Promise<string>,
    private logger: Logger,
    private context: vscode.ExtensionContext,
    serverHost: string,
    serverPort: number
  ) {
    this.cache = new CommandTreeCache(context, serverHost, serverPort, logger);
  }

  /**
   * Initialize command database
   */
  async initialize(
    onProgress?: (progress: number, message: string) => void,
    forceRefresh: boolean = false
  ): Promise<void> {
    if (this.isLoading) { return; }

    this.isLoading = true;
    this.loadingProgress = 0;

    try {
      // Try to load from cache first
      if (!forceRefresh) {
        const loaded = this.cache.load();
        if (loaded) {
          this.rootCommands = loaded.rootCommands;
          this.commandAliases = loaded.commandAliases;
          onProgress?.(100, 'Commands loaded from cache');
          this.isReady = true;
          return;
        }
      }

      // Fetch commands from server
      onProgress?.(10, 'Fetching root commands...');
      await this.fetchRootCommands();

      // Load details for each command
      const commands = Array.from(this.rootCommands.keys());
      this.logger.info(`Loading details for ${commands.length} commands...`);

      for (let i = 0; i < commands.length; i++) {
        const progress = 10 + (80 * (i / commands.length));
        onProgress?.(progress, `Loading ${commands[i]}...`);

        const node = this.rootCommands.get(commands[i])!;
        try {
          await this.loadCommandDetails(node, node.parameters);
        } catch (error) {
          this.logger.warning(`Warning: Failed to load details for ${commands[i]}: ${error}`);
          // Continue with other commands even if one fails
        }
      }

      // Save to cache
      this.cache.save(this.rootCommands, this.commandAliases);
      onProgress?.(100, 'Commands loaded and cached');
      this.isReady = true;

    } catch (error) {
      this.logger.error(`Error initializing commands: ${error}`);

      // Try to provide basic functionality even if initialization fails
      this.isReady = true; // Mark as ready with whatever we have
      throw error;
    } finally {
      this.isLoading = false;
    }
  }

  async fetchPaginatedCommand(command: string): Promise<string> {
    var output = await this.sendCommand(command);
    const match = output.match(/Help:\s+.*?\((\d+)\/(\d+)\)/i);
    if (!match) {
      return output; // No pagination info, return original output
    } else {
      const pageCount = parseInt(match[2]);
      this.logger.info(`Detected paginated output: ${pageCount} pages total`);

      for (let page = 2; page <= pageCount; page++) {
        const pageOutput = await this.sendCommand(`${command} ${page}`);
        if (output) {
          this.logger.info(`Fetched page ${page}/${pageCount} (${pageOutput.length} bytes)`);
          output += pageOutput;
        }
      }
      return output;
    }
  }

  /**
   * Fetch root commands from server
   */
  private async fetchRootCommands(): Promise<void> {
    try {
      this.logger.info('Fetching root commands with /help...');
      const response = await this.sendCommand('minecraft:help');

      // Debug: Log response info
      this.logger.info(`Help response received: ${response.length} bytes`);

      if (!response || response.length === 0) {
        this.logger.warning('Warning: Empty response from help command');
        // Try alternative help format
        const altResponse = await this.sendCommand('?');
        if (altResponse && altResponse.length > 0) {
          this.logger.info('Using alternative help command (?)');
          this.parseHelpResponse(altResponse);
        } else {
          throw new Error('Unable to fetch command list from server');
        }
      } else {
        this.parseHelpResponse(response);
      }

    } catch (error) {
      this.logger.error(`Error fetching root commands: ${error}`);
      // Provide fallback common commands if help fails
      this.addFallbackCommands();
      throw error;
    }
  }

  /**
   * Parse help response to extract commands
   */
  private parseHelpResponse(response: string): void {
    const modified = response.replace(/\//g, "\n/"); // Replace slashes with newlines to isolate commands
    const lines = modified.split('\n');
    this.logger.info(`Processing ${lines.length} lines from help response`);

    this.logger.info(`everything:\n${modified}`);


    let commandCount = 0;
    for (const line of lines) {
      const stripped = stripColors(line).trim();

      // Skip empty lines and headers
      if (!stripped || stripped.startsWith('---') || stripped.startsWith('===')) {
        continue;
      }

      // Try multiple patterns to match commands
      // Pattern 1: /command (with or without hyphens/underscores)
      // Pattern 2: command: (with or without hyphens/underscores)
      // Pattern 3: - command or * command
      // Pattern 4: just the command name at start of line
      const patterns = [
        /^\/([a-zA-Z0-9_-]+)/,           // /command or /command-with-hyphens
        /^([a-zA-Z0-9_\:-]+):\s/,            // command: or command-with-hyphens:
        /^[-*]\s*([a-zA-Z0-9_-]+)/,      // - command or * command
        /^([a-zA-Z0-9_\:-]+)\s+[-<\[\(]/   // command followed by args
      ];

      let matched = false;
      for (const pattern of patterns) {
        const match = stripped.match(pattern);
        if (match) {
          const commandName = match[1];

          // Skip common non-command words
          if (['usage', 'help', 'example', 'description', 'syntax'].includes(commandName.toLowerCase())) {
            continue;
          }

          // Debug: Log hyphenated commands specifically
          if (commandName.includes('-')) {
            this.logger.info(`  Found hyphenated command: ${commandName}`);
          }

          // Create root command node
          this.rootCommands.set(commandName, {
            name: commandName,
            parameters: [],
            rawHelp: line,
            isComplete: false
          });
          commandCount++;
          matched = true;
          break;
        }
      }
    }

    let altCommandCount = this.rootCommands.size;
    this.logger.info(`Found ${commandCount} root commands (or is it ${altCommandCount}?)`);

    // Debug: List all commands with hyphens
    const hyphenatedCommands = Array.from(this.rootCommands.keys()).filter(cmd => cmd.includes('-'));
    if (hyphenatedCommands.length > 0) {
      this.logger.info(`Hyphenated commands found: ${hyphenatedCommands.join(', ')}`);
    }

    if (commandCount === 0) {
      this.logger.warning('Warning: No commands found in help response');
      this.logger.info('First few lines of response:');
      lines.slice(0, 10).forEach(line => {
        this.logger.info(`  > ${stripColors(line)}`);
      });

      // Add fallback commands
      this.addFallbackCommands();
    }
  }

  /**
   * Add fallback commands if help parsing fails
   */
  private addFallbackCommands(): void {
    this.logger.info('Adding common Minecraft commands as fallback...');

    const commonCommands = [
      'gamemode', 'give', 'tp', 'teleport', 'kill', 'kick', 'ban', 'pardon',
      'op', 'deop', 'whitelist', 'reload', 'save-all', 'save-on', 'save-off',
      'stop', 'list', 'say', 'tell', 'msg', 'w', 'me', 'trigger', 'scoreboard',
      'effect', 'enchant', 'xp', 'experience', 'clear', 'difficulty', 'gamerule',
      'defaultgamemode', 'setworldspawn', 'spawnpoint', 'time', 'weather', 'worldborder',
      'locate', 'particle', 'playsound', 'stopsound', 'title', 'tellraw', 'help',
      'seed', 'clone', 'fill', 'setblock', 'summon', 'testfor', 'testforblock',
      'testforblocks', 'execute', 'blockdata', 'entitydata', 'replaceitem', 'stats',
      'achievement', 'recipe', 'advancement', 'reload', 'function', 'tag', 'team',
      'bossbar', 'data', 'datapack', 'debug', 'forceload', 'locatebiome', 'loot',
      'publish', 'schedule', 'spreadplayers', 'spectate'
    ];

    for (const cmd of commonCommands) {
      if (!this.rootCommands.has(cmd)) {
        this.rootCommands.set(cmd, {
          name: cmd,
          parameters: [],
          rawHelp: `/${cmd}`,
          isComplete: false
        });
      }
    }

    this.logger.info(`Added ${commonCommands.length} fallback commands`);
  }

  /**
   * Load details for a command or subcommand
   */
  private async loadCommandDetails(parent: CommandNode | Parameter, parameters: Parameter[]): Promise<void> {
    // Build the command path
    let commandPath = '';
    if ('name' in parent && parent.name) {
      commandPath = parent.name;
    } else if ('literal' in parent && parent.literal) {
      commandPath = parent.literal;
    }

    try {
      const helpResponse = await this.fetchPaginatedCommand(`help ${commandPath}`);

      // Check if we got a valid response
      if (!helpResponse || helpResponse.length === 0) {
        this.logger.warning(`Empty help response for: ${commandPath}`);
        return;
      }

      this.logger.info(`Loading details for command: ${commandPath}`);
      const lines = helpResponse.split('\n');

      // Track variants of this command (different syntax lines)
      const variants: Map<string, Parameter[]> = new Map();
      let hasDirectParameters = false;

      for (const line of lines) {
        const stripped = stripColors(line).trim();
        if (!stripped || stripped.startsWith('---')) { continue; }

        // Match command pattern - allow hyphens and underscores in names
        // Also handle potential spaces or different formats
        const cmdPatterns = [
          /^\/([a-zA-Z0-9_\:-]+)(?:\s+(.+))?$/,  // Standard format: /command args
          /^([a-zA-Z0-9_-]+)(?:\s+(.+))?$/,     // Without slash: command args
          /^\/([a-zA-Z0-9_\:-]+):?\s*(.*)$/       // With optional colon: /command: args
        ];

        let match = null;
        for (const pattern of cmdPatterns) {
          match = stripped.match(pattern);
          if (match) { break; }
        }

        if (match) {
          const matchedCommand = match[1];

          // Normalize command names for comparison (case-insensitive, trim)
          const normalizedMatch = matchedCommand.toLowerCase().trim();
          const normalizedPath = commandPath.toLowerCase().trim();

          // Debug output
          this.logger.info(`  Checking: "${matchedCommand}" vs "${commandPath}"`);

          if (normalizedMatch === normalizedPath) {
            const afterCommand = match[2] || '';
            this.logger.info(`  Found match! Parameters: "${afterCommand}"`);

            if (afterCommand) {
              // Tokenize everything after the command
              const tokens = tokenizeParameterString(afterCommand);
              this.logger.info(`  Tokens: ${JSON.stringify(tokens)}`);

              if (tokens.length > 0) {
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

                if (!isArgument) {
                  // First token is a literal/subcommand - this is a subcommand variant
                  let subcommandName = firstToken;

                  // Strip optional brackets if present
                  if (subcommandName.startsWith('[') && subcommandName.endsWith(']')) {
                    subcommandName = subcommandName.slice(1, -1); // Remove [ and ]
                  }

                  // Create parameter list for this variant
                  const variantParams: Parameter[] = [];

                  // Parse remaining tokens as the subcommand's parameters
                  for (let i = 1; i < tokens.length; i++) {
                    const param = parseParameter(tokens[i], i - 1);
                    if (param) {
                      variantParams.push(param);
                    }
                  }

                  // Store this variant
                  variants.set(subcommandName, variantParams);

                } else {
                  // First token is an argument - these are direct parameters
                  // IMPORTANT: Parse ALL tokens as parameters for this command
                  hasDirectParameters = true;

                  // Clear and rebuild parameters to ensure we get ALL of them
                  parameters.length = 0; // Clear existing

                  for (let i = 0; i < tokens.length; i++) {
                    const param = parseParameter(tokens[i], i);
                    if (param) {
                      parameters.push(param);
                      this.logger.info(`    Added parameter: ${JSON.stringify(param)}`);
                    }
                  }
                }
              }
            } else {
              // Command with no parameters
              this.logger.info(`  Command has no parameters`);
            }
          }
        }
      }

      // Build final parameter structure only if we haven't already set direct parameters
      if (!hasDirectParameters) {
        parameters.length = 0; // Clear existing parameters

        // If we have variants (subcommands), create proper structure
        if (variants.size > 0) {
          const subcommandChoices: Parameter[] = [];

          for (const [subcommandName, subParams] of variants) {
            // Create a SUBCOMMAND parameter for each variant
            const subcommandParam: Parameter = {
              type: ParameterType.SUBCOMMAND,
              name: subcommandName,
              literal: subcommandName,
              optional: false,
              position: subcommandChoices.length,
              members: subParams,
              isComplete: false
            };
            subcommandChoices.push(subcommandParam);
          }

          // If there's only one variant, add it directly
          // Otherwise, create a choice list
          if (subcommandChoices.length === 1) {
            parameters.push(subcommandChoices[0]);
          } else {
            // Create a CHOICE_LIST parameter containing all subcommands
            const choiceParam: Parameter = {
              type: ParameterType.CHOICE_LIST,
              optional: false,
              position: 0,
              choices: subcommandChoices
            };
            parameters.push(choiceParam);
          }
        }
      }

      // Debug: Log final parameters
      this.logger.info(`  Final parameters for ${commandPath}: ${JSON.stringify(parameters.map(p => ({
        type: p.type,
        name: p.name,
        literal: p.literal,
        optional: p.optional
      })))}`);

      // Mark as complete
      if ('isComplete' in parent) {
        parent.isComplete = true;
      }

      // Recursively load details for all subcommands
      for (const param of parameters) {
        if (param.type === ParameterType.CHOICE_LIST && param.choices) {
          // For choice lists, recurse into each subcommand choice
          for (const choice of param.choices) {
            if (choice.type === ParameterType.SUBCOMMAND && !choice.isComplete) {
              await this.loadSubcommandDetails(commandPath, choice);
            }
          }
        } else if (param.type === ParameterType.SUBCOMMAND && !param.isComplete) {
          // Direct subcommand parameter
          await this.loadSubcommandDetails(commandPath, param);
        }
      }

    } catch (error) {
      this.logger.error(`Error loading details for ${commandPath}: ${error}`);
      // Mark as complete even on error to avoid infinite loops
      if ('isComplete' in parent) {
        parent.isComplete = true;
      }
    }
  }

  /**
   * Load details for a subcommand by fetching its help
   */
  private async loadSubcommandDetails(parentPath: string, subcommand: Parameter): Promise<void> {
    if (subcommand.type !== ParameterType.SUBCOMMAND || !subcommand.name) { return; }

    // Build the full command path for this subcommand
    const fullPath = `${parentPath} ${subcommand.name}`;

    try {
      // Get help for this specific subcommand path
      const helpResponse = await this.sendCommand(`help ${fullPath}`);

      // Check for valid response
      if (!helpResponse || helpResponse.length === 0) {
        subcommand.isComplete = true;
        return;
      }

      const lines = helpResponse.split('\n');

      // Clear existing members to avoid duplicates
      if (!subcommand.members) {
        subcommand.members = [];
      }

      // Track variants of this subcommand (different syntax lines)
      const variants: Map<string, Parameter[]> = new Map();
      let hasDirectParameters = false;

      // Parse ALL lines to collect ALL variants (not just the first one!)
      for (const line of lines) {
        const stripped = stripColors(line).trim();
        if (!stripped || stripped.startsWith('---')) { continue; }

        // Look for lines that match this specific subcommand path
        const pattern = new RegExp(`^/${fullPath.replace(' ', '\\s+')}\\s+(.+)$`);
        const match = stripped.match(pattern);

        if (match) {
          const afterSubcommand = match[1];
          const tokens = tokenizeParameterString(afterSubcommand);

          if (tokens.length > 0) {
            const firstToken = tokens[0];

            // Determine if first token is a literal/subcommand or an argument
            // FIXED: Better detection for optional subcommands vs optional arguments
            let isArgument = false;
            if (firstToken.startsWith('<')) {
              isArgument = true;
            } else if (firstToken.startsWith('[') && firstToken.endsWith(']')) {
              const inner = firstToken.slice(1, -1);
              if (inner.startsWith('<') && inner.endsWith('>')) {
                isArgument = true;
              } else {
                isArgument = false;
              }
            } else if (firstToken.startsWith('(') && firstToken.endsWith(')')) {
              isArgument = true;
            }

            if (!isArgument) {
              // First token is a literal - this is a nested subcommand variant
              let nestedSubcommandName = firstToken;

              // Strip optional brackets if present
              if (nestedSubcommandName.startsWith('[') && nestedSubcommandName.endsWith(']')) {
                nestedSubcommandName = nestedSubcommandName.slice(1, -1);
              }

              // Create parameter list for this variant
              const variantParams: Parameter[] = [];

              // Parse remaining tokens as the nested subcommand's parameters
              for (let i = 1; i < tokens.length; i++) {
                const param = parseParameter(tokens[i], i - 1);
                if (param) {
                  variantParams.push(param);
                }
              }

              // Store this variant - CONTINUE to find more variants!
              variants.set(nestedSubcommandName, variantParams);

            } else {
              // First token is an argument - these are direct parameters
              hasDirectParameters = true;

              // Clear and rebuild members for direct parameters
              subcommand.members.length = 0;

              // Parse ALL tokens as parameters for this subcommand
              for (let i = 0; i < tokens.length; i++) {
                const param = parseParameter(tokens[i], i);
                if (param) {
                  subcommand.members.push(param);
                }
              }

              // For direct parameters, we can break after finding them
              break;
            }
          }
        }
      }

      // Build final parameter structure
      if (!hasDirectParameters) {
        subcommand.members.length = 0; // Clear existing members

        // If we have variants (nested subcommands), create proper structure
        if (variants.size > 0) {
          const nestedSubcommandChoices: Parameter[] = [];

          for (const [nestedName, nestedParams] of variants) {
            // Create a SUBCOMMAND parameter for each variant
            const nestedSubcommand: Parameter = {
              type: ParameterType.SUBCOMMAND,
              name: nestedName,
              literal: nestedName,
              optional: false,
              position: nestedSubcommandChoices.length,
              members: nestedParams,
              isComplete: false
            };
            nestedSubcommandChoices.push(nestedSubcommand);
          }

          // If there's only one variant, add it directly
          // Otherwise, create a choice list
          if (nestedSubcommandChoices.length === 1) {
            subcommand.members.push(nestedSubcommandChoices[0]);
          } else {
            // Create a CHOICE_LIST parameter containing all nested subcommands
            const choiceParam: Parameter = {
              type: ParameterType.CHOICE_LIST,
              optional: false,
              position: 0,
              choices: nestedSubcommandChoices
            };
            subcommand.members.push(choiceParam);
          }
        }
      }

      subcommand.isComplete = true;

      // Recursively load any nested subcommands
      if (subcommand.members) {
        for (const member of subcommand.members) {
          if (member.type === ParameterType.CHOICE_LIST && member.choices) {
            // For choice lists, recurse into each subcommand choice
            for (const choice of member.choices) {
              if (choice.type === ParameterType.SUBCOMMAND && !choice.isComplete) {
                await this.loadSubcommandDetails(fullPath, choice);
              }
            }
          } else if (member.type === ParameterType.SUBCOMMAND && !member.isComplete) {
            // Direct subcommand parameter
            await this.loadSubcommandDetails(fullPath, member);
          }
        }
      }

    } catch (error) {
      // Subcommand might not have its own help, that's okay
      subcommand.isComplete = true;
    }
  }

  /**
   * Get suggestions based on current input
   */
  getSuggestions(input: string): SuggestionResult {
    return getSuggestions(this.rootCommands, this.isReady, input);
  }

  /**
   * Get cache information
   */
  getCacheInfo(): { exists: boolean; age: string; lastUpdated?: Date } {
    return this.cache.getInfo();
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}