// src/historySearch.ts
//
// Pure state and matching logic for Ctrl+R reverse history search. Unlike
// completionEngine.ts, there's no network round trip involved — searching is
// just filtering an in-memory array — so this is plain synchronous state
// transitions, no reducer/effect machinery needed.

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
