// Copy an explicit whitelist into dist/. Never copies .git, audit, prompts, streams or logs.
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WHITELIST = [
  ['web/index.html', 'index.html'], ['web/workspace.html', 'workspace.html'], ['web/styles.css', 'styles.css'],
  ['web/landing.css', 'landing.css'], ['web/landing.js', 'landing.js'], ['web/app.js', 'app.js'], ['web/state.js', 'state.js'],
  ...['index', 'limits', 'workspace', 'input', 'schema', 'validate', 'sha256', 'trace', 'report', 'csv', 'origin'].map((m) => [`src/${m}.js`, `src/${m}.js`]),
  ['fixtures/TC-SYN-001.json', 'fixtures/TC-SYN-001.json'], ['fixtures/TC-SYN-001.csv', 'fixtures/TC-SYN-001.csv'],
];

export function build(out = join(root, 'dist')) {
  rmSync(out, { recursive: true, force: true });
  for (const [from, to] of WHITELIST) {
    mkdirSync(dirname(join(out, to)), { recursive: true });
    copyFileSync(join(root, from), join(out, to));
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`built ${build()} (${WHITELIST.length} files)`);
