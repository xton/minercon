// src/displayCommandTree.ts
//
// Formats the command tree built by CommandTreeCrawler for human inspection.
// Used by the /tree builtin.
//
// Output is one "usage line" per unique path through the tree — the same
// style Minecraft's /help produces. A deep CHOICE_LIST (choices that have
// their own sub-parameters, produced by buildParameterStructureFromVariants
// for multi-variant commands) forks into one line per choice. A simple
// CHOICE_LIST (inline `(a|b|c)` literals from parseCommandHelp) is collapsed
// onto the same line with bracket/pipe notation. Optional parameters are
// shown in brackets rather than expanded, so the line count stays bounded.

import { Parameter, ParameterType, CommandNode } from './commandTree';
import { cyan, gray, dim, stripColors } from './ansi';

const MAX_LINES = 300;

export function formatCommandTree(rootCommands: Map<string, CommandNode>, commandName?: string): string {
  if (commandName) {
    const name = commandName.startsWith('/') ? commandName.slice(1) : commandName;
    const node = rootCommands.get(name);
    if (!node) { return `Unknown command: /${name}\n`; }
    const lines: string[] = [];
    walkSequential(`/${name}`, node.members ?? [], lines);
    if (lines.length === 0) { lines.push(`/${name}`); }
    if (lines.length >= MAX_LINES) { lines.push('(truncated)'); }
    return lines.join('\n') + '\n';
  }

  const names = [...rootCommands.keys()].sort((a, b) => {
    const aNs = a.includes(':'), bNs = b.includes(':');
    if (aNs !== bNs) { return aNs ? 1 : -1; }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const lines: string[] = [`${names.length} commands:`];
  const COL_WIDTH = 22, COLS = 4;
  for (let i = 0; i < names.length; i += COLS) {
    lines.push('  ' + names.slice(i, i + COLS).map(n => ('/' + n).padEnd(COL_WIDTH)).join('').trimEnd());
  }
  return lines.join('\n') + '\n';
}

/**
 * Walks `members` sequentially, appending tokens to `prefix` and collecting
 * complete usage lines into `out`. A deep CHOICE_LIST (any choice has
 * sub-members) forks — one recursion per choice, each picking up the
 * remaining siblings afterward. Simple CHOICE_LIST and all other parameter
 * types are rendered as a single token and appended in-line.
 */
function walkSequential(prefix: string, members: Parameter[], out: string[]): void {
  if (out.length >= MAX_LINES) { return; }
  if (members.length === 0) { out.push(prefix); return; }

  const [first, ...rest] = members;

  if (first.type === ParameterType.CHOICE_LIST && first.choices?.some(c => c.members?.length)) {
    // Deep alternation: fork one line per choice.
    for (const choice of (first.choices ?? [])) {
      if (out.length >= MAX_LINES) { return; }
      walkSequential(`${prefix} ${paramToken(choice)}`, [...(choice.members ?? []), ...rest], out);
    }
    // If the whole CHOICE_LIST is optional, also emit the path that skips it.
    if (first.optional) { walkSequential(prefix, rest, out); }
  } else {
    // Sequential: append this token and recurse into sub-members then siblings.
    const token = paramToken(first);
    walkSequential(`${prefix} ${token}`, [...(first.members ?? []), ...rest], out);
  }
}

export function formatCommandLog(pairs: { send: string; recv: string }[]): string {
  if (pairs.length === 0) { return ''; }
  const lines: string[] = ['', dim('── send/recv log ─────────────────────────')];
  for (const { send, recv } of pairs) {
    lines.push(cyan(`> ${send}`));
    const recvText = stripColors(recv).trimEnd();
    for (const line of recvText.split('\n')) {
      lines.push(gray(`  ${line}`));
    }
  }
  return lines.join('\n') + '\n';
}

function paramToken(p: Parameter): string {
  switch (p.type) {
    case ParameterType.ARGUMENT:   return p.optional ? `[<${p.name}>]` : `<${p.name}>`;
    case ParameterType.LITERAL:    return p.optional ? `[${p.literal ?? '?'}]` : (p.literal ?? '?');
    case ParameterType.SUBCOMMAND: return p.optional ? `[${p.name ?? '?'}]` : (p.name ?? '?');
    case ParameterType.CHOICE_LIST: {
      const inner = (p.choices ?? []).map(c => c.literal ?? c.name ?? '?').join('|');
      return p.optional ? `[(${inner})]` : `(${inner})`;
    }
  }
}
