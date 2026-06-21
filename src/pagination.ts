// src/pagination.ts
//
// Client-side "stitching" of plugin commands that paginate their OWN output,
// independently of the server-side `rcat` de-pagination. Some plugins — most
// notably Multiverse-Core — only ever return a single page per RCON call, with
// a "Page X of Y" header and their own page argument, so `rcat` alone still
// leaves you on page 1. When de-pagination is active we recognise that chrome,
// re-issue the command once per page, strip the headers, and concatenate the
// bodies into one response that flows into the pager like any other output.
//
// The set of recognised formats lives in DEFAULT_PATTERNS and is intentionally
// open: add a PaginationPattern for each plugin family whose page navigation we
// can actually drive from the command line. Plugins with no usable "go to page
// N" command have no pattern and fall through unchanged — e.g.
// Multiverse-Portals, whose `mvp list [filter] [page]` treats the first
// positional as a name filter, so there is no way to request page 2 of the
// *unfiltered* list. If a future version exposes a real page flag, add a
// pattern here and it will be picked up automatically.

import { stripColors } from './ansi';

/** One recognised multi-page output format (e.g. Multiverse-Core). */
export interface PaginationPattern {
  readonly name: string;

  /**
   * If `response` is one page of this pattern's paginated output, return which
   * page it is and how many pages there are in total; otherwise `undefined`.
   */
  detect(response: string): { page: number; totalPages: number } | undefined;

  /** The command that fetches a specific page of `command`'s output. */
  pageCommand(command: string, page: number): string;

  /** This page's body, with the pattern's chrome (title, "Page X of Y") removed. */
  contentLines(response: string): string[];

  /** Header line(s) to show once at the top of the stitched output (may be empty). */
  titleLines(response: string): string[];

  /**
   * True if `command` already asks for a specific page — in which case we honour
   * that request and do not stitch the whole thing together.
   */
  hasExplicitPage(command: string): boolean;
}

// --- Multiverse-Core -------------------------------------------------------
//
// ContentDisplay output looks like:
//
//   ====[ Multiverse World List ]====
//   [Page 2 of 3]
//   elficka - NORMAL
//   ...
//
// A specific page is fetched with `--page N` (also accepts `--page=N`).

const MV_PAGE_LINE = /\[Page (\d+) of (\d+)\]/i;
const MV_TITLE_LINE = /^={2,}\[.*\]={2,}$/;
const MV_PAGE_ARG = /\s--page(?:=|\s+)\d+\b/i;

/** Hard cap on pages we'll fetch — a clamp against bogus/huge page counts. */
const MAX_PAGES = 1000;

const multiverseCore: PaginationPattern = {
  name: 'multiverse-core',

  detect(response) {
    const match = stripColors(response).match(MV_PAGE_LINE);
    if (!match) {
      return undefined;
    }
    const page = Number(match[1]);
    // totalPages comes from untrusted server output; clamp it to MAX_PAGES so a
    // bogus or huge value can't drive an unbounded fetch walk.
    const totalPages = Math.min(Number(match[2]), MAX_PAGES);
    return { page, totalPages };
  },

  pageCommand(command, page) {
    const base = command.replace(MV_PAGE_ARG, '').trimEnd();
    return `${base} --page ${page}`;
  },

  contentLines(response) {
    return response.split('\n').filter(line => {
      const bare = stripColors(line).trim();
      return !MV_PAGE_LINE.test(bare) && !MV_TITLE_LINE.test(bare);
    });
  },

  titleLines(response) {
    return response.split('\n').filter(line => MV_TITLE_LINE.test(stripColors(line).trim()));
  },

  hasExplicitPage(command) {
    return MV_PAGE_ARG.test(command);
  },
};

/** Recognised paginated-output formats, tried in order. */
export const DEFAULT_PATTERNS: readonly PaginationPattern[] = [multiverseCore];

export interface StitchOptions {
  /** Override the recognised formats (defaults to DEFAULT_PATTERNS). */
  patterns?: readonly PaginationPattern[];
  /** Optional sink for diagnostic messages. */
  log?: (message: string) => void;
}

/**
 * If `firstResponse` is a recognised paginated output and `command` did not
 * already request a specific page, fetch every page via `fetchPage`, strip the
 * chrome, and return the concatenated result. Returns `undefined` when nothing
 * was stitched (not paginated, single page, explicit page requested, or no
 * pattern matched) so the caller can use the original response unchanged.
 *
 * Resilient by design: a page fetch that throws, or whose response no longer
 * matches the pattern, stops/skips rather than corrupting the output — so the
 * result is never worse than the single page the caller already holds.
 */
export async function stitchPaginated(
  firstResponse: string,
  command: string,
  fetchPage: (command: string) => Promise<string>,
  options: StitchOptions = {},
): Promise<string | undefined> {
  const patterns = options.patterns ?? DEFAULT_PATTERNS;

  for (const pattern of patterns) {
    if (pattern.hasExplicitPage(command)) {
      continue;
    }
    const detected = pattern.detect(firstResponse);
    if (!detected) {
      continue;
    }

    // detect() already clamps totalPages to a safe maximum.
    const totalPages = detected.totalPages;
    if (totalPages <= 1) {
      return undefined; // single page — nothing to stitch
    }

    const pages = new Map<number, string[]>();
    pages.set(detected.page, trimBlankEdges(pattern.contentLines(firstResponse)));

    for (let page = 1; page <= totalPages; page++) {
      if (pages.has(page)) {
        continue;
      }
      let pageResponse: string;
      try {
        pageResponse = await fetchPage(pattern.pageCommand(command, page));
      } catch (err) {
        options.log?.(`pagination: ${pattern.name} page ${page} fetch failed: ${String(err)}`);
        break; // give up the walk; emit what we have
      }
      // A non-matching page (error text, out of range) is skipped rather than
      // appended verbatim.
      if (!pattern.detect(pageResponse)) {
        options.log?.(`pagination: ${pattern.name} page ${page} did not match; skipping`);
        continue;
      }
      pages.set(page, trimBlankEdges(pattern.contentLines(pageResponse)));
    }

    const out: string[] = [...pattern.titleLines(firstResponse)];
    for (let page = 1; page <= totalPages; page++) {
      const content = pages.get(page);
      if (content) {
        out.push(...content);
      }
    }
    return out.join('\n');
  }

  return undefined;
}

/** Drop leading/trailing blank lines so stitched pages don't accrue gaps. */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && stripColors(lines[start]).trim() === '') {
    start++;
  }
  while (end > start && stripColors(lines[end - 1]).trim() === '') {
    end--;
  }
  return lines.slice(start, end);
}
