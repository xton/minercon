// src/test/displaySuggestion.test.ts
//
// Tests for SuggestionDisplay's rendering/layout: the suggestion-list ANSI
// output (selection highlighting, pagination indicators, footer), the
// argument-hint line (bolded current argument), the combined frame when both
// are shown together, and the clear/redraw bookkeeping (`displayLines`,
// `needsClearOnNextRender`, cursor-column restoration).

import * as assert from 'assert';
import { SuggestionDisplay, SuggestionDisplayHost } from '../displaySuggestion';

class FakeHost implements SuggestionDisplayHost {
    writes: string[] = [];
    column = 0;

    write(text: string): void { this.writes.push(text); }
    cursorColumn(): number { return this.column; }
    output(): string { return this.writes.join(''); }
}

function setup(): { display: SuggestionDisplay; host: FakeHost } {
    const host = new FakeHost();
    const display = new SuggestionDisplay(host);
    return { display, host };
}

suite('SuggestionDisplay: suggestion list rendering', () => {
    test('renders each item, highlighting the selected one and showing a footer with position/page', () => {
        const { display, host } = setup();
        display.render(['survival', 'creative', 'adventure', 'spectator'], 0, null, '/gamemode ');

        const out = host.output();
        assert.ok(out.includes('\x1b[93m→ survival\x1b[0m'), 'selected item is highlighted with the arrow');
        assert.ok(out.includes('\x1b[90m  creative\x1b[0m'), 'unselected items are gray with leading spaces');
        assert.ok(out.includes('\x1b[90m  adventure\x1b[0m'));
        assert.ok(out.includes('\x1b[90m  spectator\x1b[0m'));
        assert.ok(out.includes('[1/4] Page 1/1'), 'footer shows position and page');
        assert.strictEqual(display.isShowing, true);
        assert.strictEqual(display.itemCount, 4);
    });

    test('the completed portion of the line is rendered as a concealed prefix on each line', () => {
        const { display, host } = setup();
        display.render(['survival', 'creative'], 0, null, '/gamemode ');

        const out = host.output();
        assert.ok(out.includes('\x1b[8m/gamemode \x1b[0m\x1b[93m→ survival\x1b[0m'));
        assert.ok(out.includes('\x1b[8m/gamemode \x1b[0m\x1b[90m  creative\x1b[0m'));
    });

    test('no concealed prefix is added while still typing the command name (no space yet)', () => {
        const { display, host } = setup();
        display.render(['gamemode', 'gamerule'], 0, null, '/game');

        const out = host.output();
        assert.ok(out.includes('\x1b[93m→ gamemode\x1b[0m'));
        assert.ok(!out.includes('\x1b[8m'), 'no concealed prefix when there is no completed prefix to hide');
    });

    test('rendering with no items and no usage writes nothing', () => {
        const { display, host } = setup();
        display.render([], -1, null, '');

        assert.strictEqual(host.output(), '');
        assert.strictEqual(display.isShowing, false);
        assert.strictEqual(display.itemCount, 0);
    });
});

suite('SuggestionDisplay: pagination', () => {
    const items = Array.from({ length: 15 }, (_, i) => `item${i}`);

    test('shows a "more below" indicator when later items are off-screen', () => {
        const { display, host } = setup();
        display.render(items, 0, null, '/foo ');

        const out = host.output();
        assert.ok(out.includes('▼ (5 more below)'));
        assert.ok(!out.includes('more above'));
        assert.ok(out.includes('[1/15] Page 1/2'));
    });

    test('scrolling to a later item shows a "more above" indicator and updates the page', () => {
        const { display, host } = setup();
        display.render(items, 12, null, '/foo ');

        const out = host.output();
        assert.ok(out.includes('▲ (5 more above)'));
        assert.ok(!out.includes('more below'));
        assert.ok(out.includes('[13/15] Page 2/2'));
    });

    test('nextPageIndex/previousPageIndex return null when everything fits on one page', () => {
        const { display } = setup();
        display.render(['a', 'b', 'c'], 0, null, '/foo ');

        assert.strictEqual(display.nextPageIndex(), null);
        assert.strictEqual(display.previousPageIndex(), null);
    });

    test('nextPageIndex/previousPageIndex wrap around across pages', () => {
        const { display } = setup();

        display.render(items, 0, null, '/foo '); // page 1 of 2
        assert.strictEqual(display.nextPageIndex(), 10);
        assert.strictEqual(display.previousPageIndex(), 10, 'going back from page 1 wraps to the last page');

        display.render(items, 12, null, '/foo '); // page 2 of 2
        assert.strictEqual(display.nextPageIndex(), 0, 'going forward from the last page wraps to the first');
        assert.strictEqual(display.previousPageIndex(), 0);
    });

    test('nextPageIndex/previousPageIndex return null when nothing is showing', () => {
        const { display } = setup();
        assert.strictEqual(display.nextPageIndex(), null);
        assert.strictEqual(display.previousPageIndex(), null);
    });
});

suite('SuggestionDisplay: argument hint', () => {
    test('renders the usage line with the current argument bolded and others gray', () => {
        const { display, host } = setup();
        display.render([], -1, 'gamemode <mode> <target>', '/gamemode survival ');

        const out = host.output();
        assert.ok(out.includes('\x1b[90m/gamemode\x1b[0m'), 'command prefix is gray');
        assert.ok(out.includes('\x1b[90m<mode>\x1b[0m'), 'earlier argument is gray');
        assert.ok(out.includes('\x1b[1;97m<target>\x1b[0m'), 'current argument is bold white');
        assert.strictEqual(display.isShowing, false, 'an empty suggestion list is not "showing"');
    });

    test('renders the suggestion list and the argument hint together when both apply', () => {
        const { display, host } = setup();
        display.render(['survival', 'creative'], 0, 'gamemode <mode>', '/gamemode ');

        const out = host.output();
        assert.ok(out.includes('\x1b[93m→ survival\x1b[0m'));
        assert.ok(out.includes('Page 1/1'));
        assert.ok(out.includes('\x1b[1;97m<mode>\x1b[0m'), 'the only argument is the current one');
        assert.strictEqual(display.isShowing, true);
    });

    test('an empty usage string renders no argument hint', () => {
        const { display, host } = setup();
        display.render(['survival'], 0, '', '/gamemode ');

        const out = host.output();
        assert.ok(!out.includes('\x1b[1;97m'));
        assert.ok(!out.includes('\x1b[90m/gamemode\x1b[0m'));
    });
});

suite('SuggestionDisplay: clear/redraw bookkeeping', () => {
    test('clear erases the previously drawn lines and restores the cursor column', () => {
        const { display, host } = setup();
        host.column = 5;
        display.render(['a', 'b'], 0, null, '/foo ');
        host.writes.length = 0;

        display.clear();

        const out = host.output();
        assert.ok(out.startsWith('\r\n'));
        assert.strictEqual((out.match(/\x1b\[2K/g) || []).length, 3, 'clears 2 items + footer = 3 lines');
        assert.ok(out.includes('\x1b[3A'), 'moves back up by the number of cleared lines');
        assert.ok(out.includes('\x1b[5C'), 'restores the cursor to its saved column');
    });

    test('clear is a no-op when nothing has been drawn yet', () => {
        const { display, host } = setup();
        display.clear();
        assert.strictEqual(host.output(), '');
    });

    test('clear does not move the cursor horizontally when cursorColumn is 0', () => {
        const { display, host } = setup();
        host.column = 0;
        display.render(['a'], 0, null, '/foo ');
        host.writes.length = 0;

        display.clear();

        assert.ok(!host.output().includes('C'), 'no "...C" cursor-forward escape when column is 0');
    });

    test('hide clears the display and resets selection/paging state', () => {
        const { display, host } = setup();
        display.render(['a', 'b', 'c'], 1, null, '/foo ');
        assert.strictEqual(display.isShowing, true);
        host.writes.length = 0;

        display.hide();

        assert.strictEqual(display.isShowing, false);
        assert.strictEqual(display.itemCount, 0);
        assert.ok(host.output().includes('\x1b[2K'), 'the previous frame is cleared');
    });

    test('markNeedsClearOnNextRender causes the next render to clear from cursor to end of screen first, once', () => {
        const { display, host } = setup();
        display.markNeedsClearOnNextRender();
        display.render(['a'], 0, null, '/foo ');
        assert.ok(host.output().startsWith('\x1b[J'), 'first render after marking clears to end of screen');

        host.writes.length = 0;
        display.render(['a'], 0, null, '/foo ');
        assert.ok(!host.output().includes('\x1b[J'), 'the flag is consumed after one render');
    });
});
