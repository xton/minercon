// src/test/displaySuggestion.screen.test.ts
//
// Renders SuggestionDisplay's output into a real (headless) terminal emulator
// and asserts on the resulting screen buffer. This is the only way to verify
// the "scroll-safe return" cursor math in clear()/renderSuggestionArea(): that
// \x1b[NA + \r + \x1b[NC correctly restores the cursor to the prompt line even
// when the \r\n writes above it caused the terminal viewport to scroll, which
// the raw-ANSI-string assertions in displaySuggestion.test.ts can't observe.

import * as assert from 'assert';
import { Terminal } from '@xterm/headless';
import { SuggestionDisplay, SuggestionDisplayHost } from '../displaySuggestion';

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

// SuggestionDisplay's cursor-restoration math (clear() / renderSuggestionArea())
// asks the host for cursorColumn() and writes `\x1b[${col}C` to get back there.
// In production (rconSession.ts) that value is promptWidth + lineEditor.cursor,
// reduced mod the terminal's column count when known — the cursor's column on
// whichever row it actually wrapped onto. This suite checks that a host
// supplying that wrap-aware column gets the popup drawn in the right spot,
// intact, with the cursor restored to where the typed text actually ends.
suite('SuggestionDisplay: input line wraps onto a second terminal row', () => {
    test('popup is drawn in the right spot, is intact, and the cursor is restored to the end of the wrapped line', async () => {
        const term = new Terminal({ cols: 30, rows: 10, allowProposedApi: true });
        const host = new ScreenHost(term);
        const display = new SuggestionDisplay(host);

        try {
            host.write('Server started.\r\n');

            const prompt = '> ';
            // 46 chars; prompt (2) + line (46) = 48 > 30 cols, so this wraps
            // onto a second terminal row.
            const typedLine = '/tp ' + 'Player_'.repeat(6);
            host.write(prompt + typedLine);
            // Mirrors the fixed rconSession.ts cursorColumn(): (promptWidth +
            // lineEditor.cursor) % terminalWidth — the column on the wrapped row.
            host.column = (prompt.length + typedLine.length) % 30;
            await host.flush();

            const combined = prompt + typedLine;
            // Sanity check: the line really did wrap onto row 2.
            assert.strictEqual(lineText(term, 1), combined.slice(0, 30));
            assert.strictEqual(lineText(term, 2), combined.slice(30));
            const buf = term.buffer.active;
            assert.strictEqual(buf.cursorY, 2, 'cursor sits on the wrapped (second) row of input');
            const wrappedCursorX = buf.cursorX;
            assert.strictEqual(wrappedCursorX, combined.length - 30, 'cursor column on the wrapped row');
            assert.strictEqual(host.column, wrappedCursorX, 'sanity check: the wrap-aware column matches the terminal\'s actual cursor column');

            display.render(['Player_One', 'Player_Two', 'Player_Three', 'Player_Four'], 0, 'tp <targets>', typedLine);
            await host.flush();

            // Right spot: the popup is drawn directly below the wrapped (second)
            // row of input, not below the first row or somewhere else.
            assert.ok(lineText(term, 3).includes('Player_One'), 'first suggestion is on the row right below the wrapped input line');
            assert.ok(lineText(term, 4).includes('Player_Two'));
            assert.ok(lineText(term, 5).includes('Player_Three'));
            assert.ok(lineText(term, 6).includes('Player_Four'));

            // Intact: 4 items + footer + usage line = 6 lines, no extras or omissions.
            assert.ok(lineText(term, 7).includes('[1/4] Page 1/1'), 'footer is the 5th suggestion-area line');
            assert.ok(lineText(term, 8).includes('/tp <targets>'), 'usage line is the 6th and last suggestion-area line');
            assert.strictEqual(lineText(term, 9), '', 'nothing drawn past the 6 expected lines');

            // Cursor restoration: back on the wrapped row, at the column where
            // the typed text actually ends.
            assert.strictEqual(buf.cursorY, 2, 'cursor is restored to the wrapped (second) row of input');
            assert.strictEqual(buf.cursorX, wrappedCursorX, 'and to the column where the typed text actually ends');
        } finally {
            term.dispose();
        }
    });
});
