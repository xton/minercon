import * as assert from 'assert';
import { LineEditor, LineEditorHost } from '../lineEditor';

class FakeHost implements LineEditorHost {
    prompt = '> ';
    writes: string[] = [];
    lineChanges: string[] = [];
    beforeClearedCount = 0;
    private outputArtifactsPending = false;

    write(text: string): void { this.writes.push(text); }
    promptText(): string { return this.prompt; }
    onLineChanged(line: string): void { this.lineChanges.push(line); }
    beforeLineCleared(): void { this.beforeClearedCount++; }
    consumeOutputArtifacts(): boolean {
        const pending = this.outputArtifactsPending;
        this.outputArtifactsPending = false;
        return pending;
    }
    queueOutputArtifacts(): void { this.outputArtifactsPending = true; }
}

function setup(initial = ''): { editor: LineEditor; host: FakeHost } {
    const host = new FakeHost();
    const editor = new LineEditor(host);
    if (initial) {
        editor.insertText(initial);
        host.writes.length = 0;
        host.lineChanges.length = 0;
    }
    return { editor, host };
}

/** Moves the cursor to `position` via plain (non-selecting) moves from the end of the line. */
function placeCursor(editor: LineEditor, position: number): void {
    editor.moveToEnd();
    while (editor.cursor > position) {
        editor.moveLeft();
    }
}

suite('LineEditor: editing', () => {
    test('insertText appends to an empty line, advances the cursor, and notifies the host', () => {
        const { editor, host } = setup();
        editor.insertText('hello');
        assert.strictEqual(editor.line, 'hello');
        assert.strictEqual(editor.cursor, 5);
        assert.deepStrictEqual(host.lineChanges, ['hello']);
    });

    test('insertText splices into the middle of the line at the cursor', () => {
        const { editor } = setup('helo');
        placeCursor(editor, 2);
        editor.insertText('l');
        assert.strictEqual(editor.line, 'hello');
        assert.strictEqual(editor.cursor, 3);
    });

    test('insertText strips control characters before inserting', () => {
        const { editor } = setup();
        editor.insertText('a\x01b\nc\x7fd');
        assert.strictEqual(editor.line, 'abcd');
    });

    test('insertText replaces an active selection', () => {
        const { editor } = setup('hello world');
        editor.moveToStart();
        editor.selectWordRight(); // selects "hello"
        editor.insertText('goodbye');
        assert.strictEqual(editor.line, 'goodbye world');
        assert.strictEqual(editor.hasSelection(), false);
    });

    test('insertText repaints the prompt and line-so-far first when stale output artifacts are pending', () => {
        const { editor, host } = setup('hello');
        placeCursor(editor, 3);
        host.queueOutputArtifacts();
        host.writes.length = 0;

        editor.insertText('X');

        assert.strictEqual(editor.line, 'helXlo');
        assert.deepStrictEqual(host.writes.slice(0, 4), ['\x1b[2K', '\r', '> ', 'hel']);
    });

    test('handleBackspace removes the character before the cursor', () => {
        const { editor, host } = setup('hello');
        editor.handleBackspace();
        assert.strictEqual(editor.line, 'hell');
        assert.strictEqual(editor.cursor, 4);
        assert.deepStrictEqual(host.lineChanges, ['hell']);
    });

    test('handleBackspace at the start of the line does nothing', () => {
        const { editor } = setup('hello');
        editor.moveToStart();
        editor.handleBackspace();
        assert.strictEqual(editor.line, 'hello');
        assert.strictEqual(editor.cursor, 0);
    });

    test('handleBackspace with an active selection deletes the selection instead', () => {
        const { editor } = setup('hello world');
        editor.moveToStart();
        editor.selectWordRight();
        editor.handleBackspace();
        assert.strictEqual(editor.line, ' world');
        assert.strictEqual(editor.hasSelection(), false);
    });

    test('deleteForward removes the character at the cursor', () => {
        const { editor } = setup('hello');
        editor.moveToStart();
        editor.deleteForward();
        assert.strictEqual(editor.line, 'ello');
        assert.strictEqual(editor.cursor, 0);
    });

    test('deleteForward at the end of the line does nothing', () => {
        const { editor } = setup('hello');
        editor.deleteForward();
        assert.strictEqual(editor.line, 'hello');
    });

    test('deleteForward with an active selection deletes the selection instead', () => {
        const { editor } = setup('hello world');
        editor.moveToStart();
        editor.selectWordRight();
        editor.deleteForward();
        assert.strictEqual(editor.line, ' world');
    });
});

suite('LineEditor: cursor movement', () => {
    test('moveLeft/moveRight step the cursor by one and clamp at the line boundaries', () => {
        const { editor } = setup('abc');
        editor.moveToStart();
        editor.moveLeft(); // already at the start
        assert.strictEqual(editor.cursor, 0);

        editor.moveRight();
        editor.moveRight();
        editor.moveRight();
        assert.strictEqual(editor.cursor, 3);
        editor.moveRight(); // already at the end
        assert.strictEqual(editor.cursor, 3);
    });

    test('moveLeft/moveRight collapse an active selection (and still move)', () => {
        const { editor } = setup('hello world');
        editor.moveToStart();
        editor.selectWordRight(); // cursor at 5, selection [0,5)
        editor.moveLeft();
        assert.strictEqual(editor.hasSelection(), false);
        assert.strictEqual(editor.cursor, 4);
    });

    test('moveWordLeft/moveWordRight find word boundaries, skipping runs of whitespace', () => {
        const { editor } = setup('foo  bar');
        editor.moveToEnd(); // cursor at 8

        editor.moveWordLeft();
        assert.strictEqual(editor.cursor, 5); // start of "bar"
        editor.moveWordLeft();
        assert.strictEqual(editor.cursor, 0); // start of "foo"
        editor.moveWordLeft(); // already at the start
        assert.strictEqual(editor.cursor, 0);

        // moving right alternates landing at the end of a word, then the start of the next
        editor.moveWordRight();
        assert.strictEqual(editor.cursor, 3); // end of "foo"
        editor.moveWordRight();
        assert.strictEqual(editor.cursor, 5); // start of "bar"
        editor.moveWordRight();
        assert.strictEqual(editor.cursor, 8); // end of line
        editor.moveWordRight(); // already at the end
        assert.strictEqual(editor.cursor, 8);
    });

    test('moveToStart/moveToEnd jump to the line boundaries and clear any selection', () => {
        const { editor } = setup('hello world');
        editor.moveToStart();
        editor.selectRight();
        editor.selectRight();
        assert.ok(editor.hasSelection());

        editor.moveToEnd();
        assert.strictEqual(editor.cursor, 11);
        assert.strictEqual(editor.hasSelection(), false);

        editor.moveToStart();
        assert.strictEqual(editor.cursor, 0);
    });
});

suite('LineEditor: selection', () => {
    test('selectLeft/selectRight grow a selection one character at a time', () => {
        const { editor } = setup('hello');
        editor.moveToStart();

        editor.selectRight();
        assert.strictEqual(editor.getSelectedText(), 'h');

        editor.selectRight();
        editor.selectRight();
        assert.strictEqual(editor.getSelectedText(), 'hel');
        assert.strictEqual(editor.cursor, 3);

        editor.selectLeft();
        assert.strictEqual(editor.getSelectedText(), 'he');
        assert.strictEqual(editor.cursor, 2);
    });

    test('selectLeft/selectRight do nothing at the line boundaries', () => {
        const { editor } = setup('hi');
        editor.moveToStart();
        editor.selectLeft();
        assert.strictEqual(editor.hasSelection(), false);

        editor.moveToEnd();
        editor.selectRight();
        assert.strictEqual(editor.hasSelection(), false);
    });

    test('selectWordLeft/selectWordRight extend the selection word by word', () => {
        const { editor } = setup('hello world');
        editor.moveToStart();

        editor.selectWordRight();
        assert.strictEqual(editor.getSelectedText(), 'hello');
        editor.selectWordRight();
        assert.strictEqual(editor.getSelectedText(), 'hello ');
        editor.selectWordRight();
        assert.strictEqual(editor.getSelectedText(), 'hello world');
        assert.strictEqual(editor.cursor, 11);

        editor.selectWordLeft();
        assert.strictEqual(editor.getSelectedText(), 'hello ');
    });

    test('selectToEnd extends the selection from the cursor to the end of the line', () => {
        const { editor } = setup('hello world');
        editor.moveToStart();
        editor.moveRight();
        editor.moveRight();
        // cursor at 2

        editor.selectToEnd();
        assert.strictEqual(editor.getSelectedText(), 'llo world');
        assert.strictEqual(editor.cursor, 11);
    });

    test('selectToStart extends the selection from the cursor to the start of the line', () => {
        const { editor } = setup('hello world');
        placeCursor(editor, 3);

        editor.selectToStart();
        assert.strictEqual(editor.getSelectedText(), 'hel');
        assert.strictEqual(editor.cursor, 0);
    });

    test('deleteSelection removes the selected text and collapses the cursor to its start', () => {
        const { editor } = setup('hello world');
        editor.moveToStart();
        editor.selectWordRight();
        editor.deleteSelection();
        assert.strictEqual(editor.line, ' world');
        assert.strictEqual(editor.cursor, 0);
        assert.strictEqual(editor.hasSelection(), false);
    });

    test('getSelectedText is empty when there is no selection', () => {
        const { editor } = setup('hello');
        assert.strictEqual(editor.getSelectedText(), '');
    });
});

suite('LineEditor: kill operations', () => {
    test('killToStart removes everything from the start of the line to the cursor', () => {
        const { editor } = setup('hello world');
        placeCursor(editor, 6); // just after "hello "
        editor.killToStart();
        assert.strictEqual(editor.line, 'world');
        assert.strictEqual(editor.cursor, 0);
    });

    test('killToStart at the start of the line does nothing', () => {
        const { editor } = setup('hello');
        editor.moveToStart();
        editor.killToStart();
        assert.strictEqual(editor.line, 'hello');
    });

    test('killToEnd removes everything from the cursor to the end of the line', () => {
        const { editor } = setup('hello world');
        placeCursor(editor, 5);
        editor.killToEnd();
        assert.strictEqual(editor.line, 'hello');
        assert.strictEqual(editor.cursor, 5);
    });

    test('killToEnd at the end of the line does nothing', () => {
        const { editor } = setup('hello');
        editor.killToEnd();
        assert.strictEqual(editor.line, 'hello');
    });

    test('killWordBack removes the word (and any separating space) behind the cursor', () => {
        const { editor } = setup('foo bar baz');
        placeCursor(editor, 8); // just after "foo bar "
        editor.killWordBack();
        assert.strictEqual(editor.line, 'foo baz');
        assert.strictEqual(editor.cursor, 4);
    });

    test('killWordForward removes from the cursor to the end of the word ahead, leaving the cursor put', () => {
        const { editor } = setup('foo bar baz');
        placeCursor(editor, 4); // start of "bar"
        editor.killWordForward();
        assert.strictEqual(editor.line, 'foo  baz');
        assert.strictEqual(editor.cursor, 4);
    });
});

suite('LineEditor: transposeChars', () => {
    test('swaps the character before the cursor with the one at the cursor', () => {
        const { editor } = setup('abcd');
        placeCursor(editor, 2); // between 'b' and 'c'
        editor.transposeChars();
        assert.strictEqual(editor.line, 'acbd');
        assert.strictEqual(editor.cursor, 3);
    });

    test('at the end of the line, swaps the last two characters', () => {
        const { editor } = setup('abc');
        // cursor already at the end
        editor.transposeChars();
        assert.strictEqual(editor.line, 'acb');
    });

    test('does nothing on a one-character line', () => {
        const { editor } = setup('a');
        editor.transposeChars();
        assert.strictEqual(editor.line, 'a');
    });

    test('does nothing at the start of the line', () => {
        const { editor } = setup('abc');
        editor.moveToStart();
        editor.transposeChars();
        assert.strictEqual(editor.line, 'abc');
    });
});

suite('LineEditor: history navigation', () => {
    test('pushHistory records commands and skips consecutive duplicates; navigateHistory walks backward through them', () => {
        const { editor } = setup();
        editor.pushHistory('first');
        editor.pushHistory('second');
        editor.pushHistory('second'); // duplicate of the last entry — skipped
        editor.pushHistory('first');  // not consecutive — recorded again

        editor.navigateHistory('up');
        assert.strictEqual(editor.line, 'first');
        editor.navigateHistory('up');
        assert.strictEqual(editor.line, 'second');
        editor.navigateHistory('up');
        assert.strictEqual(editor.line, 'first');
        editor.navigateHistory('up'); // already at the oldest entry — stays put
        assert.strictEqual(editor.line, 'first');
    });

    test('pushHistory caps the history at 100 entries, dropping the oldest first', () => {
        const { editor } = setup();
        for (let i = 0; i < 105; i++) {
            editor.pushHistory(`cmd${i}`);
        }

        editor.navigateHistory('up');
        assert.strictEqual(editor.line, 'cmd104'); // most recent

        for (let i = 0; i < 99; i++) {
            editor.navigateHistory('up');
        }
        assert.strictEqual(editor.line, 'cmd5'); // oldest surviving entry — cmd0..cmd4 were dropped

        editor.navigateHistory('up'); // can't go back further
        assert.strictEqual(editor.line, 'cmd5');
    });

    test('navigating down past the most recent entry restores the line that was being typed', () => {
        const { editor } = setup();
        editor.pushHistory('first');
        editor.pushHistory('second');

        editor.insertText('typing...');
        editor.navigateHistory('up');
        assert.strictEqual(editor.line, 'second');

        editor.navigateHistory('down');
        assert.strictEqual(editor.line, 'typing...');
    });

    test('resetHistoryCursor returns navigation to the most recent entry', () => {
        const { editor } = setup();
        editor.pushHistory('first');
        editor.pushHistory('second');

        editor.navigateHistory('up');
        editor.navigateHistory('up');
        assert.strictEqual(editor.line, 'first');

        editor.resetHistoryCursor();
        editor.navigateHistory('up');
        assert.strictEqual(editor.line, 'second'); // starts over from the most recent entry
    });
});

suite('LineEditor: whole-line operations', () => {
    test('resetLine clears the line/cursor/selection without writing or notifying the host', () => {
        const { editor, host } = setup('hello');
        editor.selectLeft();
        const writesBefore = host.writes.length;

        editor.resetLine();

        assert.strictEqual(editor.line, '');
        assert.strictEqual(editor.cursor, 0);
        assert.strictEqual(editor.hasSelection(), false);
        assert.strictEqual(host.writes.length, writesBefore);
    });

    test('clearAndReset notifies the host before clearing and announces the now-empty line', () => {
        const { editor, host } = setup('hello');
        editor.clearAndReset();

        assert.strictEqual(editor.line, '');
        assert.strictEqual(host.beforeClearedCount, 1);
        assert.strictEqual(host.lineChanges[host.lineChanges.length - 1], '');
    });

    test('replaceLine swaps in new text, moves the cursor to its end, and clears any selection', () => {
        const { editor } = setup('hello');
        editor.moveToStart();
        editor.selectRight();

        editor.replaceLine('goodbye world');

        assert.strictEqual(editor.line, 'goodbye world');
        assert.strictEqual(editor.cursor, 13);
        assert.strictEqual(editor.hasSelection(), false);
    });
});
