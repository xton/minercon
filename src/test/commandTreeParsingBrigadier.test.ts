import * as assert from 'assert';
import { stripColors } from '../ansi';
import { ParameterType, Parameter } from '../commandTree';
import {
    tokenizeParameterString,
    parseParameter,
    classifyParameterTokens,
    buildParameterStructureFromVariants,
    parseHelpLines,
    parseAliasRedirect,
    parseHelpResponse,
    hasRealUsage,
    isGenericArgsPlaceholder,
    hasUsableArguments,
    isUnsupportedNamespaceError,
    splitConcatenatedHelpLines,
    VariantInfo,
} from '../commandTreeParsingBrigadier';

/** Asserts `p` is the given variant and returns it narrowed to that variant's fields. */
function expectType<T extends ParameterType>(p: Parameter, type: T): Extract<Parameter, { type: T }> {
    assert.strictEqual(p.type, type);
    return p as Extract<Parameter, { type: T }>;
}

suite('commandTreeParsingBrigadier', () => {
    test('tokenizeParameterString handles nested tokens', () => {
        const input = '<arg1> [opt] (a|b) subcmd <nested>';
        const tokens = tokenizeParameterString(input);
        assert.deepStrictEqual(tokens, ['<arg1>', '[opt]', '(a|b)', 'subcmd', '<nested>']);
    });

    test('parseParameter parses choice lists and arguments', () => {
        const choice = parseParameter('(one|two)', 0) as Parameter;
        assert.strictEqual(choice.type, ParameterType.CHOICE_LIST);
        assert.strictEqual(choice.choices!.length, 2);
        assert.strictEqual(expectType(choice.choices![0], ParameterType.LITERAL).literal, 'one');

        const arg = parseParameter('<name>', 1) as Parameter;
        assert.strictEqual(arg.type, ParameterType.ARGUMENT);
        assert.strictEqual(arg.name, 'name');
        assert.strictEqual(arg.optional, false);
    });

    test('parseParameter: a plain word is a required LITERAL', () => {
        assert.deepStrictEqual(parseParameter('confirm', 2), {
            type: ParameterType.LITERAL, literal: 'confirm', optional: false, position: 2,
        });
    });

    test('parseParameter: [word] without inner <> is an optional LITERAL, brackets stripped', () => {
        assert.deepStrictEqual(parseParameter('[baz]', 1), {
            type: ParameterType.LITERAL, literal: 'baz', optional: true, position: 1,
        });
    });

    test('parseParameter: an optional bracketed pipe-list (e.g. /fill, /stopsound) stays one optional LITERAL', () => {
        // Brigadier renders enum-style optional args as [a|b|c]; we keep the
        // whole thing as a single literal token rather than splitting on |.
        const p = expectType(parseParameter('[*|master|music|ambient]', 3), ParameterType.LITERAL);
        assert.strictEqual(p.optional, true);
        assert.strictEqual(p.literal, '*|master|music|ambient');
    });

    test('parseParameter: a (...) choice list preserves <arg> tokens as literal choice text', () => {
        const p = expectType(parseParameter('(<rotation>|facing)', 1), ParameterType.CHOICE_LIST);
        assert.deepStrictEqual(
            p.choices.map(c => expectType(c, ParameterType.LITERAL).literal),
            ['<rotation>', 'facing']
        );
    });

    test('parseParameter: an argument name may itself contain brackets (e.g. <share[,extra]>)', () => {
        const p = expectType(parseParameter('<share[,extra]>', 0), ParameterType.ARGUMENT);
        assert.strictEqual(p.name, 'share[,extra]');
    });

    test('tokenizeParameterString keeps bracketed groups whole, including inner spaces and pipes', () => {
        assert.deepStrictEqual(
            tokenizeParameterString('<targets> [*|master|music] [plugin name]'),
            ['<targets>', '[*|master|music]', '[plugin name]']
        );
    });
});

suite('classifyParameterTokens', () => {
    test('no tokens: returns null', () => {
        assert.strictEqual(classifyParameterTokens([]), null);
    });

    test('a leading <argument> token: direct parameters, parsed and indexed from 0', () => {
        const result = classifyParameterTokens(['<mode>', '<target>']);
        assert.deepStrictEqual(result, {
            kind: 'direct',
            parameters: [
                { type: ParameterType.ARGUMENT, name: 'mode', optional: false, position: 0 },
                { type: ParameterType.ARGUMENT, name: 'target', optional: false, position: 1 },
            ],
        });
    });

    test('a leading [<optional argument>] token: direct parameters', () => {
        const result = classifyParameterTokens(['[<target>]']);
        assert.deepStrictEqual(result, {
            kind: 'direct',
            parameters: [{ type: ParameterType.ARGUMENT, name: 'target', optional: true, position: 0 }],
        });
    });

    test('a leading (choice|list) token: direct parameters (a choice list)', () => {
        const result = classifyParameterTokens(['(a|b)', '<rest>']);
        assert.strictEqual(result?.kind, 'direct');
        assert.strictEqual(result!.parameters[0].type, ParameterType.CHOICE_LIST);
        assert.strictEqual(result!.parameters[1].type, ParameterType.ARGUMENT);
    });

    test('a leading bare-word token: a named variant, remaining tokens re-indexed from 0', () => {
        const result = classifyParameterTokens(['modify', '<property>', '<value>']);
        assert.deepStrictEqual(result, {
            kind: 'variant',
            name: 'modify',
            optional: false,
            parameters: [
                { type: ParameterType.ARGUMENT, name: 'property', optional: false, position: 0 },
                { type: ParameterType.ARGUMENT, name: 'value', optional: false, position: 1 },
            ],
        });
    });

    test('a leading [bracketed] token: a named variant with the brackets stripped from its name', () => {
        const result = classifyParameterTokens(['[reload]']);
        assert.deepStrictEqual(result, { kind: 'variant', name: 'reload', optional: true, parameters: [] });
    });
});

// Real responses captured from a live Paper 1.21.4 (no plugins) and a live
// Vanilla/Fabric 1.21.4 server, used throughout this suite and in
// commandTreeCrawler.test.ts. See docs/NO_PLUGIN_HELP_CRAWL.md.
suite('parseHelpLines', () => {
    test('vanilla "/help <cmd>" direct syntax (gamemode)', () => {
        const result = parseHelpLines('/gamemode <gamemode> [<target>]', 'gamemode');
        assert.strictEqual(result.variants.size, 0);
        assert.deepStrictEqual(result.direct, [
            { type: ParameterType.ARGUMENT, name: 'gamemode', optional: false, position: 0 },
            { type: ParameterType.ARGUMENT, name: 'target', optional: true, position: 1 },
        ]);
    });

    test('"minecraft:help <cmd>" multi-variant syntax (gamerule), one entry per line', () => {
        const text = '/gamerule announceAdvancements [<value>]\n/gamerule doDaylightCycle [<value>]\n/gamerule logAdminCommands [<value>]';
        const result = parseHelpLines(text, 'gamerule');
        assert.strictEqual(result.direct, null);
        assert.deepStrictEqual([...result.variants.keys()], ['announceAdvancements', 'doDaylightCycle', 'logAdminCommands']);
        assert.deepStrictEqual(result.variants.get('announceAdvancements'), {
            optional: false,
            members: [{ type: ParameterType.ARGUMENT, name: 'value', optional: true, position: 0 }],
        });
    });

    test('subcommand path "team list" matches "/team list [<team>]"', () => {
        const result = parseHelpLines('/team list [<team>]', 'team list');
        assert.strictEqual(result.variants.size, 0);
        assert.deepStrictEqual(result.direct, [
            { type: ParameterType.ARGUMENT, name: 'team', optional: true, position: 0 },
        ]);
    });

    test('the generic "[<args>]" placeholder parses as a single optional "args" argument', () => {
        const result = parseHelpLines('/version [<args>]', 'version');
        assert.strictEqual(result.variants.size, 0);
        assert.ok(isGenericArgsPlaceholder(result.direct!));
    });

    test('a normalized Bukkit usage line ("[plugin name]") becomes a variant', () => {
        const result = parseHelpLines('/version [plugin name]', 'version');
        assert.strictEqual(result.direct, null);
        assert.deepStrictEqual([...result.variants.keys()], ['plugin name']);
    });

    test('error responses and lines for other commands are ignored', () => {
        const result = parseHelpLines('Unknown command or insufficient permissions', 'version');
        assert.strictEqual(result.variants.size, 0);
        assert.strictEqual(result.direct, null);
    });

    test('a bare "Usage: <name>" line with nothing after the command name is ignored', () => {
        const result = parseHelpLines('gamemode', 'gamemode');
        assert.strictEqual(result.variants.size, 0);
        assert.strictEqual(result.direct, null);
    });

    test('alias redirects ("-> target") are ignored', () => {
        const result = parseHelpLines('/xp -> experience', 'xp');
        assert.strictEqual(result.variants.size, 0);
        assert.strictEqual(result.direct, null);
    });

    test('a concatenated "minecraft:help" blob requires the caller to split on "/" first', () => {
        // Real minecraft:help responses pack consecutive commands onto one
        // line with no separator; callers must replace('/', '\n/') before
        // calling parseHelpLines (see commandTreeCrawler.ts).
        const blob = '/team list [<team>]/team add <team> [<displayName>]';
        const split = blob.replace(/\//g, '\n/');
        const result = parseHelpLines(split, 'team');
        assert.deepStrictEqual([...result.variants.keys()], ['list', 'add']);
    });
});

suite('parseAliasRedirect', () => {
    test('parses a "/<alias> -> <target>" line', () => {
        assert.deepStrictEqual(parseAliasRedirect('/tp -> teleport'), { alias: 'tp', target: 'teleport' });
    });

    test('preserves a "minecraft:" namespace prefix on the alias side ("ingest everything")', () => {
        assert.deepStrictEqual(parseAliasRedirect('/minecraft:xp -> experience'), { alias: 'minecraft:xp', target: 'experience' });
    });

    test('returns null for an ordinary syntax line', () => {
        assert.strictEqual(parseAliasRedirect('/gamemode <gamemode> [<target>]'), null);
    });

    test('returns null for an unrelated line', () => {
        assert.strictEqual(parseAliasRedirect('Unknown command or insufficient permissions'), null);
    });
});

suite('isGenericArgsPlaceholder', () => {
    test('true for the generic optional "args" argument', () => {
        assert.ok(isGenericArgsPlaceholder([
            { type: ParameterType.ARGUMENT, name: 'args', optional: true, position: 0 },
        ]));
    });

    test('false for a real argument named "args" that is required', () => {
        assert.ok(!isGenericArgsPlaceholder([
            { type: ParameterType.ARGUMENT, name: 'args', optional: false, position: 0 },
        ]));
    });

    test('false for an empty parameter list or any other shape', () => {
        assert.ok(!isGenericArgsPlaceholder([]));
        assert.ok(!isGenericArgsPlaceholder([
            { type: ParameterType.ARGUMENT, name: 'gamemode', optional: false, position: 0 },
            { type: ParameterType.ARGUMENT, name: 'target', optional: true, position: 1 },
        ]));
    });
});

suite('hasUsableArguments', () => {
    test('true for a real parameter list', () => {
        assert.ok(hasUsableArguments([
            { type: ParameterType.ARGUMENT, name: 'value', optional: true, position: 0 },
        ]));
    });

    test('false for an empty parameter list', () => {
        assert.ok(!hasUsableArguments([]));
    });

    test('false for a bare "<args>"/"[<args>]" placeholder, optional or not', () => {
        assert.ok(!hasUsableArguments([
            { type: ParameterType.ARGUMENT, name: 'args', optional: true, position: 0 },
        ]));
        assert.ok(!hasUsableArguments([
            { type: ParameterType.ARGUMENT, name: 'args', optional: false, position: 0 },
        ]));
    });
});

suite('hasRealUsage', () => {
    test('true for a direct parameter list that is not the generic "[<args>]" placeholder', () => {
        assert.ok(hasRealUsage({
            direct: [{ type: ParameterType.ARGUMENT, name: 'gamemode', optional: false, position: 0 }],
            variants: new Map(),
        }));
    });

    test('false for the generic "[<args>]" placeholder with no variants', () => {
        assert.ok(!hasRealUsage({
            direct: [{ type: ParameterType.ARGUMENT, name: 'args', optional: true, position: 0 }],
            variants: new Map(),
        }));
    });

    test('true with no direct list but at least one subcommand variant', () => {
        assert.ok(hasRealUsage({
            direct: null,
            variants: new Map([['list', { optional: false, members: [] }]]),
        }));
    });

    test('false with neither a direct list nor variants', () => {
        assert.ok(!hasRealUsage({ direct: null, variants: new Map() }));
    });
});

suite('parseHelpResponse', () => {
    test('extracts root commands with full <args> syntax from a concatenated minecraft:help blob', () => {
        const blob = [
            '/gamemode <gamemode> [<target>]',
            '/gamerule announceAdvancements [<value>]',
            '/version [<args>]',
        ].join('');
        const { commands, aliases } = parseHelpResponse(blob);
        assert.deepStrictEqual(commands.map(c => c.name), ['gamemode', 'gamerule', 'version']);
        assert.deepStrictEqual(aliases, []);
    });

    test('isPlaceholder is false when the summary line carries real syntax, true for the generic "[<args>]" placeholder', () => {
        const blob = '/gamemode <gamemode> [<target>]/version [<args>]';
        const { commands } = parseHelpResponse(blob);
        assert.deepStrictEqual(commands.map(c => [c.name, c.isPlaceholder]), [
            ['gamemode', false],
            ['version', true],
        ]);
    });

    test('alias redirect lines are returned as aliases, not commands', () => {
        const text = '/tp -> teleport\n/minecraft:xp -> experience\n/gamemode <gamemode> [<target>]';
        const { commands, aliases } = parseHelpResponse(text);
        assert.deepStrictEqual(commands.map(c => c.name), ['gamemode']);
        assert.deepStrictEqual(aliases, [
            { alias: 'tp', target: 'teleport' },
            { alias: 'minecraft:xp', target: 'experience' },
        ]);
    });

    test('namespace prefixes are preserved as part of the command name ("ingest everything")', () => {
        const { commands } = parseHelpResponse('/minecraft:advancement (grant|revoke) <targets>');
        assert.deepStrictEqual(commands.map(c => c.name), ['minecraft:advancement']);
    });

    test('header/separator and blank lines are skipped', () => {
        const text = '§e--------- §fHelp: Index §e-----------------\n\n/gamemode <gamemode> [<target>]\n=== end ===';
        const { commands } = parseHelpResponse(text);
        assert.deepStrictEqual(commands.map(c => c.name), ['gamemode']);
    });

    test('lines starting with a non-command word like "Usage" are not treated as commands', () => {
        const { commands } = parseHelpResponse('Usage <foo>\n/gamemode <gamemode> [<target>]');
        assert.deepStrictEqual(commands.map(c => c.name), ['gamemode']);
    });
});

suite('isUnsupportedNamespaceError', () => {
    test('true for the Brigadier "unknown namespace" error from minecraft:help on vanilla/fabric', () => {
        assert.ok(isUnsupportedNamespaceError('Unknown or incomplete command, see below for errorminecraft:help<--[HERE]'));
    });

    test('false for the normal "unknown command" not-found message', () => {
        assert.ok(!isUnsupportedNamespaceError('Unknown command or insufficient permissions'));
    });

    test('false for a real help response', () => {
        assert.ok(!isUnsupportedNamespaceError('/gamemode <gamemode> [<target>]'));
    });
});

suite('splitConcatenatedHelpLines', () => {
    test('re-splits a concatenated Brigadier blob into one /cmd line each', () => {
        const blob = '/gamemode <gamemode> [<target>]/team list [<team>]/team add <team> [<displayName>]';
        assert.deepStrictEqual(
            splitConcatenatedHelpLines(blob).split('\n').filter(l => l.trim()),
            [
                '/gamemode <gamemode> [<target>]',
                '/team list [<team>]',
                '/team add <team> [<displayName>]',
            ]
        );
    });

    test('drops a "Help: /<cmd> ----" banner line instead of splitting it on "/"', () => {
        const helpText = '§e--------- §fHelp: /version §e------------------------\n'
            + '§f§6Usage: §f/version [plugin name]';
        const lines = splitConcatenatedHelpLines(helpText).split('\n').map(l => stripColors(l).trim()).filter(l => l);
        assert.deepStrictEqual(lines, ['Usage:', '/version [plugin name]']);
    });

    test('splits on EVERY "/", including inside a token - callers must not feed it "/"-bearing args', () => {
        // This is a deliberate limitation: the transform is content-blind, which
        // is necessary to split argless back-to-back vanilla commands ("/seed/setblock")
        // but means a "/" inside an argument token gets mis-split. It is only ever
        // run on vanilla minecraft:help blobs, whose args never contain "/".
        assert.deepStrictEqual(
            splitConcatenatedHelpLines('/warp <home/away>').split('\n').filter(l => l.trim()),
            ['/warp <home', '/away>']
        );
    });
});

suite('buildParameterStructureFromVariants', () => {
    test('no variants: returns an empty list', () => {
        assert.deepStrictEqual(buildParameterStructureFromVariants(new Map()), []);
    });

    test('a single variant: becomes one SUBCOMMAND parameter directly', () => {
        const members: Parameter[] = [{ type: ParameterType.ARGUMENT, name: 'player', optional: false, position: 0 }];
        const result = buildParameterStructureFromVariants(new Map([['add', { optional: false, members }]]));
        assert.deepStrictEqual(result, [{
            type: ParameterType.SUBCOMMAND,
            name: 'add',
            optional: false,
            position: 0,
            members,
            isComplete: false,
        }]);
    });

    test('multiple variants: wrapped in a CHOICE_LIST of SUBCOMMANDs in insertion order with sequential positions', () => {
        const variants = new Map<string, VariantInfo>([
            ['add', { optional: false, members: [] }],
            ['remove', { optional: false, members: [] }],
            ['list', { optional: false, members: [] }],
        ]);
        const result = buildParameterStructureFromVariants(variants);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].type, ParameterType.CHOICE_LIST);
        const choices = result[0].choices!;
        assert.deepStrictEqual(choices.map(c => [expectType(c, ParameterType.SUBCOMMAND).name, c.position]), [['add', 0], ['remove', 1], ['list', 2]]);
        assert.ok(choices.every(c => c.type === ParameterType.SUBCOMMAND && c.isComplete === false));
    });
});
