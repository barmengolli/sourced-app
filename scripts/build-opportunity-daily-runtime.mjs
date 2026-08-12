import { build } from 'vite';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = path.join('/tmp', 'sourced-opportunity-daily-runtime');
const output = path.join(root, 'src/generated/opportunityDailyRuntime.bundle.js');
const check = process.argv.includes('--check');

await rm(temp, { recursive: true, force: true });
await build({
  configFile: false,
  logLevel: 'silent',
  build: {
    lib: {
      entry: path.join(root, 'src/lib/opportunityDailyRuntimeEntry.ts'),
      name: 'OpportunityDailyRuntime',
      formats: ['iife'],
      fileName: () => 'opportunityDailyRuntime.bundle.js',
    },
    outDir: temp,
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
  },
});

const generated = await readFile(path.join(temp, 'opportunityDailyRuntime.bundle.js'), 'utf8');
await rm(temp, { recursive: true, force: true });

if (check) {
  const committed = await readFile(output, 'utf8').catch(() => '');
  if (committed !== generated) {
    throw new Error('opportunity daily runtime bundle drifted; run npm run build:opportunity-daily-runtime');
  }
} else {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, generated);
}
