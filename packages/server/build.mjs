import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const serverDir = fileURLToPath(new URL('.', import.meta.url));

const packageJson = JSON.parse(
  await readFile(new URL('./package.json', import.meta.url), 'utf8'),
);

const externalDependencies = Object.keys(packageJson.dependencies ?? {})
  .filter((dependency) => dependency !== '@pix/core');

await build({
  entryPoints: {
    index: 'src/index.ts',
    worker: 'src/worker.ts',
  },
  absWorkingDir: serverDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: 'dist',
  sourcemap: true,
  external: externalDependencies,
  logLevel: 'info',
});
