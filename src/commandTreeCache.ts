// src/commandTreeCache.ts
//
// On-disk persistence for the command tree `LocalCommandTree` builds by
// crawling a server's `/help` output — versioned, server-scoped, and aged out
// after a week so a stale tree doesn't outlive a server's command set.

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';
import { CommandNode } from './localCommandTree';

interface CommandCache {
  version: string;
  serverIdentifier: string;
  lastUpdated: string;
  commands: { [key: string]: CommandNode };
}

export class CommandTreeCache {
  private cacheDir: string;
  private cacheFile: string;
  private cacheVersion: string = '2.2.0'; // Bumped: dropped rawHelp; aliases are now expanded into commands
  private serverIdentifier: string;

  constructor(
    cacheDir: string,
    serverHost: string,
    serverPort: number,
    private logger: Logger
  ) {
    this.serverIdentifier = `${serverHost}:${serverPort}`;
    this.cacheDir = cacheDir;
    this.cacheFile = path.join(this.cacheDir, `${serverHost}_${serverPort}.json`);

    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Save commands to cache
   */
  save(rootCommands: Map<string, CommandNode>): void {
    try {
      const cache: CommandCache = {
        version: this.cacheVersion,
        serverIdentifier: this.serverIdentifier,
        lastUpdated: new Date().toISOString(),
        commands: {}
      };

      rootCommands.forEach((node, name) => {
        cache.commands[name] = node;
      });

      fs.writeFileSync(this.cacheFile, JSON.stringify(cache, null, 2));
      this.logger.info(`Command cache saved to ${this.cacheFile}`);
    } catch (error) {
      this.logger.error(`Error saving cache: ${error}`);
    }
  }

  /**
   * Load commands from cache. Returns null if there's no usable cache
   * (missing, version/server mismatch, or too old).
   */
  load(): Map<string, CommandNode> | null {
    try {
      if (!fs.existsSync(this.cacheFile)) {
        return null;
      }

      const cacheContent = fs.readFileSync(this.cacheFile, 'utf-8');
      const cache: CommandCache = JSON.parse(cacheContent);

      // Check cache validity
      if (cache.version !== this.cacheVersion ||
        cache.serverIdentifier !== this.serverIdentifier) {
        this.logger.info('Cache version or server mismatch, will refresh');
        return null;
      }

      // Check age (optional - could add max age check here)
      const cacheAge = Date.now() - new Date(cache.lastUpdated).getTime();
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
      if (cacheAge > maxAge) {
        this.logger.info('Cache too old, will refresh');
        return null;
      }

      const rootCommands = new Map<string, CommandNode>();
      Object.entries(cache.commands).forEach(([name, node]) => {
        rootCommands.set(name, node);
      });

      this.logger.info(`Commands loaded from cache (${rootCommands.size} commands)`);
      return rootCommands;

    } catch (error) {
      this.logger.error(`Error loading cache: ${error}`);
      return null;
    }
  }

  /**
   * Get cache information
   */
  getInfo(): { exists: boolean; age: string; lastUpdated?: Date } {
    try {
      if (!fs.existsSync(this.cacheFile)) {
        return { exists: false, age: 'No cache' };
      }

      const stats = fs.statSync(this.cacheFile);
      const ageMs = Date.now() - stats.mtime.getTime();

      let age: string;
      if (ageMs < 60000) {
        age = 'Less than a minute';
      } else if (ageMs < 3600000) {
        age = `${Math.floor(ageMs / 60000)} minutes`;
      } else if (ageMs < 86400000) {
        age = `${Math.floor(ageMs / 3600000)} hours`;
      } else {
        age = `${Math.floor(ageMs / 86400000)} days`;
      }

      return {
        exists: true,
        age,
        lastUpdated: stats.mtime
      };
    } catch {
      return { exists: false, age: 'Error checking cache' };
    }
  }

  /**
   * Clear the cache
   */
  clear(): void {
    try {
      if (fs.existsSync(this.cacheFile)) {
        fs.unlinkSync(this.cacheFile);
        this.logger.info('Command cache cleared');
      }
    } catch (error) {
      this.logger.error(`Error clearing cache: ${error}`);
    }
  }
}
