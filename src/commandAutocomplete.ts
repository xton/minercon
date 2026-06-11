// src/commandAutocomplete.ts
import * as path from 'path';
import { Logger } from './logger';
import { stripColors } from './ansi';
import {
  ParameterType,
  Parameter,
  HelpLinesResult,
  parseHelpLines,
  parseAliasRedirect,
  splitConcatenatedHelpLines,
  looksLikeBukkitHelpPage,
  isGenericArgsPlaceholder,
  isUnsupportedNamespaceError,
  extractBukkitUsageLines,
  extractBukkitAliases,
  buildParameterStructureFromVariants,
} from './helpTextParsing';
import { CommandTreeCache } from './commandTreeCache';
import { getSuggestions, SuggestionResult } from './commandSuggestions';

export interface CommandNode {
  name: string;
  parameters: Parameter[];         // includes subcommands as parameters
  isComplete: boolean;
}

export class CommandAutocomplete {
  private rootCommands: Map<string, CommandNode> = new Map();
  private isLoading: boolean = false;
  private loadingProgress: number = 0;
  private totalCommands: number = 0;
  public isReady: boolean = false;

  // Whether the `minecraft:` command namespace prefix is registered on this
  // server. Paper/Spigot (Bukkit-based) accept `minecraft:help ...` and use
  // it to get Brigadier-accurate `<args>` syntax for vanilla commands; pure
  // Vanilla/Fabric reject it as an unknown namespace (Brigadier syntax
  // error), but their plain `/help [<cmd>]` already returns full `<args>`
  // syntax directly. Detected once in fetchRootCommands() and reused for
  // every per-command detail fetch. See docs/technical/NO_PLUGIN_HELP_CRAWL.md.
  private supportsMinecraftNamespace: boolean = true;

  private readonly cache: CommandTreeCache;

  constructor(
    private sendCommand: (command: string) => Promise<string>,
    private logger: Logger,
    cacheDir: string,
    serverHost: string,
    serverPort: number
  ) {
    this.cache = new CommandTreeCache(path.join(cacheDir, 'command-cache'), serverHost, serverPort, logger);
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
          this.rootCommands = loaded;
          onProgress?.(100, 'Commands loaded from cache');
          this.isReady = true;
          return;
        }
      }

      // Aliases discovered while crawling (`<alias> -> <target>` redirect
      // lines, Bukkit `Aliases:` lines) - resolved into rootCommands once
      // their targets have been fully loaded, below.
      const pendingAliases = new Map<string, string>();

      // Fetch commands from server
      onProgress?.(10, 'Fetching root commands...');
      await this.fetchRootCommands(pendingAliases);

      // Load details for each command
      const commands = Array.from(this.rootCommands.keys());
      this.logger.info(`Loading details for ${commands.length} commands...`);

      for (let i = 0; i < commands.length; i++) {
        const progress = 10 + (80 * (i / commands.length));
        onProgress?.(progress, `Loading ${commands[i]}...`);

        const node = this.rootCommands.get(commands[i])!;
        try {
          await this.loadCommandDetails(node, node.parameters, pendingAliases);
        } catch (error) {
          this.logger.warning(`Warning: Failed to load details for ${commands[i]}: ${error}`);
          // Continue with other commands even if one fails
        }
      }

      // Expand aliases into rootCommands now that their targets are fully
      // loaded, sharing the target's node so alias entries stay in sync.
      for (const [alias, target] of pendingAliases) {
        const targetNode = this.rootCommands.get(target);
        if (targetNode && !this.rootCommands.has(alias)) {
          this.rootCommands.set(alias, targetNode);
        }
      }

      // Save to cache
      this.cache.save(this.rootCommands);
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
  private async fetchRootCommands(pendingAliases: Map<string, string>): Promise<void> {
    try {
      this.logger.info('Fetching root commands with /help...');
      const mcResponse = await this.sendCommand('minecraft:help');

      if (isUnsupportedNamespaceError(mcResponse)) {
        // Vanilla/Fabric: the `minecraft:` namespace prefix isn't
        // registered. Plain `/help` (paginated) already gives a complete,
        // accurate, one-shot command list with full <args> syntax.
        this.logger.info('minecraft: namespace not supported; using /help for root commands');
        this.supportsMinecraftNamespace = false;

        const response = await this.fetchPaginatedCommand('help');
        this.logger.info(`Help response received: ${response.length} bytes`);
        if (!response || response.length === 0) {
          throw new Error('Unable to fetch command list from server');
        }
        this.parseHelpResponse(response, pendingAliases);
        return;
      }

      this.supportsMinecraftNamespace = true;
      this.logger.info(`Help response received: ${mcResponse.length} bytes`);

      if (!mcResponse || mcResponse.length === 0) {
        this.logger.warning('Warning: Empty response from help command');
        // Try alternative help format
        const altResponse = await this.sendCommand('?');
        if (altResponse && altResponse.length > 0) {
          this.logger.info('Using alternative help command (?)');
          this.parseHelpResponse(altResponse, pendingAliases);
        } else {
          throw new Error('Unable to fetch command list from server');
        }
      } else {
        this.parseHelpResponse(mcResponse, pendingAliases);
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
  private parseHelpResponse(response: string, pendingAliases: Map<string, string>): void {
    const modified = splitConcatenatedHelpLines(response);
    const lines = modified.split('\n');
    this.logger.info(`Processing ${lines.length} lines from help response`);

    let commandCount = 0;
    for (const line of lines) {
      const stripped = stripColors(line).trim();

      // Skip empty lines and headers
      if (!stripped || stripped.startsWith('---') || stripped.startsWith('===')) {
        continue;
      }

      // Alias redirect lines (`/tp -> teleport`) describe an alias, not a
      // root command in their own right - record the mapping and move on
      // rather than creating a wasteful incomplete rootCommands entry.
      const redirect = parseAliasRedirect(stripped);
      if (redirect) {
        pendingAliases.set(redirect.alias, redirect.target);
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

          // Skip common non-command words that appear in descriptions
          if (['usage', 'example', 'description', 'syntax'].includes(commandName.toLowerCase())) {
            continue;
          }

          // Create root command node
          this.rootCommands.set(commandName, {
            name: commandName,
            parameters: [],
            isComplete: false
          });
          commandCount++;
          matched = true;
          break;
        }
      }
    }

    this.logger.info(`Found ${this.rootCommands.size} root commands`);

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
          isComplete: false
        });
      }
    }

    this.logger.info(`Added ${commonCommands.length} fallback commands`);
  }

  /**
   * Merge the two help sources for `commandPath`'s syntax into one
   * `HelpLinesResult`. `mcResponse` (from `minecraft:help <commandPath>`,
   * only present when `supportsMinecraftNamespace`) wins unless it's empty
   * or the generic `[<args>]` placeholder Bukkit emits for non-Brigadier
   * commands, in which case `helpResponse` (from `help <commandPath>`) is
   * used instead — via `extractBukkitUsageLines` if it's a Bukkit help page,
   * or re-split as a concatenated Brigadier blob otherwise (see
   * `looksLikeBukkitHelpPage`). See docs/technical/NO_PLUGIN_HELP_CRAWL.md.
   */
  private mergeHelpSources(helpResponse: string, mcResponse: string | null, commandPath: string): HelpLinesResult {
    // mcResponse is always a flat Brigadier blob - never a Bukkit help page.
    const mc = mcResponse !== null
      ? parseHelpLines(splitConcatenatedHelpLines(mcResponse), commandPath)
      : { variants: new Map<string, Parameter[]>(), direct: null };

    let result: HelpLinesResult;
    if (mc.direct !== null && !isGenericArgsPlaceholder(mc.direct)) {
      result = { variants: new Map(), direct: mc.direct };
    } else if (mc.variants.size > 0) {
      result = { variants: mc.variants, direct: null };
    } else if (looksLikeBukkitHelpPage(helpResponse)) {
      result = parseHelpLines(extractBukkitUsageLines(helpResponse, commandPath).join('\n'), commandPath);
    } else {
      // Like `mcResponse`, vanilla's `help <path>` responses for commands
      // with multiple variants (team, gamerule, debug, ...) pack each
      // `/path ...` onto one line with no separators - re-split the same way.
      result = parseHelpLines(splitConcatenatedHelpLines(helpResponse), commandPath);
    }

    // The generic `[<args>]` placeholder (from either source) means "no
    // further arguments", not a real <args> token.
    if (result.direct !== null && isGenericArgsPlaceholder(result.direct)) {
      result = { variants: result.variants, direct: [] };
    }
    return result;
  }

  /**
   * Load details for a command or subcommand
   */
  private async loadCommandDetails(parent: CommandNode | Parameter, parameters: Parameter[], pendingAliases: Map<string, string>): Promise<void> {
    // Build the command path
    let commandPath = '';
    if ('name' in parent && parent.name) {
      commandPath = parent.name;
    } else if ('literal' in parent && parent.literal) {
      commandPath = parent.literal;
    }

    try {
      const helpResponse = await this.fetchPaginatedCommand(`help ${commandPath}`);
      const mcResponse = this.supportsMinecraftNamespace
        ? await this.fetchPaginatedCommand(`minecraft:help ${commandPath}`)
        : null;

      // Check if we got a valid response from at least one source
      if (!helpResponse && !mcResponse) {
        this.logger.warning(`Empty help response for: ${commandPath}`);
        return;
      }

      this.logger.info(`Loading details for command: ${commandPath}`);

      // Bukkit `/help <command>` pages list aliases on their own
      // `Aliases: a, b, c` line - returns [] for Brigadier blobs, which
      // have no such line.
      for (const alias of extractBukkitAliases(helpResponse)) {
        pendingAliases.set(alias, commandPath);
      }

      const { variants, direct } = this.mergeHelpSources(helpResponse, mcResponse, commandPath);
      parameters.length = 0;
      if (direct !== null) {
        parameters.push(...direct);
      } else {
        parameters.push(...buildParameterStructureFromVariants(variants));
      }

      this.logger.info(`Loaded ${parameters.length} parameter(s) for ${commandPath}`);

      // Mark as complete
      if ('isComplete' in parent) {
        parent.isComplete = true;
      }

      // Recursively load details for all subcommands
      await this.loadSubcommandsIn(commandPath, parameters);

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
      const helpResponse = await this.fetchPaginatedCommand(`help ${fullPath}`);
      const mcResponse = this.supportsMinecraftNamespace
        ? await this.fetchPaginatedCommand(`minecraft:help ${fullPath}`)
        : null;

      // Check for a valid response from at least one source
      if (!helpResponse && !mcResponse) {
        subcommand.isComplete = true;
        return;
      }

      const { variants, direct } = this.mergeHelpSources(helpResponse, mcResponse, fullPath);

      if (variants.size === 0 && direct === null) {
        // Neither source described `fullPath` directly (e.g. it's an enum
        // value like a gamerule name, not a queryable command path) - keep
        // whatever members were already known from the parent's syntax line.
        subcommand.isComplete = true;
        return;
      }

      // Clear existing members to avoid duplicates
      if (!subcommand.members) {
        subcommand.members = [];
      }
      subcommand.members.length = 0;
      if (direct !== null) {
        subcommand.members.push(...direct);
      } else {
        subcommand.members.push(...buildParameterStructureFromVariants(variants));
      }

      subcommand.isComplete = true;

      // Recursively load any nested subcommands
      if (subcommand.members) {
        await this.loadSubcommandsIn(fullPath, subcommand.members);
      }

    } catch (error) {
      // Subcommand might not have its own help, that's okay
      subcommand.isComplete = true;
    }
  }

  /**
   * Recursively loads details for any not-yet-complete SUBCOMMAND parameters
   * in `parameters` — both direct ones and those nested inside CHOICE_LIST
   * choices — fetching each via `loadSubcommandDetails(path, ...)`.
   */
  private async loadSubcommandsIn(path: string, parameters: Parameter[]): Promise<void> {
    for (const param of parameters) {
      if (param.type === ParameterType.CHOICE_LIST && param.choices) {
        // For choice lists, recurse into each subcommand choice
        for (const choice of param.choices) {
          if (choice.type === ParameterType.SUBCOMMAND && !choice.isComplete) {
            await this.loadSubcommandDetails(path, choice);
          }
        }
      } else if (param.type === ParameterType.SUBCOMMAND && !param.isComplete) {
        // Direct subcommand parameter
        await this.loadSubcommandDetails(path, param);
      }
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