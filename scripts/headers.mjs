// Writes dist/_headers for a static host after `node scripts/build.mjs`. The policy is the one the
// local preview server already sends, else the built app page's meta CSP; page meta policies stay in
// force on top of it. Refuses to write a policy without default-src. Nothing is deployed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const fromServe = /content-security-policy['"]\s*:\s*((?:"[^"\n]*"\s*\+?\s*)+)/i.exec(read(join(ROOT, 'scripts', 'serve.mjs')))?.[1];
const metaOf = (p) => /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(read(p))?.[1] ?? null;
const policy = (fromServe ? [...fromServe.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('') : null)
  ?? metaOf(join(DIST, 'app', 'index.html')) ?? metaOf(join(DIST, 'workspace.html')) ?? '';
if (!/(^|;)\s*default-src\s/.test(policy)) throw new Error(`refusing to write _headers: no default-src in "${policy}"`);
const have = new Set(policy.split(';').map((d) => d.trim().split(/\s+/)[0]).filter(Boolean));
const extra = [['frame-ancestors', "'none'"], ['base-uri', "'none'"], ['object-src', "'none'"], ['form-action', "'none'"]].filter(([d]) => !have.has(d));
const csp = [policy.trim().replace(/;$/, ''), ...extra.map(([d, v]) => `${d} ${v}`)].join('; ');
writeFileSync(join(DIST, '_headers'), ['/*', `  Content-Security-Policy: ${csp}`, '  X-Content-Type-Options: nosniff', '  Referrer-Policy: no-referrer',
  '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()', '  Cross-Origin-Opener-Policy: same-origin', '  X-Frame-Options: DENY', ''].join('\n'));
console.log('wrote dist/_headers');
