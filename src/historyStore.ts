// src/historyStore.ts
//
// On-disk persistence for command history — server-scoped (like
// commandTreeCache.ts), so history doesn't bleed between different servers
// sharing the same cacheDir. Loaded once at session start to seed
// LineEditor's in-memory history, and rewritten each time a command is run.

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

interface HistoryFile {
  version: number;
  entries: string[];
}

const CURRENT_VERSION = 1;

/** Mirrors LineEditor's in-memory cap — no point persisting more than it'll ever hold. */
const MAX_ENTRIES = 100;

export class HistoryStore {
  private readonly file: string;

  constructor(cacheDir: string, serverHost: string, serverPort: number, private logger: Logger) {
    this.file = path.join(cacheDir, `${serverHost}_${serverPort}_history.json`);
  }

  /** Returns persisted entries (oldest-first), or `[]` if there's nothing usable to load. */
  load(): string[] {
    try {
      if (!fs.existsSync(this.file)) { return []; }
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as HistoryFile;
      if (parsed.version !== CURRENT_VERSION || !Array.isArray(parsed.entries)) { return []; }
      return parsed.entries.filter((e): e is string => typeof e === 'string').slice(-MAX_ENTRIES);
    } catch (error) {
      this.logger.error(`Error loading command history: ${error}`);
      return [];
    }
  }

  /** Persists `entries` (oldest-first), overwriting whatever was there before. */
  save(entries: readonly string[]): void {
    try {
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data: HistoryFile = { version: CURRENT_VERSION, entries: entries.slice(-MAX_ENTRIES) };
      fs.writeFileSync(this.file, JSON.stringify(data));
    } catch (error) {
      this.logger.error(`Error saving command history: ${error}`);
    }
  }
}
