// src/logger.ts

/**
 * Safely render a caught `unknown` value as a string for logging/display —
 * `Error`s contribute their `message`, anything else is stringified directly.
 * Replaces the `(err as any).message ?? err` pattern that was scattered
 * across every catch block that needed to report what went wrong.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
