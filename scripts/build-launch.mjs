// Bundles the pump.fun launch code for the browser into web/launch/core.js. Only needed when LAUNCH_ENABLED=1.
// Run: npm run build   (Railway runs it for you after npm install)
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [path.join(root, 'launch-src/entry.js')],
  outfile: path.join(root, 'web/launch/core.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  inject: [path.join(root, 'launch-src/shim.js')],
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});
