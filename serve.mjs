// Tiny static server for the LP helper page.  Usage:  node lp-helper/serve.mjs   ->  http://localhost:5199
// Serves only the whitelisted page files from this directory, bound to localhost.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5199);
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/lib.mjs': ['lib.mjs', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

// Optional private upstream RPC (e.g. Alchemy, dRPC or any Elysium provider). Passed via env at startup so the key never
// appears in page code; the browser only ever talks to http://localhost:PORT/rpc.
const UPSTREAM = process.env.UPSTREAM_RPC || 'https://rpc.elysium.kinetiq.xyz';
const ALLOWED_RPC = new Set(['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getBalance', 'eth_getLogs',
  'eth_getCode', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getBlockByNumber',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getStorageAt', 'net_version']);

async function proxyRpc(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) {
    res.writeHead(403).end(); return;
  }
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 1_000_000) { res.writeHead(413).end(); return; } }
  let body;
  try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
  const calls = Array.isArray(body) ? body : [body];
  if (calls.some((c) => !ALLOWED_RPC.has(c?.method))) { res.writeHead(403, { 'content-type': 'text/plain' }).end('method not allowed'); return; }
  try {
    const up = await fetch(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    res.writeHead(up.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(await up.text());
  } catch {
    res.writeHead(502).end();
  }
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
  if (path === '/rpc' && req.method === 'POST') { await proxyRpc(req, res); return; }
  const entry = FILES[path];
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  try {
    const body = await readFile(join(ROOT, entry[0]));
    res.writeHead(200, {
      'content-type': entry[1],
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LP helper running at http://localhost:${PORT}  (Ctrl+C to stop)  rpc: ${process.env.UPSTREAM_RPC ? 'private upstream' : 'public'}`);
});
