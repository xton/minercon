// src/test/pager.test.ts
//
// Tests for the append-only terminal pager. The central guarantee is that the
// paged output stays in the terminal scrollback after exit — i.e. the pager
// NEVER clears the screen (\x1b[2J) or switches to the alternate buffer
// (\x1b[?1049h / \x1b[?1047h); it only erases its own one-line status prompt in
// place (\r\x1b[K) before appending the next batch.

import * as assert from 'assert';
import { Pager, ArrayLineSource, PagerHost, visualRowCount } from '../pager';

class FakeHost implements PagerHost {
  writes: string[] = [];
  rows = 5;
  cols = 80;
  write(text: string): void { this.writes.push(text); }
  dimensions(): { columns: number; rows: number } | undefined { return { columns: this.cols, rows: this.rows }; }
  output(): string { return this.writes.join(''); }
}

function lines(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `L${i}`);
}

function setup(n: number, rows = 5): { host: FakeHost; pager: Pager; done: () => number } {
  const host = new FakeHost();
  host.rows = rows;
  let doneCount = 0;
  const pager = new Pager(host, new ArrayLineSource(lines(n)), () => { doneCount++; });
  return { host, pager, done: () => doneCount };
}

const ALT_SCREEN = ['\x1b[2J', '\x1b[?1049h', '\x1b[?1047h'];
function assertNoScreenClears(output: string): void {
  for (const seq of ALT_SCREEN) {
    assert.ok(!output.includes(seq), `pager must not emit ${JSON.stringify(seq)} (would wipe scrollback)`);
  }
}

suite('visualRowCount', () => {
  test('empty line still occupies one row', () => {
    assert.strictEqual(visualRowCount('', 80), 1);
  });
  test('short line is one row', () => {
    assert.strictEqual(visualRowCount('abc', 80), 1);
  });
  test('a line one char past the width wraps to two rows', () => {
    assert.strictEqual(visualRowCount('x'.repeat(81), 80), 2);
  });
  test('ANSI color codes do not count toward width', () => {
    assert.strictEqual(visualRowCount('\x1b[31mabc\x1b[0m', 80), 1);
  });
});

suite('Pager: first batch', () => {
  test('prints exactly (rows-1) content lines then a status prompt', () => {
    const { host, pager } = setup(10, 5); // pageHeight = 4
    pager.start();
    const out = host.output();
    for (const l of ['L0', 'L1', 'L2', 'L3']) {
      assert.ok(out.includes(`${l}\r\n`), `expected ${l} in first batch`);
    }
    assert.ok(!out.includes('L4'), 'should not have printed past the first page');
    assert.ok(out.includes('(4/10)'), `expected status counter, got: ${JSON.stringify(out)}`);
    assertNoScreenClears(out);
    assert.ok(!pager.isFinished);
  });
});

suite('Pager: forward paging retains scrollback', () => {
  test('Space appends the next batch below, never re-clearing earlier lines', () => {
    const { host, pager } = setup(10, 5);
    pager.start();
    pager.handleKey(' ');
    const out = host.output();
    // Earlier lines remain in the stream (not wiped).
    for (const l of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']) {
      assert.ok(out.includes(`${l}\r\n`), `expected ${l} after paging`);
    }
    assert.ok(out.includes('(8/10)'), 'status should advance to 8/10');
    assertNoScreenClears(out);
    // The only in-place erase is the status line (\r\x1b[K).
    assert.ok(out.includes('\r\x1b[K'), 'status line should be erased in place between batches');
  });

  test('Enter advances by a single line', () => {
    const { host, pager } = setup(10, 5);
    pager.start();
    pager.handleKey('\r');
    assert.ok(host.output().includes('(5/10)'), 'one-line advance → 5/10');
  });

  test('G prints all remaining and finishes', () => {
    const { host, pager, done } = setup(10, 5);
    pager.start();
    pager.handleKey('G');
    const out = host.output();
    for (let i = 0; i < 10; i++) {
      assert.ok(out.includes(`L${i}\r\n`), `expected L${i} after G`);
    }
    assert.ok(pager.isFinished);
    assert.strictEqual(done(), 1, 'onDone fires once');
    assertNoScreenClears(out);
  });
});

suite('Pager: exit', () => {
  test('q erases the status line, finishes, and calls onDone exactly once', () => {
    const { host, pager, done } = setup(10, 5);
    pager.start();
    pager.handleKey('q');
    assert.ok(pager.isFinished);
    assert.strictEqual(done(), 1);
    assert.ok(host.output().endsWith('\r\x1b[K'), 'last write should clear the status line');
  });

  test('Ctrl+C also exits', () => {
    const { pager, done } = setup(10, 5);
    pager.start();
    pager.handleKey('\x03');
    assert.ok(pager.isFinished);
    assert.strictEqual(done(), 1);
  });

  test('paging to the end finishes without leaving a status prompt', () => {
    const { host, pager, done } = setup(8, 5); // pageHeight 4; one Space reaches the end
    pager.start();
    assert.ok(host.output().includes('(4/8)'));
    pager.handleKey(' ');
    assert.ok(pager.isFinished, 'reaching the end finishes');
    assert.strictEqual(done(), 1);
    // The final batch reaches the end, so no new status prompt is drawn — output
    // ends with the last content line, and only one status counter was ever shown.
    assert.ok(host.output().endsWith('L7\r\n'), 'ends on the last content line, no dangling prompt');
    assert.strictEqual((host.output().match(/-- More --/g) ?? []).length, 1, 'status shown only once');
  });

  test('keys are ignored after finishing', () => {
    const { host, pager, done } = setup(8, 5);
    pager.start();
    pager.handleKey('G');
    const lenAfterFinish = host.writes.length;
    pager.handleKey(' ');
    assert.strictEqual(host.writes.length, lenAfterFinish, 'no further writes after finish');
    assert.strictEqual(done(), 1);
  });
});

suite('Pager: resize', () => {
  test('a taller window between keystrokes yields a taller next batch', () => {
    const { host, pager } = setup(30, 5); // pageHeight 4
    pager.start();
    assert.ok(host.output().includes('(4/30)'));
    host.rows = 13; // pageHeight now 12
    pager.handleKey(' ');
    assert.ok(host.output().includes('(16/30)'), 'next batch uses the new height (4 + 12)');
  });
});

suite('ArrayLineSource', () => {
  test('exposes length and lineAt', () => {
    const src = new ArrayLineSource(['a', 'b', 'c']);
    assert.strictEqual(src.length(), 3);
    assert.strictEqual(src.lineAt(1), 'b');
  });
});
