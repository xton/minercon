export const PASSWORD = 'testpassword';
export const RCON_PORT = 25575;
export const MC_VERSION = '1.21.4';

// In CI, the Spigot pre-built image (ghcr.io/xton/minecraft-rcon/spigot-prebuilt:VERSION)
// is set via SPIGOT_IMAGE so BuildTools doesn't run during tests. Locally, fall
// back to itzg/minecraft-server and let it build on first pull (slow, one-time).
const SPIGOT_IMAGE = process.env.SPIGOT_IMAGE ?? 'itzg/minecraft-server';

export interface ServerVariant {
  name: string;
  image: string;
  type: string;
  version: string;
  hasPlugin: boolean;
  startupTimeoutMs: number;
}

export const variants: ServerVariant[] = [
  { name: 'vanilla',      image: 'itzg/minecraft-server', type: 'VANILLA', version: MC_VERSION, hasPlugin: false, startupTimeoutMs: 300_000 },
  { name: 'paper',        image: 'itzg/minecraft-server', type: 'PAPER',   version: MC_VERSION, hasPlugin: false, startupTimeoutMs: 300_000 },
  { name: 'paper+plugin', image: 'itzg/minecraft-server', type: 'PAPER',   version: MC_VERSION, hasPlugin: true,  startupTimeoutMs: 300_000 },
  { name: 'spigot',       image: SPIGOT_IMAGE,            type: 'SPIGOT',  version: MC_VERSION, hasPlugin: false, startupTimeoutMs: 300_000 },
  { name: 'fabric',       image: 'itzg/minecraft-server', type: 'FABRIC',  version: MC_VERSION, hasPlugin: false, startupTimeoutMs: 300_000 },
];

export const nonPluginVariants = variants.filter(v => !v.hasPlugin);
export const pluginVariant = variants.find(v => v.hasPlugin)!;
