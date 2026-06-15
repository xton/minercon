// src/test/support/testLogger.ts
//
// consola-based fixtures for tests: a logger with no output sinks, and one
// that records calls per LogType for tests that assert on logging.

import { createConsola, type ConsolaInstance, type LogType } from 'consola';

/** A ConsolaInstance with no output sinks, for fixtures that don't care about logging. */
export function silentLogger(): ConsolaInstance {
  return createConsola({ reporters: [] });
}

/** A ConsolaInstance that records calls per LogType, for fixtures that assert on logging. */
export function recordingLogger(): { logger: ConsolaInstance; calls: Record<LogType, unknown[][]> } {
  const calls = {} as Record<LogType, unknown[][]>;
  const logger = createConsola({ reporters: [] });
  logger.mockTypes((type) => {
    calls[type] = [];
    return (...args: unknown[]) => { calls[type].push(args); };
  });
  return { logger, calls };
}
