// src/test/pagination.test.ts
//
// Tests for client-side pagination stitching: the Multiverse-Core pattern and
// the generic page-walking stitcher (detection, page fetching, chrome
// stripping, and the resilience/short-circuit cases).

import * as assert from 'assert';
import {
  stitchPaginated,
  DEFAULT_PATTERNS,
  PaginationPattern,
  StitchOptions,
} from '../pagination';

const mvCore = DEFAULT_PATTERNS.find(p => p.name === 'multiverse-core') as PaginationPattern;

/** Build a Multiverse-Core-style page response. */
function mvPage(page: number, total: number, lines: string[]): string {
  return ['====[ Multiverse World List ]====', `[Page ${page} of ${total}]`, ...lines].join('\n');
}

const WORLDS: Record<number, string[]> = {
  1: ['world - NORMAL', 'world_nether - NETHER', 'world_the_end - THE_END'],
  2: ['elficka - NORMAL', 'hay_house - NORMAL', 'hub_map - NORMAL'],
  3: ['peaceful - NORMAL', 'pumpkin_cave - NORMAL'],
};

/** A fetchPage that serves the canned `mv list --page N` responses. */
function mvFetcher(record: string[]): (command: string) => Promise<string> {
  return async (command: string) => {
    record.push(command);
    const match = command.match(/--page (\d+)/);
    const page = match ? Number(match[1]) : 1;
    return mvPage(page, 3, WORLDS[page] ?? []);
  };
}

suite('multiverse-core pattern', () => {
  test('detects page and total', () => {
    assert.deepStrictEqual(mvCore.detect(mvPage(2, 3, WORLDS[2])), { page: 2, totalPages: 3 });
  });

  test('does not detect unrelated output', () => {
    assert.strictEqual(mvCore.detect('Just some plain command output\nwith two lines'), undefined);
  });

  test('detects through Minecraft color codes', () => {
    const colored = `§a====[ §fMultiverse World List §a]====\n§7[Page 1 of 4]\n§bworld§r - NORMAL`;
    assert.deepStrictEqual(mvCore.detect(colored), { page: 1, totalPages: 4 });
  });

  test('pageCommand appends --page', () => {
    assert.strictEqual(mvCore.pageCommand('mv list', 3), 'mv list --page 3');
  });

  test('pageCommand replaces an existing --page', () => {
    assert.strictEqual(mvCore.pageCommand('mv list --page 2', 3), 'mv list --page 3');
    assert.strictEqual(mvCore.pageCommand('mv list --page=2', 5), 'mv list --page 5');
  });

  test('contentLines strips title and page lines', () => {
    assert.deepStrictEqual(mvCore.contentLines(mvPage(2, 3, WORLDS[2])), WORLDS[2]);
  });

  test('titleLines returns the banner once', () => {
    assert.deepStrictEqual(mvCore.titleLines(mvPage(2, 3, WORLDS[2])), [
      '====[ Multiverse World List ]====',
    ]);
  });

  test('hasExplicitPage recognises a page request', () => {
    assert.strictEqual(mvCore.hasExplicitPage('mv list --page 2'), true);
    assert.strictEqual(mvCore.hasExplicitPage('mv list'), false);
  });
});

suite('stitchPaginated', () => {
  test('combines the held first page with fetched remaining pages', async () => {
    const sent: string[] = [];
    const first = mvPage(1, 3, WORLDS[1]);
    const stitched = await stitchPaginated(first, 'mv list', mvFetcher(sent));
    assert.ok(stitched, 'expected a stitched result');
    const lines = (stitched as string).split('\n');
    // Banner appears exactly once, no "[Page x of y]" lines remain.
    assert.strictEqual(lines.filter(l => l.includes('Multiverse World List')).length, 1);
    assert.strictEqual(lines.filter(l => /\[Page \d+ of \d+\]/.test(l)).length, 0);
    // All worlds from all three pages are present, in order.
    for (const world of [...WORLDS[1], ...WORLDS[2], ...WORLDS[3]]) {
      assert.ok(lines.includes(world), `expected ${world} in stitched output`);
    }
    // Page 1 was already held; only pages 2 and 3 were fetched.
    assert.deepStrictEqual(sent, ['mv list --page 2', 'mv list --page 3']);
  });

  test('returns undefined for a single-page response (nothing to stitch)', async () => {
    const sent: string[] = [];
    const first = mvPage(1, 1, WORLDS[1]);
    const stitched = await stitchPaginated(first, 'mv list', mvFetcher(sent));
    assert.strictEqual(stitched, undefined);
    assert.deepStrictEqual(sent, []);
  });

  test('returns undefined when the command already requests a page', async () => {
    const sent: string[] = [];
    const first = mvPage(2, 3, WORLDS[2]);
    const stitched = await stitchPaginated(first, 'mv list --page 2', mvFetcher(sent));
    assert.strictEqual(stitched, undefined);
    assert.deepStrictEqual(sent, []);
  });

  test('returns undefined when no pattern matches', async () => {
    const sent: string[] = [];
    const stitched = await stitchPaginated('plain output', 'someplugin go', mvFetcher(sent));
    assert.strictEqual(stitched, undefined);
    assert.deepStrictEqual(sent, []);
  });

  test('falls back gracefully when a page fetch throws', async () => {
    const sent: string[] = [];
    const fetch = async (command: string): Promise<string> => {
      sent.push(command);
      throw new Error('connection lost');
    };
    const first = mvPage(1, 3, WORLDS[1]);
    const stitched = await stitchPaginated(first, 'mv list', fetch, {
      log: () => {},
    });
    // We still get page 1's content (never worse than what we held).
    assert.ok(stitched, 'expected at least page 1 content');
    for (const world of WORLDS[1]) {
      assert.ok((stitched as string).includes(world));
    }
  });

  test('skips a page whose response no longer matches the pattern', async () => {
    const sent: string[] = [];
    const fetch = async (command: string): Promise<string> => {
      sent.push(command);
      if (command.includes('--page 2')) {
        return 'You do not have permission to do that.';
      }
      const page = Number((command.match(/--page (\d+)/) ?? [])[1] ?? 1);
      return mvPage(page, 3, WORLDS[page] ?? []);
    };
    const first = mvPage(1, 3, WORLDS[1]);
    const stitched = await stitchPaginated(first, 'mv list', fetch);
    assert.ok(stitched);
    // Page 2's error text must not leak into the output.
    assert.ok(!(stitched as string).includes('permission'));
    // Pages 1 and 3 survive.
    for (const world of [...WORLDS[1], ...WORLDS[3]]) {
      assert.ok((stitched as string).includes(world));
    }
  });

  test('respects the maxPages safety cap', async () => {
    const sent: string[] = [];
    const fetch = async (command: string): Promise<string> => {
      sent.push(command);
      const page = Number((command.match(/--page (\d+)/) ?? [])[1] ?? 1);
      return mvPage(page, 999, [`world${page}`]);
    };
    const first = mvPage(1, 999, ['world1']);
    const options: StitchOptions = { maxPages: 3 };
    await stitchPaginated(first, 'mv list', fetch, options);
    // Page 1 held; only 2 and 3 fetched given the cap of 3.
    assert.deepStrictEqual(sent, ['mv list --page 2', 'mv list --page 3']);
  });
});
