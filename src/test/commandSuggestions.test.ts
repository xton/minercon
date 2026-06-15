import * as assert from 'assert';
import { getSuggestions } from '../commandSuggestions';
import { ParameterType, Parameter, CommandNode, newCommandNode } from '../commandTree';

function arg(name: string, optional = false): Parameter {
    return { type: ParameterType.ARGUMENT, name, optional, position: 0 };
}
function literal(text: string, optional = false): Parameter {
    return { type: ParameterType.LITERAL, literal: text, optional, position: 0 };
}
function subcommand(name: string, members: Parameter[] = []): Parameter {
    return { type: ParameterType.SUBCOMMAND, name, literal: name, optional: false, position: 0, members, isComplete: true };
}
function choiceList(...choices: Parameter[]): Parameter {
    return { type: ParameterType.CHOICE_LIST, choices, optional: false, position: 0 };
}
function node(name: string, members: Parameter[]): CommandNode {
    return { ...newCommandNode(name), members, isComplete: true };
}
function tree(...nodes: CommandNode[]): Map<string, CommandNode> {
    return new Map(nodes.map(n => [n.name!, n]));
}

suite('commandSuggestions: getSuggestions', () => {
    test('not ready: returns nothing regardless of input', () => {
        const result = getSuggestions(tree(node('gamemode', [])), false, '/gam');
        assert.deepStrictEqual(result, { suggestions: [], argumentHelp: undefined });
    });

    test('input that is not a slash command: returns nothing', () => {
        const result = getSuggestions(tree(node('gamemode', [])), true, 'hello');
        assert.deepStrictEqual(result, { suggestions: [], argumentHelp: undefined });
    });

    test('typing a partial root command: suggests matching command names, sorted', () => {
        const commands = tree(node('gamemode', []), node('gamerule', []), node('tp', []));
        const result = getSuggestions(commands, true, '/gam');
        assert.deepStrictEqual(result.suggestions, ['gamemode', 'gamerule']);
        assert.strictEqual(result.argumentHelp, undefined);
    });

    test('bare slash: suggests every root command, sorted', () => {
        const commands = tree(node('tp', []), node('gamemode', []));
        const result = getSuggestions(commands, true, '/');
        assert.deepStrictEqual(result.suggestions, ['gamemode', 'tp']);
    });

    test('unknown root command: returns nothing', () => {
        const result = getSuggestions(tree(node('gamemode', [])), true, '/nonexistent ');
        assert.deepStrictEqual(result, { suggestions: [], argumentHelp: undefined });
    });

    test('trailing space after the command name navigates into its first argument', () => {
        const commands = tree(node('gamemode', [arg('mode'), arg('target', true)]));
        const result = getSuggestions(commands, true, '/gamemode ');
        assert.strictEqual(result.argumentHelp, '<mode> [<target>]');
        assert.strictEqual(result.commandPath, 'gamemode');
        assert.deepStrictEqual(result.suggestions, []); // ARGUMENT positions never suggest values
    });

    test('typed argument values are skipped over to reach the next position, and are not part of commandPath', () => {
        const commands = tree(node('gamemode', [arg('mode'), arg('target', true)]));
        const result = getSuggestions(commands, true, '/gamemode survival ');
        assert.strictEqual(result.argumentHelp, '[<target>]');
        assert.strictEqual(result.commandPath, 'gamemode');
        assert.deepStrictEqual(result.suggestions, []);
    });

    test('matching literal tokens are navigated past sequentially, and become part of commandPath', () => {
        const commands = tree(node('mvp', [literal('modify'), arg('property'), arg('value')]));

        const afterLiteral = getSuggestions(commands, true, '/mvp modify ');
        assert.strictEqual(afterLiteral.argumentHelp, '<property> <value>');
        assert.strictEqual(afterLiteral.commandPath, 'mvp modify');
        assert.deepStrictEqual(afterLiteral.suggestions, []);
    });

    test('a namespaced command name is preserved verbatim in commandPath', () => {
        const commands = tree(node('minecraft:clear', [arg('targets', true), arg('item', true)]));
        const result = getSuggestions(commands, true, '/minecraft:clear ');
        assert.strictEqual(result.argumentHelp, '[<targets>] [<item>]');
        assert.strictEqual(result.commandPath, 'minecraft:clear');
    });

    test('a command with no parameters has an empty argumentHelp but a non-empty commandPath', () => {
        const commands = tree(node('reload', []));
        const result = getSuggestions(commands, true, '/reload ');
        assert.strictEqual(result.argumentHelp, '');
        assert.strictEqual(result.commandPath, 'reload');
    });

    test('partially-typed literal tokens are suggested by prefix', () => {
        const commands = tree(node('mvp', [literal('modify'), arg('property'), arg('value')]));

        const partial = getSuggestions(commands, true, '/mvp mod');
        assert.strictEqual(partial.argumentHelp, 'modify <property> <value>');
        assert.deepStrictEqual(partial.suggestions, ['modify']);
    });

    test('choice-list parameter: suggests matching choices while typing', () => {
        const commands = tree(node('whitelist', [
            choiceList(subcommand('add', [arg('targets')]), subcommand('remove', [arg('targets')]), literal('list'), literal('reload')),
        ]));
        const result = getSuggestions(commands, true, '/whitelist r');
        assert.deepStrictEqual(result.suggestions, ['reload', 'remove']);
    });

    test('choice-list parameter: suggests every choice for the next position when nothing typed yet', () => {
        const commands = tree(node('whitelist', [
            choiceList(subcommand('add'), subcommand('remove'), literal('list'), literal('reload')),
        ]));
        const result = getSuggestions(commands, true, '/whitelist ');
        assert.deepStrictEqual(result.suggestions, ['add', 'list', 'reload', 'remove']);
    });

    test('navigating into a chosen subcommand exposes its members', () => {
        const commands = tree(node('whitelist', [
            choiceList(subcommand('add', [arg('player')]), literal('list')),
        ]));
        const result = getSuggestions(commands, true, '/whitelist add ');
        assert.strictEqual(result.argumentHelp, '<player>');
        assert.deepStrictEqual(result.suggestions, []);
    });

    test('argument help renders every parameter type', () => {
        const commands = tree(node('demo', [
            arg('a'),
            arg('b', true),
            choiceList(literal('x'), literal('y')),
            literal('z'),
            subcommand('sub'),
        ]));
        const result = getSuggestions(commands, true, '/demo ');
        assert.strictEqual(result.argumentHelp, '<a> [<b>] (x|y) z sub');
        assert.deepStrictEqual(result.suggestions, []);
    });
});
