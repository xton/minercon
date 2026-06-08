import * as assert from 'assert';
import {
    ParameterType,
    Parameter,
    formatMinecraftColors,
    stripColors,
    tokenizeParameterString,
    parseParameter,
    parseCommandHelp,
} from '../helpTextParsing';

suite('helpTextParsing', () => {
    test('formatMinecraftColors inserts ANSI codes and ends with reset', () => {
        const out = formatMinecraftColors('Hello §cWorld');
        assert.ok(out.includes('\x1b[91m'));
        assert.ok(out.endsWith('\x1b[0m'));
    });

    test('stripColors removes color codes', () => {
        const stripped = stripColors('§aHello §cWorld');
        assert.strictEqual(stripped, 'Hello World');
    });

    test('tokenizeParameterString handles nested tokens', () => {
        const input = '<arg1> [opt] (a|b) subcmd <nested>';
        const tokens = tokenizeParameterString(input);
        assert.deepStrictEqual(tokens, ['<arg1>', '[opt]', '(a|b)', 'subcmd', '<nested>']);
    });

    test('parseParameter parses choice lists and arguments', () => {
        const choice = parseParameter('(one|two)', 0) as Parameter;
        assert.strictEqual(choice.type, ParameterType.CHOICE_LIST);
        assert.strictEqual(choice.choices!.length, 2);
        assert.strictEqual(choice.choices![0].literal, 'one');

        const arg = parseParameter('<name>', 1) as Parameter;
        assert.strictEqual(arg.type, ParameterType.ARGUMENT);
        assert.strictEqual(arg.name, 'name');
        assert.strictEqual(arg.optional, false);
    });

    test('parseCommandHelp extracts parameters in order', () => {
        const help = '/foo <bar> [baz] (a|b) sub';
        const params = parseCommandHelp(help);
        // Expect: <bar> ARGUMENT, [baz] optional LITERAL, (a|b) CHOICE_LIST, sub LITERAL
        assert.strictEqual(params.length, 4);
        assert.strictEqual(params[0].type, ParameterType.ARGUMENT);
        assert.strictEqual(params[0].name, 'bar');
        // In this implementation, [baz] without inner angle brackets is treated as a literal (optional)
        assert.strictEqual(params[1].type, ParameterType.LITERAL);
        assert.strictEqual(params[1].literal, 'baz');
        assert.strictEqual(params[1].optional, true);
        assert.strictEqual(params[2].type, ParameterType.CHOICE_LIST);
        assert.strictEqual(params[3].type, ParameterType.LITERAL);
    });

    test('parse /fill syntax', () => {
        const params = parseCommandHelp('/fill <from> <to> <block> [outline|hollow|destroy|strict|replace|keep]');
        assert.strictEqual(params.length, 4);
        assert.strictEqual(params[0].type, ParameterType.ARGUMENT);
        assert.strictEqual(params[0].name, 'from');
        assert.strictEqual(params[1].type, ParameterType.ARGUMENT);
        assert.strictEqual(params[1].name, 'to');
        assert.strictEqual(params[2].type, ParameterType.ARGUMENT);
        assert.strictEqual(params[2].name, 'block');
        // Optional bracketed token with pipes is treated as a single LITERAL (implementation detail)
        assert.strictEqual(params[3].type, ParameterType.LITERAL);
        assert.strictEqual(params[3].optional, true);
        assert.ok(params[3].literal!.includes('outline'));
    });

    test('parse /rotate syntax with choices', () => {
        const params = parseCommandHelp('/rotate <target> (<rotation>|facing)');
        assert.strictEqual(params.length, 2);
        assert.strictEqual(params[0].type, ParameterType.ARGUMENT);
        assert.strictEqual(params[0].name, 'target');
        assert.strictEqual(params[1].type, ParameterType.CHOICE_LIST);
        const choices = params[1].choices!;
        assert.strictEqual(choices.length, 2);
        assert.strictEqual(choices[0].literal, '<rotation>');
        assert.strictEqual(choices[1].literal, 'facing');
    });

    test('parse /teleport choice list', () => {
        const params = parseCommandHelp('/teleport (<location>|<destination>|<targets>)');
        assert.strictEqual(params.length, 1);
        assert.strictEqual(params[0].type, ParameterType.CHOICE_LIST);
        const lits = params[0].choices!.map(c => c.literal);
        assert.deepStrictEqual(lits, ['<location>', '<destination>', '<targets>']);
    });

    test('parse /stopsound with optional types', () => {
        const params = parseCommandHelp('/stopsound <targets> [*|master|music|record|weather|block|hostile|neutral|player|ambient|voice|ui]');
        assert.strictEqual(params.length, 2);
        assert.strictEqual(params[0].type, ParameterType.ARGUMENT);
        assert.strictEqual(params[0].name, 'targets');
        // Treated as optional literal list token
        assert.strictEqual(params[1].type, ParameterType.LITERAL);
        assert.strictEqual(params[1].optional, true);
        assert.ok(params[1].literal!.includes('master'));
        assert.ok(params[1].literal!.includes('*'));
    });

    test('parse mvp modify/create/list variants', () => {
        let params = parseCommandHelp('mvp modify [portal] <property> <value>');
        assert.strictEqual(params.length, 4);
        assert.strictEqual(params[0].type, ParameterType.LITERAL);
        assert.strictEqual(params[0].literal, 'modify');
        assert.strictEqual(params[1].type, ParameterType.LITERAL);
        assert.strictEqual(params[1].literal, 'portal');
        assert.strictEqual(params[2].type, ParameterType.ARGUMENT);
        assert.strictEqual(params[2].name, 'property');
        assert.strictEqual(params[3].type, ParameterType.ARGUMENT);
        assert.strictEqual(params[3].name, 'value');

        params = parseCommandHelp('mvp create <portal-name> [destination]');
        assert.strictEqual(params.length, 3);
        assert.strictEqual(params[0].literal, 'create');
        assert.strictEqual(params[1].type, ParameterType.ARGUMENT);
        assert.strictEqual(params[1].name, 'portal-name');
        assert.strictEqual(params[2].type, ParameterType.LITERAL);

        params = parseCommandHelp('mvp list [filter/world] [page]');
        assert.strictEqual(params.length, 3);
        assert.strictEqual(params[0].literal, 'list');
        assert.strictEqual(params[1].optional, true);
        assert.strictEqual(params[2].optional, true);
    });

    test('parse mvinv add-shares and bulkedit', () => {
        let params = parseCommandHelp('mvinv add-shares <group> <share[,extra]>');
        assert.strictEqual(params.length, 3);
        assert.strictEqual(params[0].literal, 'add-shares');
        assert.strictEqual(params[1].type, ParameterType.ARGUMENT);
        assert.strictEqual(params[2].type, ParameterType.ARGUMENT);
        assert.strictEqual(params[2].name, 'share[,extra]');

        params = parseCommandHelp('mvinv bulkedit playerprofile delete <sharable> <players> <groups/worlds> [profile-type] [--include-groups-worlds]');
        // Ensure the command path tokens are present and there are sufficient parameters
        assert.ok(params.length >= 6);
        assert.strictEqual(params[0].literal, 'bulkedit');
        assert.strictEqual(params[1].literal, 'playerprofile');
        assert.strictEqual(params[2].literal, 'delete');
        // Optional flag should appear as an optional literal
        assert.ok(params.some(p => p.optional && p.literal && p.literal.includes('--include-groups-worlds')));
    });
});
