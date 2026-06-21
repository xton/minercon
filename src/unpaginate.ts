// src/unpaginate.ts
//
// Client side of the server-side de-pagination feature. When the TabComplete
// plugin is present *and* exposes the `rcat` command (Bukkit-family servers —
// not Fabric, which doesn't paginate), the interactive terminal wraps each
// server-bound command as `rcat <command>` so its output comes back unpaginated
// in a single response. See docs/UNPAGINATED_OUTPUT.md.

/** Line the plugin's `rcat` (no-arg) response emits; used to detect support. */
export const RCAT_PROBE_MARKER = 'rcat: returns unpaginated command output';

/** True iff a probe response indicates the server supports `rcat`. */
export function responseSupportsRcat(response: string | undefined): boolean {
  return !!response && response.includes(RCAT_PROBE_MARKER);
}

/**
 * Returns the command to actually send: `rcat <command>` when de-pagination is
 * active, otherwise the command unchanged. Empty/whitespace input is never
 * wrapped (nothing to run).
 */
export function wrapForUnpagination(command: string, supported: boolean): string {
  if (!supported || command.trim().length === 0) {
    return command;
  }
  return `rcat ${command}`;
}
