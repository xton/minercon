// src/completionsBackend.ts
//
// The completionEngine state machine knows it needs completions and usage
// text for a given input line — it doesn't know or care whether those come
// from a network round trip or an in-memory lookup. A CompletionsBackend is
// that boundary: one implementation asks the server-side TabComplete
// plugin over RCON, the other asks the locally-built command tree.
//
// Driving both modes through the same backend interface (and therefore the
// same engine, the same dispatch plumbing, and the same rendering) is what
// lets RconSession be entirely mode-blind — "which backend" is decided once,
// not branched on at every call site.

import { RconController } from './rconClient';
import { LocalCommandTree } from './localCommandTree';
import { buildCompletionsQuery, buildUsageQuery, parseCompletionsResponse, parseUsageResponse } from './completionEngine';

export interface CompletionsBackend {
  fetchCompletions(line: string): Promise<string[]>;
  fetchUsage(line: string): Promise<string>;
}

/**
 * Server-side completions via the TabComplete plugin's `tabcomplete`/`cmdusage` commands.
 *
 * Takes a `controller` thunk rather than a fixed `RconController` — the
 * connection manager replaces its controller wholesale on every reconnect, so
 * capturing one instance up front would silently start sending through a dead
 * (disconnected) controller after the first reconnect, with every fetch
 * throwing "Not connected" (swallowed by the caller as "no completions").
 * Looking it up fresh on each call always reaches whatever's live.
 */
export class RconCompletionsBackend implements CompletionsBackend {
  constructor(private getController: () => RconController) {}

  async fetchCompletions(line: string): Promise<string[]> {
    const query = buildCompletionsQuery(line);
    if (query === null) { return []; }
    const response = await this.getController().send(`tabcomplete ${query}`);
    return parseCompletionsResponse(response ?? undefined);
  }

  async fetchUsage(line: string): Promise<string> {
    const query = buildUsageQuery(line);
    if (query === null) { return ''; }
    const response = await this.getController().send(`cmdusage ${query}`);
    return parseUsageResponse(response ?? undefined);
  }
}

/**
 * Local completions via the command tree LocalCommandTree builds at
 * startup — a synchronous in-memory lookup, wrapped in `async` so it flows
 * through exactly the same dispatch path as the RCON backend (the `await`
 * still yields to the microtask queue, so a `dispatchToEngine` call made from
 * here lands *after* the effect loop that triggered it has finished — same
 * ordering guarantee the real async backend gets for free from the network).
 */
export class LocalCompletionsBackend implements CompletionsBackend {
  // getSuggestions sometimes returns incomplete argument help for inputs that
  // are mid-command (e.g. once the user is typing a free-form argument like a
  // player name, the locally-built tree may not have anything to say). Stick
  // with the first full version we saw for this command rather than flicker
  // between that and "(nothing)" — mirrors the original local-mode behavior.
  private cachedCommand: string | null = null;
  private cachedHelp: string | null = null;

  constructor(private commandTree: LocalCommandTree) {}

  async fetchCompletions(line: string): Promise<string[]> {
    return this.commandTree.getSuggestions(line).suggestions;
  }

  async fetchUsage(line: string): Promise<string> {
    const result = this.commandTree.getSuggestions(line);
    // Everything up to the first space, including any "namespace:" prefix -
    // \S rather than \w so "minecraft:clear" isn't truncated to "minecraft".
    const commandName = (line.match(/^\/?(\S+)/) || [])[1] || '';

    if (commandName !== this.cachedCommand) {
      this.cachedCommand = commandName;
      this.cachedHelp = null;
    }

    if (result.argumentHelp !== undefined) {
      // Match the shape of the server's `cmdusage` response (e.g. "clear
      // [<targets>] [<item>]") - formatArgumentHint derives the command
      // prefix from this leading commandPath, so it must be present even
      // when there's no argument help (e.g. "reload").
      const usage = result.argumentHelp ? `${result.commandPath} ${result.argumentHelp}` : result.commandPath!;
      if (this.cachedHelp === null) {
        this.cachedHelp = usage;
      }
      return this.cachedHelp;
    }
    return this.cachedHelp ?? '';
  }
}
