import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runMatch } from '../sandbox/src/run.ts';
import { projectRun } from '../sandbox/src/projection.ts';

// Export real, redacted HTTP runs; the hosted preview never pretends to run a backend.
const destination = resolve(process.argv[2] ?? 'output/demo-site');
await mkdir(join(destination, 'recordings'), { recursive: true });
const index = [];
for (const mode of ['baseline', 'hardened'] as const) {
  const run = projectRun(await runMatch({ mode, engine: 'fixture', durationMs: 8000, loadProfile: 'burst' }));
  await writeFile(join(destination, 'recordings', `${run.id}.json`), JSON.stringify(run));
  index.push({ id: run.id, mode, engine: run.engine });
  console.log(JSON.stringify({ mode, metrics: run.summary.metrics }));
}
await writeFile(join(destination, 'recordings/index.json'), JSON.stringify(index));
const html = (await readFile('web/live.html','utf8')).replace('<body>', '<body data-mode="recorded">');
await writeFile(join(destination, 'index.html'), html);
await copyFile('web/dist/app.js', join(destination, 'app.js'));
await copyFile('web/theme.css', join(destination, 'theme.css'));
