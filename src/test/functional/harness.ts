import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import * as path from 'path';
import { ServerVariant, PASSWORD, RCON_PORT } from './variants';

// Resolved at test runtime: out/test/functional/ → project root → plugin build output
const PLUGIN_JAR = path.resolve(__dirname, '../../../plugin/build/libs/paper-tabcomplete-1.0.0.jar');

const BASE_ENV: Record<string, string> = {
  EULA: 'TRUE',
  RCON_ENABLED: 'TRUE',
  RCON_PASSWORD: PASSWORD,
  ONLINE_MODE: 'FALSE',   // no Mojang auth — required in isolated test environments
  SPAWN_MONSTERS: 'FALSE',
  SPAWN_ANIMALS: 'FALSE',
  GENERATE_STRUCTURES: 'FALSE',
  MOTD: 'functional-test',
  MAX_PLAYERS: '1',
  VIEW_DISTANCE: '4',
};

export async function startServer(variant: ServerVariant): Promise<StartedTestContainer> {
  let container = new GenericContainer(variant.image)
    .withEnvironment({ ...BASE_ENV, TYPE: variant.type, VERSION: variant.version })
    .withExposedPorts(RCON_PORT)
    // itzg/minecraft-server logs this line exactly when RCON is accepting connections
    .withWaitStrategy(Wait.forLogMessage(/RCON running on/))
    .withStartupTimeout(variant.startupTimeoutMs);

  if (variant.hasPlugin) {
    container = container.withCopyFilesToContainer([
      { source: PLUGIN_JAR, target: '/data/plugins/paper-tabcomplete.jar' },
    ]);
  }

  return container.start();
}

export function connectionParams(container: StartedTestContainer): { host: string; port: number; password: string } {
  return {
    host: container.getHost(),
    port: container.getMappedPort(RCON_PORT),
    password: PASSWORD,
  };
}
