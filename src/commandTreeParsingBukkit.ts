// src/commandTreeParsingBukkit.ts
//
// Pure parsing of Bukkit's hand-written `/help <command>` pages. Two formats:
//
// 1. Description:/Usage:/Aliases: block — the standard format for commands with
//    a single usage string (e.g. `/version`, `/reload`).
//
// 2. "Showing help for X" — a search-results page listing multiple subcommand
//    usages as `<cmd> <subcmd> [args] - description` lines. Bukkit uses this
//    for plugin commands that register each subcommand as its own help topic
//    rather than a single `Usage:` string (e.g. multi-command plugin like mvp).
//
// Both formats are extracted by `extractBukkitUsageLines` and are a different
// grammar from the flat Brigadier `/cmd <args>` blobs that
// `commandTreeParsingBrigadier.ts` handles: on a server where the `minecraft:`
// namespace is supported (Paper/Spigot), `help <path>` is *always* one of
// these pages — so no shape-sniffing is needed to decide which parser applies,
// only `CommandTreeCrawler.supportsMinecraftNamespace`.
//
// No state, no IO — every export here is a deterministic function of its
// arguments.

import { stripColors } from './ansi';

/**
 * Find the index of the first ` - ` (space-dash-space) at bracket depth 0 in
 * `s`. This is the separator between the usage string and the description in
 * Bukkit's "Showing help for X" format. Returns -1 if not found.
 */
function descriptionSeparatorIndex(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length - 2; i++) {
    const c = s[i];
    if (c === '<' || c === '[' || c === '(') { depth++; }
    else if (c === '>' || c === ']' || c === ')') { depth--; }
    else if (depth === 0 && c === ' ' && s[i + 1] === '-' && s[i + 2] === ' ') {
      return i;
    }
  }
  return -1;
}

/**
 * Extract the `Usage: ...` line(s) from a Bukkit-style `/help <command>`
 * response. Handles two formats:
 *
 * 1. Standard `Description:`/`Usage:`/`Aliases:` block (e.g. `/version`,
 *    `/reload`): returns the `Usage:` line(s), normalized for `parseHelpLines`.
 *    Returns `[]` if the Usage is just the bare command name (the generic
 *    response Bukkit gives for Brigadier-backed vanilla commands).
 *
 * 2. "Showing help for X" page (e.g. multi-command plugin help topics): lines
 *    of the form `<cmd> <subcmd> [args] - description`. Strips the ` -
 *    description` tail from each matching line and returns the usage portions,
 *    filtered to exclude the bare command itself.
 *
 * Returns `[]` if neither format yields usable argument info.
 */
export function extractBukkitUsageLines(helpText: string, commandPath: string): string[] {
  const lines = stripColors(helpText).split('\n').map(line => line.trim());
  const usageIndex = lines.findIndex(line => /^Usage:\s*/i.test(line));

  if (usageIndex !== -1) {
    const result: string[] = [lines[usageIndex].replace(/^Usage:\s*/i, '')];
    for (let i = usageIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || /^[A-Za-z][A-Za-z ]*:/.test(line) || line.startsWith('---')) {
        break;
      }
      result.push(line);
    }
    const normalizedPath = commandPath.toLowerCase();
    return result.filter(line => line.replace(/^\//, '').toLowerCase() !== normalizedPath);
  }

  // "Showing help for X" format: each line is `<cmd> <subcmd> [args] - description`.
  // Match lines that start with commandPath followed by a space, strip descriptions.
  const escaped = commandPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  const cmdPattern = new RegExp(`^/?${escaped}\\s`, 'i');
  const normalizedPath = commandPath.toLowerCase();

  const usageLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith('---') || line.startsWith('===')) { continue; }
    if (!cmdPattern.test(line)) { continue; }
    const sepIdx = descriptionSeparatorIndex(line);
    const usagePart = (sepIdx >= 0 ? line.slice(0, sepIdx) : line).trim();
    if (usagePart.replace(/^\//, '').toLowerCase() !== normalizedPath) {
      usageLines.push(usagePart);
    }
  }

  return usageLines;
}

/**
 * Extract alias names from a Bukkit-style `/help <command>` response's
 * `Aliases: a, b, c` line (e.g. "Description: ...\nUsage: ...\nAliases: ver,
 * about"). Returns `[]` if there's no Aliases line.
 */
export function extractBukkitAliases(helpText: string): string[] {
  const lines = stripColors(helpText).split('\n').map(line => line.trim());
  const aliasesLine = lines.find(line => /^Aliases:\s*/i.test(line));
  if (!aliasesLine) {
    return [];
  }

  return aliasesLine.replace(/^Aliases:\s*/i, '')
    .split(',')
    .map(alias => alias.trim())
    .filter(alias => alias.length > 0);
}
