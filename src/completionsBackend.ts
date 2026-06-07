// src/completionsBackend.ts
//
// The completionEngine state machine knows it needs completions and usage
// text for a given input line — it doesn't know or care whether those come
// from a network round trip or an in-memory lookup. A CompletionsBackend is
// that boundary: one implementation asks the server-side RconTabComplete
// plugin over RCON, the other asks the locally-built command tree.
//
// Driving both modes through the same backend interface (and therefore the
// same engine, the same dispatch plumbing, and the same rendering) is what
// lets RconTerminal be entirely mode-blind — "which backend" is decided once,
// not branched on at every call site.

import { RconController } from './rconClient';
import { CommandAutocomplete } from './commandAutocomplete';
import { buildCompletionsQuery, buildUsageQuery, parseCompletionsResponse, parseUsageResponse } from './completionEngine';

export interface CompletionsBackend {
  fetchCompletions(line: string): Promise<string[]>;
  fetchUsage(line: string): Promise<string>;
}

/** Server-side completions via the RconTabComplete plugin's `tabcomplete`/`cmdusage` commands. */
export class RconCompletionsBackend implements CompletionsBackend {
  constructor(private controller: RconController) {}

  async fetchCompletions(line: string): Promise<string[]> {
    const query = buildCompletionsQuery(line);
    if (query === null) { return []; }
    const response = await this.controller.send(`tabcomplete ${query}`);
    return parseCompletionsResponse(response ?? undefined);
  }

  async fetchUsage(line: string): Promise<string> {
    const query = buildUsageQuery(line);
    if (query === null) { return ''; }
    const response = await this.controller.send(`cmdusage ${query}`);
    return parseUsageResponse(response ?? undefined);
  }
}

/**
 * Local completions via the command tree CommandAutocomplete builds at
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

  constructor(private autocomplete: CommandAutocomplete) {}

  async fetchCompletions(line: string): Promise<string[]> {
    return this.autocomplete.getSuggestions(line).suggestions;
  }

  async fetchUsage(line: string): Promise<string> {
    const result = this.autocomplete.getSuggestions(line);
    const commandName = (line.match(/^(\/?\w+)/) || [])[1] || '';

    if (commandName !== this.cachedCommand) {
      this.cachedCommand = commandName;
      this.cachedHelp = null;
    }

    if (result.argumentHelp) {
      if (this.cachedHelp === null) {
        this.cachedHelp = result.argumentHelp;
      }
      return this.cachedHelp;
    }
    return this.cachedHelp ?? '';
  }
}
