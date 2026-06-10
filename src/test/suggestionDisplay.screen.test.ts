// src/test/suggestionDisplay.screen.test.ts
//
// Renders SuggestionDisplay's output into a real (headless) terminal emulator
// and asserts on the resulting screen buffer. This is the only way to verify
// the "scroll-safe return" cursor math in clear()/renderSuggestionArea(): that
// \x1b[NA + \r + \x1b[NC correctly restores the cursor to the prompt line even
// when the \r\n writes above it caused the terminal viewport to scroll, which
// the raw-ANSI-string assertions in suggestionDisplay.test.ts can't observe.

import * as assert from 'assert';
import { Terminal } from '@xterm/headless';
import { SuggestionDisplay, SuggestionDisplayHost } from '../suggestionDisplay';

/**
 * Buffers writes and applies them to an @xterm/headless Terminal on flush().
 * cursorColumn() is an injectable value (set by the test), mirroring the
 * analytical — not terminal-derived — production implementation in
 * rconSession.ts (promptWidth + lineEditor.cursor).
 */
class ScreenHost implements SuggestionDisplayHost {
    column = 0;
    private pending = '';

    constructor(private term: Terminal) {}

    write(text: string): void { this.pending += text; }
    cursorColumn(): number { return this.column; }

    flush(): Promise<void> {
        const data = this.pending;
        this.pending = '';
        if (!data) { return Promise.resolve(); }
        return new Promise((resolve) => this.term.write(data, () => resolve()));
    }
}

function lineText(term: Terminal, y: number): string {
    return term.buffer.active.getLine(y)?.translateToString(true) ?? '';
}

suite('SuggestionDisplay: rendered screen (xterm-headless)', () => {
    test('cursor returns to the prompt line even when drawing the suggestion area scrolls the viewport', async () => {
        const term = new Terminal({ cols: 40, rows: 7, allowProposedApi: true });
        const host = new ScreenHost(term);
        const display = new SuggestionDisplay(host);

        try {
            // A couple of lines of prior server output, then the prompt — in
            // real usage the prompt is never on row 0 of an empty terminal.
            host.write('Server started.\r\n');
            host.write('[12:00:00] [Server thread/INFO]: Done!\r\n');
            const prompt = '> /gamemode ';
            host.write(prompt);
            host.column = prompt.length;
            await host.flush();

            const buf = term.buffer.active;
            const promptRow = buf.viewportY + buf.cursorY;
            assert.strictEqual(lineText(term, promptRow), prompt, 'sanity check: prompt is on its own row before rendering');

            // 4 items + footer = 5 lines drawn below the prompt — on a 7-row
            // terminal that's enough to push the prompt off the bottom and
            // force the viewport to scroll, while still fitting within the
            // terminal (5 <= rows - 1), the regime where the relative
            // \x1b[NA restoration is exact.
            display.render(['survival', 'creative', 'adventure', 'spectator'], 0, null, '/gamemode ');
            await host.flush();

            assert.notStrictEqual(buf.viewportY, 0, 'drawing the suggestion area should have scrolled the viewport');
            assert.strictEqual(buf.cursorX, prompt.length, 'cursor restored to the end of the prompt');
            assert.strictEqual(buf.viewportY + buf.cursorY, promptRow, 'cursor is back on the prompt\'s row despite the scroll');
            assert.strictEqual(lineText(term, promptRow), prompt, 'the prompt row still shows the prompt, untouched by the suggestion area');
        } finally {
            term.dispose();
        }
    });

    test('a shorter re-render fully erases the previous, longer frame — no stale lines left behind', async () => {
        const term = new Terminal({ cols: 40, rows: 24, allowProposedApi: true });
        const host = new ScreenHost(term);
        const display = new SuggestionDisplay(host);

        try {
            const prompt = '> ';
            host.write(prompt);
            host.column = prompt.length;
            await host.flush();

            display.render(['survival', 'creative', 'adventure', 'spectator'], 0, null, '/foo ');
            await host.flush();
            assert.ok(lineText(term, 5).includes('[1/4] Page 1/1'), 'sanity check: first frame drew 5 lines (4 items + footer)');

            display.render(['a'], 0, null, '/foo ');
            await host.flush();

            const buf = term.buffer.active;
            assert.strictEqual(buf.cursorX, prompt.length, 'cursor restored to the end of the prompt');
            assert.strictEqual(buf.cursorY, 0, 'still on the prompt row');
            assert.ok(lineText(term, 1).includes('a'), 'row 1 shows the new (shorter) frame');
            assert.ok(!lineText(term, 1).includes('survival'), 'row 1 no longer shows the old frame');
            assert.ok(lineText(term, 2).includes('[1/1] Page 1/1'), 'row 2 shows the new frame\'s footer');
            assert.strictEqual(lineText(term, 3), '', 'row 3 (part of the old, longer frame) was cleared and not redrawn');
            assert.strictEqual(lineText(term, 4), '', 'row 4 was cleared and not redrawn');
            assert.strictEqual(lineText(term, 5), '', 'row 5 was cleared and not redrawn');
        } finally {
            term.dispose();
        }
    });
});
