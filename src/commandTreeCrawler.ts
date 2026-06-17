// src/commandTreeCrawler.ts
//
// The command tree for "local" (no-plugin) mode: built by crawling a
// server's `/help` and `minecraft:help` output, cached to disk between runs
// via `CommandTreeCache`, and consumed by `LocalCompletionBackend` (which
// turns it into completions/usage text via `commandTreeSuggestions.ts`'s
// `getSuggestions`). All the text parsing this crawl relies on is in
// `commandTreeParsingBrigadier.ts` as pure functions - this file is the
// stateful orchestration: deciding what to fetch, in what order, and how to
// merge and store the results. See docs/NO_PLUGIN_HELP_CRAWL.md.

import * as path from 'path';
import type { ConsolaInstance } from 'consola';
import { stripColors } from './ansi';
import { ParameterType, Parameter, SubcommandParameter, CommandNode, newCommandNode } from './commandTree';
import {
  HelpLinesResult,
  VariantInfo,
  parseHelpLines,
  parseHelpResponse,
  hasRealUsage,
  splitConcatenatedHelpLines,
  isGenericArgsPlaceholder,
  isUnsupportedNamespaceError,
  buildParameterStructureFromVariants,
  hasUsableArguments,
} from './commandTreeParsingBrigadier';
import { extractBukkitUsageLines, extractBukkitAliases } from './commandTreeParsingBukkit';
import { CommandTreeCache } from './commandTreeCache';
import { getSuggestions, SuggestionResult } from './commandTreeSuggestions';

export { CommandNode } from './commandTree';

/** Coarse-grained stage of `initialize()`'s progress, for UI phase labels. */
export type ProgressPhase = 'cache-hit' | 'fetching' | 'loading' | 'complete';

export class CommandTreeCrawler {
  private rootCommands: Map<string, CommandNode> = new Map();

  get commands(): Map<string, CommandNode> { return this.rootCommands; }

  // Per-command send/recv log, populated during a fresh crawl (not cache hits).
  // Keyed by root command name (no slash). Only recorded while currentLogKey is set.
  private commandLogs: Map<string, { send: string; recv: string }[]> = new Map();
  private currentLogKey: string | undefined = undefined;

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
  // every per-command detail fetch. See docs/NO_PLUGIN_HELP_CRAWL.md.
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

  // Set for the duration of `initialize()`: receives the crawl's blow-by-blow
  // narration ("Loading details for command: X", ...). When provided (no log
  // file - the narration would otherwise corrupt the console's progress bar),
  // narration is routed here instead of to `this.logger`. See `report()`.
  private onMessage?: (message: string) => void;

  constructor(
    private sendCommand: (command: string) => Promise<string>,
    private logger: ConsolaInstance,
    cacheDir: string,
    serverHost: string,
    serverPort: number
  ) {
    this.cache = new CommandTreeCache(path.join(cacheDir, 'command-cache'), serverHost, serverPort, logger, (message) => this.report(message));
  }

  /** Returns the send/recv pairs recorded while crawling `name`'s command details.
   * Falls back to a namespaced sibling key (e.g. `minecraft:gamemode` for `gamemode`)
   * since namespaced commands are crawled first and bare commands reuse their results. */
  getCommandLog(name: string): { send: string; recv: string }[] {
    const direct = this.commandLogs.get(name);
    if (direct && direct.length > 0) { return direct; }
    if (!name.includes(':')) {
      const suffix = `:${name}`;
      for (const [key, log] of this.commandLogs) {
        if (key.endsWith(suffix) && log.length > 0) { return log; }
      }
    }
    return [];
  }

  /** Calls `sendCommand` and records the pair under `currentLogKey` if set. */
  private async loggedSend(command: string): Promise<string> {
    const recv = await this.sendCommand(command);
    if (this.currentLogKey !== undefined) {
      let log = this.commandLogs.get(this.currentLogKey);
      if (!log) { log = []; this.commandLogs.set(this.currentLogKey, log); }
      log.push({ send: command, recv });
    }
    return recv;
  }

  /** Reports crawl narration: to `onMessage` (e.g. a progress bar's message) if set, else logged. */
  private report(message: string): void {
    if (this.onMessage) {
      this.onMessage(message);
    } else {
      this.logger.info(message);
    }
  }

  /**
   * Initialize command database
   */
  async initialize(
    onProgress?: (progress: number, phase: ProgressPhase) => void,
    onMessage?: (message: string) => void,
    forceRefresh: boolean = false
  ): Promise<void> {
    if (this.isLoading) { return; }

    this.isLoading = true;
    this.loadingProgress = 0;
    this.onMessage = onMessage;

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

      this.commandLogs.clear();

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
      this.report(`Loading details for ${commands.length} commands...`);

      for (let i = 0; i < commands.length; i++) {
        const progress = 10 + (80 * (i / commands.length));
        onProgress?.(progress, 'loading');

        const node = this.rootCommands.get(commands[i])!;
        this.currentLogKey = commands[i];
        try {
          await this.loadCommandDetails(node, node.members, pendingAliases);
        } catch (error) {
          this.logger.warn(`Warning: Failed to load details for ${commands[i]}: ${error}`);
        } finally {
          this.currentLogKey = undefined;
        }
      }

      // Expand aliases into rootCommands now that their targets are fully
      // loaded, sharing the target's node so alias entries stay in sync.
      for (const [alias, target] of pendingAliases) {
        const targetNode = this.rootCommands.get(target);
        if (targetNode && !this.rootCommands.has(alias)) {
          this.rootCommands.set(alias, targetNode);
          // Share the target's log so /tree <alias> shows the same send/recv pairs.
          if (!this.commandLogs.has(alias)) {
            const targetLog = this.getCommandLog(target);
            if (targetLog.length > 0) { this.commandLogs.set(alias, targetLog); }
          }
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
    let output = await this.loggedSend(command);
    const match = output.match(/Help:\s+.*?\((\d+)\/(\d+)\)/i);
    if (!match) {
      return output;
    } else {
      const pageCount = parseInt(match[2]);
      this.report(`Detected paginated output: ${pageCount} pages total`);

      for (let page = 2; page <= pageCount; page++) {
        const pageOutput = await this.loggedSend(`${command} ${page}`);
        if (pageOutput) {
          this.report(`Fetched page ${page}/${pageCount} (${pageOutput.length} bytes)`);
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
      this.report('Fetching root commands with /help...');
      const mcResponse = await this.sendCommand('minecraft:help');

      if (isUnsupportedNamespaceError(mcResponse)) {
        // Vanilla/Fabric: the `minecraft:` namespace prefix isn't
        // registered. Plain `/help` (paginated) already gives a complete,
        // accurate, one-shot command list with full <args> syntax.
        this.report('minecraft: namespace not supported; using /help for root commands');
        this.supportsMinecraftNamespace = false;

        const response = await this.fetchPaginatedCommand('help');
        this.report(`Help response received: ${response.length} bytes`);
        if (!response || response.length === 0) {
          throw new Error('Unable to fetch command list from server');
        }
        this.ingestHelpResponse(response, pendingAliases);
        return;
      }

      this.supportsMinecraftNamespace = true;
      this.report(`Help response received: ${mcResponse.length} bytes`);

      if (!mcResponse || mcResponse.length === 0) {
        this.logger.warn('Warning: Empty response from help command');
        // Try alternative help format
        const altResponse = await this.sendCommand('?');
        if (altResponse && altResponse.length > 0) {
          this.report('Using alternative help command (?)');
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
      this.rootCommands.set(name, newCommandNode(name));
      this.rootSummaryIsPlaceholder.set(name, isPlaceholder);
    }

    this.report(`Found ${this.rootCommands.size} root commands`);

    if (commands.length === 0) {
      this.logger.warn('Warning: No commands found in help response');
      this.report('First few lines of response:');
      splitConcatenatedHelpLines(response).split('\n').slice(0, 10).forEach(line => {
        this.report(`  > ${stripColors(line)}`);
      });

      // Add fallback commands
      this.addFallbackCommands();
    }
  }

  /**
   * Add fallback commands if help parsing fails
   */
  private addFallbackCommands(): void {
    this.report('Adding common Minecraft commands as fallback...');

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
        this.rootCommands.set(cmd, newCommandNode(cmd));
      }
    }

    this.report(`Added ${commonCommands.length} fallback commands`);
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
      if (node.isComplete && name.endsWith(`:${commandPath}`) && node.members.length) {
        return node;
      }
    }
    return undefined;
  }

  /**
   * Merge the two help sources for `commandPath`'s syntax into one
   * `HelpLinesResult`. `mcResponse` (from `minecraft:help <commandPath>`,
   * only fetched when `supportsMinecraftNamespace`, and sometimes skipped
   * even then as an optimization - see `loadCommandDetails`) wins unless
   * it's empty or the generic `[<args>]` placeholder Bukkit emits for
   * non-Brigadier commands, in which case `helpResponse` (from `help
   * <commandPath>`) is used instead.
   *
   * Which shape `helpResponse` is in follows directly from
   * `this.supportsMinecraftNamespace`, not from sniffing its content: when
   * `minecraft:` is supported, Paper/Spigot's `help <path>` is *always* a
   * Bukkit `Description:`/`Usage:`/`Aliases:` page (even for vanilla-backed
   * commands), extracted via `extractBukkitUsageLines`; when it isn't,
   * vanilla/fabric's `help <path>` is *always* a flat Brigadier blob. See
   * docs/NO_PLUGIN_HELP_CRAWL.md.
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
    } else if (this.supportsMinecraftNamespace) {
      // helpResponse is always a Bukkit Description:/Usage:/Aliases: page -
      // extract its Usage line(s).
      result = parseHelpLines(extractBukkitUsageLines(helpResponse, commandPath).join('\n'), commandPath);
    } else {
      // helpResponse is always a flat Brigadier blob. Like `mcResponse`,
      // vanilla's `help <path>` responses for commands with multiple
      // variants (team, gamerule, debug, ...) pack each `/path ...` onto one
      // line with no separators - re-split the same way.
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
  private async loadCommandDetails(parent: SubcommandParameter, parameters: Parameter[], pendingAliases: Map<string, string>): Promise<void> {
    const commandPath = parent.name;

    // A bare command (e.g. "version") and its namespaced counterparts (e.g.
    // "bukkit:version", "minecraft:version") describe the same underlying
    // command and have identical `help`/`minecraft:help` output - fetching
    // both is wasteful. Namespaced commands are loaded first (see
    // initialize()), so if one is already complete, reuse its parameters
    // instead of repeating the round trips.
    const sibling = this.findNamespacedSibling(commandPath);
    if (sibling) {
      parameters.length = 0;
      parameters.push(...sibling.members);
      parent.isComplete = true;
      this.report(`Reusing ${sibling.name}'s details for ${commandPath}`);
      return;
    }

    // Reported before the round trips below (rather than after) so it's
    // visible while they're in flight, instead of being instantly
    // overwritten by the next command's report.
    this.report(`Loading details for command: ${commandPath}`);

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
        const fromHelp = parseHelpLines(extractBukkitUsageLines(helpResponse, commandPath).join('\n'), commandPath);
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
        this.logger.warn(`Empty help response for: ${commandPath}`);
        return;
      }

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

      this.report(`Loaded ${parameters.length} parameter(s) for ${commandPath}`);

      // Mark as complete
      parent.isComplete = true;

      // Recursively load details for all subcommands
      await this.loadSubcommandsIn(commandPath, parameters);

    } catch (error) {
      this.logger.error(`Error loading details for ${commandPath}: ${error}`);
      // Mark as complete even on error to avoid infinite loops
      parent.isComplete = true;
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
    if (hasUsableArguments(subcommand.members)) {
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
    if (subcommand.members.length === 0 && subcommand.optional) {
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
      subcommand.members.length = 0;
      if (direct !== null) {
        subcommand.members.push(...direct);
      } else {
        subcommand.members.push(...buildParameterStructureFromVariants(variants));
      }

      subcommand.isComplete = true;

      // Recursively load any nested subcommands
      await this.loadSubcommandsIn(fullPath, subcommand.members);

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
      if (param.type === ParameterType.CHOICE_LIST) {
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