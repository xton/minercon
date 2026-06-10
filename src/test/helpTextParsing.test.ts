import * as assert from 'assert';
import {
    ParameterType,
    Parameter,
    formatMinecraftColors,
    stripColors,
    tokenizeParameterString,
    parseParameter,
    parseCommandHelp,
    classifyParameterTokens,
    buildParameterStructureFromVariants,
    parseHelpLines,
    isGenericArgsPlaceholder,
    isUnsupportedNamespaceError,
    extractBukkitUsageLines,
    looksLikeBukkitHelpPage,
    splitConcatenatedHelpLines,
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
            parameters: [
                { type: ParameterType.ARGUMENT, name: 'property', optional: false, position: 0 },
                { type: ParameterType.ARGUMENT, name: 'value', optional: false, position: 1 },
            ],
        });
    });

    test('a leading [bracketed] token: a named variant with the brackets stripped from its name', () => {
        const result = classifyParameterTokens(['[reload]']);
        assert.deepStrictEqual(result, { kind: 'variant', name: 'reload', parameters: [] });
    });
});

// Real responses captured from a live Paper 1.21.4 (no plugins) and a live
// Vanilla/Fabric 1.21.4 server, used throughout this suite and in
// commandAutocomplete.test.ts. See docs/technical/NO_PLUGIN_HELP_CRAWL.md.
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
        assert.deepStrictEqual(result.variants.get('announceAdvancements'), [
            { type: ParameterType.ARGUMENT, name: 'value', optional: true, position: 0 },
        ]);
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
        // calling parseHelpLines (see commandAutocomplete.ts).
        const blob = '/team list [<team>]/team add <team> [<displayName>]';
        const split = blob.replace(/\//g, '\n/');
        const result = parseHelpLines(split, 'team');
        assert.deepStrictEqual([...result.variants.keys()], ['list', 'add']);
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

suite('extractBukkitUsageLines', () => {
    test('extracts a real Bukkit-added command\'s usage line (version)', () => {
        const helpText = '§e--------- §fHelp: /version §e------------------------\n'
            + '§6Description: §fGets the version of this server including\n'
            + '§fany plugins in use\n'
            + '§f§6Usage: §f/version [plugin name]\n'
            + '§f§6Aliases: §fver, about';
        assert.deepStrictEqual(extractBukkitUsageLines(helpText, 'version'), ['/version [plugin name]']);
    });

    test('extracts a multi-token usage line (reload)', () => {
        const helpText = '§e--------- §fHelp: /reload §e-------------------------\n'
            + '§6Description: §fReloads the server configuration and\n'
            + '§fplugins\n'
            + '§f§6Usage: §f/reload [permissions|commands|confirm]\n'
            + '§f§6Aliases: §frl';
        assert.deepStrictEqual(extractBukkitUsageLines(helpText, 'reload'), ['/reload [permissions|commands|confirm]']);
    });

    test('returns [] for the generic vanilla-command response (gamemode)', () => {
        const helpText = '§e--------- §fHelp: /gamemode §e-----------------------\n'
            + '§6Description: §fA Mojang provided command.\n'
            + '§f§6Usage: §fgamemode';
        assert.deepStrictEqual(extractBukkitUsageLines(helpText, 'gamemode'), []);
    });

    test('returns [] for "No help for X" (no Usage line at all)', () => {
        assert.deepStrictEqual(extractBukkitUsageLines('§cNo help for team list', 'team list'), []);
    });

    test('returns [] for a bare command with no arguments (plugins)', () => {
        const helpText = '§e--------- §fHelp: /plugins §e------------------------\n'
            + '§6Description: §fGets a list of plugins running on the\n'
            + '§fserver\n'
            + '§f§6Usage: §f/plugins\n'
            + '§f§6Aliases: §fpl';
        assert.deepStrictEqual(extractBukkitUsageLines(helpText, 'plugins'), []);
    });
});

suite('looksLikeBukkitHelpPage', () => {
    test('true for a Bukkit help page (has a "---" banner line)', () => {
        const helpText = '§e--------- §fHelp: /version §e------------------------\n'
            + '§6Description: §fGets the version of this server including\n'
            + '§f§6Usage: §f/version [plugin name]';
        assert.ok(looksLikeBukkitHelpPage(helpText));
    });

    test('false for a flat concatenated Brigadier blob (no "---" line)', () => {
        assert.ok(!looksLikeBukkitHelpPage('/gamemode <gamemode> [<target>]/team list [<team>]'));
    });

    test('false for "No help for X"', () => {
        assert.ok(!looksLikeBukkitHelpPage('§cNo help for team list'));
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
});

suite('buildParameterStructureFromVariants', () => {
    test('no variants: returns an empty list', () => {
        assert.deepStrictEqual(buildParameterStructureFromVariants(new Map()), []);
    });

    test('a single variant: becomes one SUBCOMMAND parameter directly', () => {
        const members: Parameter[] = [{ type: ParameterType.ARGUMENT, name: 'player', optional: false, position: 0 }];
        const result = buildParameterStructureFromVariants(new Map([['add', members]]));
        assert.deepStrictEqual(result, [{
            type: ParameterType.SUBCOMMAND,
            name: 'add',
            literal: 'add',
            optional: false,
            position: 0,
            members,
            isComplete: false,
        }]);
    });

    test('multiple variants: wrapped in a CHOICE_LIST of SUBCOMMANDs in insertion order with sequential positions', () => {
        const variants = new Map<string, Parameter[]>([
            ['add', []],
            ['remove', []],
            ['list', []],
        ]);
        const result = buildParameterStructureFromVariants(variants);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].type, ParameterType.CHOICE_LIST);
        const choices = result[0].choices!;
        assert.deepStrictEqual(choices.map(c => [c.name, c.position]), [['add', 0], ['remove', 1], ['list', 2]]);
        assert.ok(choices.every(c => c.type === ParameterType.SUBCOMMAND && c.isComplete === false));
    });
});
