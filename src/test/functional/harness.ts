import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ServerVariant, PASSWORD, RCON_PORT } from './variants';

const PLUGIN_JAR = path.resolve(__dirname, '../../../plugin/build/libs/paper-tabcomplete-1.0.0.jar');
const FABRIC_MOD_JAR = path.resolve(__dirname, '../../../fabric-mod/build/libs/fabric-tabcomplete-1.0.0.jar');

const BASE_ENV: Record<string, string> = {
  EULA: 'TRUE',
  RCON_ENABLED: 'TRUE',
  RCON_PASSWORD: PASSWORD,
  ONLINE_MODE: 'FALSE',
  SPAWN_MONSTERS: 'FALSE',
  SPAWN_ANIMALS: 'FALSE',
  GENERATE_STRUCTURES: 'FALSE',
  MOTD: 'functional-test',
  MAX_PLAYERS: '1',
  VIEW_DISTANCE: '4',
};

// Tracks per-container cleanup functions (temp dirs for plugin/mod bind mounts).
const cleanupMap = new Map<StartedTestContainer, () => void>();

export async function startServer(variant: ServerVariant): Promise<StartedTestContainer> {
  let container = new GenericContainer(variant.image)
    .withEnvironment({ ...BASE_ENV, TYPE: variant.type, VERSION: variant.version })
    .withExposedPorts(RCON_PORT)
    // Check the RCON TCP port directly — more robust than log-message scanning,
    // and survives log format differences across server implementations.
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(variant.startupTimeoutMs);

  let tmpDir: string | undefined;

  if (variant.hasPlugin) {
    if (!fs.existsSync(PLUGIN_JAR)) {
      throw new Error(
        `Plugin jar not found at ${PLUGIN_JAR}.\nBuild it first: cd plugin && ./gradlew build`
      );
    }
    // withCopyFilesToContainer does not work for paths under a Docker VOLUME —
    // the volume mount at /data on container start overwrites anything copied
    // into the overlay before startup. Bind-mounting the plugins directory
    // directly bypasses the volume for that specific path.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcon-plugins-'));
    fs.chmodSync(tmpDir, 0o755);
    fs.copyFileSync(PLUGIN_JAR, path.join(tmpDir, 'paper-tabcomplete.jar'));
    container = container.withBindMounts([{
      source: tmpDir,
      target: '/data/plugins',
      mode: 'rw',
    }]);
  } else if (variant.hasMod) {
    if (!fs.existsSync(FABRIC_MOD_JAR)) {
      throw new Error(
        `Fabric mod jar not found at ${FABRIC_MOD_JAR}.\nBuild it first: cd fabric-mod && ./gradlew build`
      );
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcon-mods-'));
    fs.chmodSync(tmpDir, 0o755);
    fs.copyFileSync(FABRIC_MOD_JAR, path.join(tmpDir, 'fabric-tabcomplete.jar'));
    container = container.withBindMounts([{
      source: tmpDir,
      target: '/data/mods',
      mode: 'rw',
    }]);
  }

  const logs: string[] = [];
  container = container.withLogConsumer(stream => {
    stream.on('data', (chunk: Buffer | string) => logs.push(String(chunk)));
    stream.on('err', (chunk: Buffer | string) => logs.push('[ERR] ' + String(chunk)));
  });

  let started: StartedTestContainer;
  try {
    started = await container.start();
  } catch (e) {
    if (logs.length > 0) {
      process.stderr.write(`\n=== Container startup logs (${variant.name}) ===\n`);
      process.stderr.write(logs.join(''));
      process.stderr.write('\n=== End container logs ===\n\n');
    }
    throw e;
  }

  if (tmpDir) {
    cleanupMap.set(started, () => fs.rmSync(tmpDir!, { recursive: true, force: true }));
  }

  return started;
}

export async function stopServer(container: StartedTestContainer): Promise<void> {
  const cleanup = cleanupMap.get(container);
  cleanupMap.delete(container);
  await container.stop();
  cleanup?.();
}

export function connectionParams(container: StartedTestContainer): { host: string; port: number; password: string } {
  return {
    host: container.getHost(),
    port: container.getMappedPort(RCON_PORT),
    password: PASSWORD,
  };
}
