// src/historyStore.ts
//
// Command history: on-disk persistence (server-scoped, like
// commandTreeCache.ts) — loaded once at session start to seed LineEditor's
// in-memory history and rewritten each time a command is run — plus the pure
// state/matching logic for Ctrl+R reverse history search, which operates on
// that same in-memory list.

import * as fs from 'fs';
import * as path from 'path';
import type { ConsolaInstance } from 'consola';

export class HistoryStore {
  private readonly file: string;

  /** `maxEntries` mirrors LineEditor's in-memory cap — no point persisting more than it'll ever hold. */
  constructor(cacheDir: string, serverHost: string, serverPort: number, private logger: ConsolaInstance, private readonly maxEntries: number = 100) {
    this.file = path.join(cacheDir, `${serverHost}_${serverPort}_history.txt`);
  }

  /** Returns persisted entries (oldest-first), or `[]` if there's nothing usable to load. */
  load(): string[] {
    try {
      if (!fs.existsSync(this.file)) { return []; }
      const lines = fs.readFileSync(this.file, 'utf-8').split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }
      return lines.slice(-this.maxEntries);
    } catch (error) {
      this.logger.error(`Error loading command history: ${error}`);
      return [];
    }
  }

  /** Persists `entries` (oldest-first, one per line), overwriting whatever was there before. Newlines within an entry are stripped. */
  save(entries: readonly string[]): void {
    try {
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const lines = entries.slice(-this.maxEntries).map((entry) => entry.replace(/[\r\n]/g, ''));
      fs.writeFileSync(this.file, lines.map((line) => `${line}\n`).join(''));
    } catch (error) {
      this.logger.error(`Error saving command history: ${error}`);
    }
  }
}

/** Entries from `history` (oldest-first) containing `query` (case-insensitive), most-recently-used first, deduplicated. An empty query matches everything, so the list starts as "recent history, newest first". */
export function searchHistory(history: readonly string[], query: string): string[] {
  const lowerQuery = query.toLowerCase();
  const seen = new Set<string>();
  const results: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (seen.has(entry)) { continue; }
    seen.add(entry);
    if (entry.toLowerCase().includes(lowerQuery)) {
      results.push(entry);
    }
  }
  return results;
}

export interface HistorySearchState {
  query: string;
  items: string[];
  selectedIndex: number;
  /** The line as it was before search started — restored on cancel. */
  originalLine: string;
}

/** Enters search mode: empty query, recent history shown newest-first. */
export function startHistorySearch(history: readonly string[], originalLine: string): HistorySearchState {
  return { query: '', items: searchHistory(history, ''), selectedIndex: 0, originalLine };
}

/** Re-filters as the query changes (typing or backspacing), resetting to the best (first) match. */
export function setHistorySearchQuery(history: readonly string[], state: HistorySearchState, query: string): HistorySearchState {
  return { ...state, query, items: searchHistory(history, query), selectedIndex: 0 };
}

/** Moves the selection by `delta`, wrapping; a no-op when there's nothing to select. */
export function cycleHistorySearch(state: HistorySearchState, delta: number): HistorySearchState {
  if (state.items.length === 0) { return state; }
  const selectedIndex = ((state.selectedIndex + delta) % state.items.length + state.items.length) % state.items.length;
  return { ...state, selectedIndex };
}
