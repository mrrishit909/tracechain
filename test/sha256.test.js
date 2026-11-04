// The dependency-free SHA-256 must match node:crypto exactly, so the browser build hashes snapshots identically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../src/sha256.js';
import { Workspace } from '../src/index.js';

const ref = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

test('sha256Hex matches node:crypto on known vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const s of ['é漢🙂 TraceChain', 'lone \ud800 surrogate', 'x'.repeat(1024 * 1024 + 3), 'a\r\nb\u0000c']) {
    assert.equal(sha256Hex(s), ref(s));
  }
});

test('sha256Hex matches node:crypto at every padding boundary length 0..200', () => {
  for (let n = 0; n <= 200; n++) assert.equal(sha256Hex('q'.repeat(n)), ref('q'.repeat(n)), `length ${n}`);
});

test('fixture snapshot keeps its exact pre-port content hash', () => {
  const ws = new Workspace();
  const res = ws.importBatch(readFileSync(new URL('../fixtures/TC-SYN-001.json', import.meta.url)), { format: 'json' });
  assert.equal(res.contentHash, 'sha256:1237a046874eae6a56397a4b688c2ab76ae9fdeb4443630844bc9f73995dc1f9');
});
