// esbuild.js — bundles the extension and CLI entry points for packaging.
// See https://code.visualstudio.com/api/working-with-extensions/bundling-extension

const esbuild = require('esbuild');

const production = process.argv.includes('--production');

esbuild.build({
  entryPoints: {
    extension: 'src/extension.ts',
    minercon: 'src/cli.ts',
  },
  bundle: true,
  minify: production,
  sourcemap: !production,
  platform: 'node',
  format: 'cjs',
  outdir: 'dist',
  external: ['vscode'],
}).catch(() => process.exit(1));
