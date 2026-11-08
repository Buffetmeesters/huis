// Huis-server v0.1: serveert het dashboard en bewaart de gegevens (SQLite).
// Geen externe pakketten nodig (Node 22+ heeft node:sqlite ingebouwd).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 8080;
const DATA = process.env.DATA_DIR || '/data';
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'huis.db'));
db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, t INTEGER NOT NULL)');
const get = db.prepare('SELECT v, t FROM kv WHERE k = ?');
const put = db.prepare('INSERT INTO kv (k, v, t) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t');

const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const KEYS = new Set(['data', 'rooms']);

function body(req) {
  return new Promise((ok, err) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 20e6) { err(new Error('te groot')); req.destroy(); } });
    req.on('end', () => ok(b));
    req.on('error', err);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    const m = url.pathname.match(/^\/api\/state\/(\w+)$/);
    if (m) {
      if (!KEYS.has(m[1])) { res.writeHead(404); return res.end(); }
      if (req.method === 'GET') {
        const r = get.get(m[1]);
        res.writeHead(r ? 200 : 204, { 'content-type': 'application/json' });
        return res.end(r ? r.v : '');
      }
      if (req.method === 'PUT') {
        const b = await body(req);
        JSON.parse(b);
        put.run(m[1], b, Date.now());
        res.writeHead(204); return res.end();
      }
      res.writeHead(405); return res.end();
    }
    let f = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    res.writeHead(500); res.end(String(e.message));
  }
}).listen(PORT, () => console.log('Huis-server luistert op poort ' + PORT));
