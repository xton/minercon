import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ServerVariant, PASSWORD, RCON_PORT } from './variants';

const PLUGIN_JAR = path.resolve(__dirname, '../../../plugin/build/libs/paper-tabcomplete-1.0.0.jar');

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

// Tracks per-container cleanup functions (temp dirs for plugin bind mounts).
const cleanupMap = new Map<StartedTestContainer, () => void>();

export async function startServer(variant: ServerVariant): Promise<StartedTestContainer> {
  let container = new GenericContainer(variant.image)
    .withEnvironment({ ...BASE_ENV, TYPE: variant.type, VERSION: variant.version })
    .withExposedPorts(RCON_PORT)
    // Check the RCON TCP port directly — more robust than log-message scanning,
    // and survives log format differences across server implementations.
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(variant.startupTimeoutMs);

  let tmpPluginsDir: string | undefined;

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
    tmpPluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcon-plugins-'));
    fs.copyFileSync(PLUGIN_JAR, path.join(tmpPluginsDir, 'paper-tabcomplete.jar'));
    container = container.withBindMounts([{
      source: tmpPluginsDir,
      target: '/data/plugins',
      mode: 'rw',
    }]);
  }

  const started = await container.start();

  if (tmpPluginsDir) {
    cleanupMap.set(started, () => fs.rmSync(tmpPluginsDir!, { recursive: true, force: true }));
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
