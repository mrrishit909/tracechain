// Every ES module import in dist resolves (with browser URL semantics) to a whitelisted file; no node: builtins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build, WHITELIST } from '../scripts/build.mjs';

test('dist module graph resolves inside the whitelist without node builtins', () => {
  const out = build(join(tmpdir(), `tc-mod-${process.pid}`));
  const files = new Set(WHITELIST.map(([, to]) => to));
  let checked = 0;
  for (const rel of files) {
    if (!rel.endsWith('.js')) continue;
    const src = readFileSync(join(out, rel), 'utf8');
    for (const [, spec] of src.matchAll(/\bfrom\s+'([^']+)'/g)) {
      assert.ok(!spec.startsWith('node:'), `${rel} imports ${spec}`);
      const target = new URL(spec, `http://h/${rel}`).pathname.slice(1);
      assert.ok(files.has(target), `${rel} -> ${spec} resolves to missing ${target}`);
      checked++;
    }
  }
  assert.ok(checked > 10);
});
