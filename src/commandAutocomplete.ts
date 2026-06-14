// src/commandAutocomplete.ts
import * as path from 'path';
import { Logger } from './logger';
import { stripColors } from './ansi';
import {
  ParameterType,
  Parameter,
  HelpLinesResult,
  VariantInfo,
  parseHelpLines,
  parseHelpResponse,
  hasRealUsage,
  splitConcatenatedHelpLines,
  looksLikeBukkitHelpPage,
  isGenericArgsPlaceholder,
  isUnsupportedNamespaceError,
  extractBukkitUsageLines,
  extractBukkitAliases,
  buildParameterStructureFromVariants,
  hasUsableArguments,
} from './helpTextParsing';
import { CommandTreeCache } from './commandTreeCache';
import { getSuggestions, SuggestionResult } from './commandSuggestions';

export interface CommandNode {
  name: string;
  parameters: Parameter[];         // includes subcommands as parameters
  isComplete: boolean;
}

/** Coarse-grained stage of `initialize()`'s progress, for UI phase labels. */
export type ProgressPhase = 'cache-hit' | 'fetching' | 'loading' | 'complete';

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

  // For each root command, whether its summary line in the root
  // `minecraft:help` dump carried no real Brigadier info (empty or the
  // generic `[<args>]` placeholder). When true, `loadCommandDetails` tries
  // Bukkit's `help <command>` first, since `minecraft:help <command>` is
  // unlikely to do better; when false (or absent), it tries
  // `minecraft:help <command>` first. Either way, the other source is only
  // fetched if the first one turns out insufficient. Populated once during
  // fetchRootCommands(), not persisted to the cache.
  private rootSummaryIsPlaceholder: Map<string, boolean> = new Map();

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
    onProgress?: (progress: number, phase: ProgressPhase) => void,
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
          onProgress?.(100, 'cache-hit');
          this.isReady = true;
          return;
        }
      }

      // Aliases discovered while crawling (`<alias> -> <target>` redirect
      // lines, Bukkit `Aliases:` lines) - resolved into rootCommands once
      // their targets have been fully loaded, below.
      const pendingAliases = new Map<string, string>();

      // Fetch commands from server
      onProgress?.(10, 'fetching');
      await this.fetchRootCommands(pendingAliases);

      // Load details for each command. Namespaced commands (`minecraft:foo`,
      // `bukkit:foo`, ...) are loaded first, so that their bare counterparts
      // (`foo`) can reuse the already-fetched details instead of issuing a
      // second, near-identical pair of `help`/`minecraft:help` round trips
      // (see loadCommandDetails).
      const commands = Array.from(this.rootCommands.keys())
        .sort((a, b) => Number(b.includes(':')) - Number(a.includes(':')));
      this.logger.info(`Loading details for ${commands.length} commands...`);

      for (let i = 0; i < commands.length; i++) {
        const progress = 10 + (80 * (i / commands.length));
        onProgress?.(progress, 'loading');

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
      onProgress?.(100, 'complete');
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
    let output = await this.sendCommand(command);
    const match = output.match(/Help:\s+.*?\((\d+)\/(\d+)\)/i);
    if (!match) {
      return output; // No pagination info, return original output
    } else {
      const pageCount = parseInt(match[2]);
      this.logger.info(`Detected paginated output: ${pageCount} pages total`);

      for (let page = 2; page <= pageCount; page++) {
        const pageOutput = await this.sendCommand(`${command} ${page}`);
        if (pageOutput) {
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
        this.ingestHelpResponse(response, pendingAliases);
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
          this.ingestHelpResponse(altResponse, pendingAliases);
        } else {
          throw new Error('Unable to fetch command list from server');
        }
      } else {
        this.ingestHelpResponse(mcResponse, pendingAliases);
      }

    } catch (error) {
      this.logger.error(`Error fetching root commands: ${error}`);
      // Provide fallback common commands if help fails
      this.addFallbackCommands();
      throw error;
    }
  }

  /**
   * Parse a help response and merge the commands/aliases it describes into
   * `rootCommands`, `rootSummaryIsPlaceholder`, and `pendingAliases`.
   */
  private ingestHelpResponse(response: string, pendingAliases: Map<string, string>): void {
    const { commands, aliases } = parseHelpResponse(response);

    for (const { alias, target } of aliases) {
      pendingAliases.set(alias, target);
    }

    for (const { name, isPlaceholder } of commands) {
      this.rootCommands.set(name, { name, parameters: [], isComplete: false });
      this.rootSummaryIsPlaceholder.set(name, isPlaceholder);
    }

    this.logger.info(`Found ${this.rootCommands.size} root commands`);

    if (commands.length === 0) {
      this.logger.warning('Warning: No commands found in help response');
      this.logger.info('First few lines of response:');
      splitConcatenatedHelpLines(response).split('\n').slice(0, 10).forEach(line => {
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
      'seed', 'clone', 'fill', 'setblock', 'summon', 'execute',
      'recipe', 'advancement', 'function', 'tag', 'team',
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
   * Find an already-loaded root command that's a namespaced form of the bare
   * `commandPath` (e.g. "minecraft:version" or "bukkit:version" for
   * "version"), if any. Returns the first match in `rootCommands`'
   * iteration order, or `undefined` if `commandPath` itself is namespaced or
   * no such sibling exists yet.
   */
  private findNamespacedSibling(commandPath: string): CommandNode | undefined {
    if (commandPath.includes(':')) { return undefined; }

    for (const [name, node] of this.rootCommands) {
      if (node.isComplete && name.endsWith(`:${commandPath}`)) {
        return node;
      }
    }
    return undefined;
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
      : { variants: new Map<string, VariantInfo>(), direct: null };

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

    // A bare command (e.g. "version") and its namespaced counterparts (e.g.
    // "bukkit:version", "minecraft:version") describe the same underlying
    // command and have identical `help`/`minecraft:help` output - fetching
    // both is wasteful. Namespaced commands are loaded first (see
    // initialize()), so if one is already complete, reuse its parameters
    // instead of repeating the round trips.
    const sibling = this.findNamespacedSibling(commandPath);
    if (sibling) {
      parameters.length = 0;
      parameters.push(...sibling.parameters);
      if ('isComplete' in parent) {
        parent.isComplete = true;
      }
      this.logger.info(`Reusing ${sibling.name}'s details for ${commandPath}`);
      return;
    }

    try {
      let helpResponse = '';
      let mcResponse: string | null = null;

      if (!this.supportsMinecraftNamespace) {
        helpResponse = await this.fetchPaginatedCommand(`help ${commandPath}`);
      } else if (this.rootSummaryIsPlaceholder.get(commandPath)) {
        // The root `minecraft:help` summary for this command had no real
        // syntax (empty or `[<args>]`) - `minecraft:help <commandPath>` is
        // unlikely to do better, so try Bukkit's `help <commandPath>` first
        // and only fall back to `minecraft:help` if it doesn't pan out.
        helpResponse = await this.fetchPaginatedCommand(`help ${commandPath}`);
        const fromHelp = looksLikeBukkitHelpPage(helpResponse)
          ? parseHelpLines(extractBukkitUsageLines(helpResponse, commandPath).join('\n'), commandPath)
          : parseHelpLines(splitConcatenatedHelpLines(helpResponse), commandPath);
        if (!hasRealUsage(fromHelp)) {
          mcResponse = await this.fetchPaginatedCommand(`minecraft:help ${commandPath}`);
        }
      } else {
        // The root summary already had real syntax info - `minecraft:help
        // <commandPath>` is at least as detailed, so try it first and only
        // fall back to Bukkit's `help <commandPath>` if it doesn't pan out.
        mcResponse = await this.fetchPaginatedCommand(`minecraft:help ${commandPath}`);
        const fromMc = parseHelpLines(splitConcatenatedHelpLines(mcResponse), commandPath);
        if (!hasRealUsage(fromMc)) {
          helpResponse = await this.fetchPaginatedCommand(`help ${commandPath}`);
        }
      }

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

    // The variant line that introduced this subcommand (e.g. "/gamerule
    // doDaylightCycle [<value>]") already gave us its argument list - trust
    // it instead of spending a `help`/`minecraft:help` round trip per
    // subcommand (e.g. once per gamerule, scoreboard objectives subcommand,
    // ...). Only fall through to fetching when that usage is empty or just
    // the generic `<args>` placeholder, i.e. we don't actually know its args.
    if (subcommand.members && hasUsableArguments(subcommand.members)) {
      subcommand.isComplete = true;
      await this.loadSubcommandsIn(fullPath, subcommand.members);
      return;
    }

    // A variant whose name came from a `[bracketed]` token with no further
    // arguments (e.g. "[peaceful]" in "/minecraft:difficulty [peaceful]")
    // is one literal value of an enum-style argument, not a subcommand verb
    // - "peaceful" has no syntax of its own to discover, so
    // "help"/"minecraft:help <fullPath>" would just be wasted round trips
    // (confirmed: minecraft:help returns empty, help returns "not found").
    if (subcommand.members && subcommand.members.length === 0 && subcommand.optional) {
      subcommand.isComplete = true;
      return;
    }

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

    } catch {
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