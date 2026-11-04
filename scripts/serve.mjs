// Localhost-only static server for dist/: 127.0.0.1, GET/HEAD only, MIME + security headers, no dotfiles/traversal.
import { createServer as httpServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cache-Control': 'no-store',
};

export function createServer(root) {
  const base = resolve(root);
  return httpServer(async (req, res) => {
    const send = (code, body, extra = {}) => { res.writeHead(code, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...extra }); res.end(req.method === 'HEAD' ? undefined : body); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch { return send(400, 'Bad Request'); }
    if (path.includes('\0') || path.includes('\\') || path.split('/').some((seg) => seg.startsWith('.'))) return send(404, 'Not Found');
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(join(base, path));
    if (!file.startsWith(base + sep)) return send(404, 'Not Found');
    const type = MIME[extname(file)];
    if (!type) return send(404, 'Not Found');
    try {
      if (!(await stat(file)).isFile()) return send(404, 'Not Found');
      const body = await readFile(file);
      res.writeHead(200, { ...HEADERS, 'Content-Type': type, 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { send(404, 'Not Found'); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  const { build } = await import('./build.mjs'); // dist/ is gitignored: always rebuild so `npm run serve` works on a fresh checkout
  createServer(build()).listen(port, '127.0.0.1', () => console.log(`TraceChain (synthetic) at http://127.0.0.1:${port}/`));
}
