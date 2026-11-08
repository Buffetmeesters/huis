// Huis-server v0.2: login (eigenaren + gastcodes), rechten, opslag in SQLite.
// Geen externe pakketten nodig (Node 22+ heeft node:sqlite ingebouwd).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 8080;
const DATA = process.env.DATA_DIR || '/data';
const OWNERS = ['Joshua', 'Lorenzo'];
const SESSION_DAYS_OWNER = 30, SESSION_DAYS_GUEST = 7;
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'huis.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, t INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS owners (name TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, role TEXT NOT NULL, ref TEXT NOT NULL, exp INTEGER NOT NULL);`);
const q = {
  get: db.prepare('SELECT v, t FROM kv WHERE k = ?'),
  put: db.prepare('INSERT INTO kv (k, v, t) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t'),
  owner: db.prepare('SELECT * FROM owners WHERE name = ?'),
  ownerCount: db.prepare('SELECT COUNT(*) AS n FROM owners'),
  addOwner: db.prepare('INSERT INTO owners (name, salt, hash) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET salt = excluded.salt, hash = excluded.hash'),
  addSess: db.prepare('INSERT INTO sessions (sid, role, ref, exp) VALUES (?, ?, ?, ?)'),
  getSess: db.prepare('SELECT * FROM sessions WHERE sid = ?'),
  delSess: db.prepare('DELETE FROM sessions WHERE sid = ?'),
  purge: db.prepare('DELETE FROM sessions WHERE exp < ?'),
};

const PUB = path.join(__dirname, 'public');
const KEYS = new Set(['data', 'rooms']);
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// --- begrenzing van inlogpogingen (beschermt vooral de 6-cijferige gastcodes)
const fails = new Map(); let globalFails = [];
function limited(ip) {
  const now = Date.now(), win = 10 * 60e3;
  const a = (fails.get(ip) || []).filter(t => now - t < win); fails.set(ip, a);
  globalFails = globalFails.filter(t => now - t < 3600e3);
  return a.length >= 8 || globalFails.length >= 60;
}
function failed(ip) { const n = Date.now(); (fails.get(ip) || fails.set(ip, []).get(ip)).push(n); globalFails.push(n); }

function loadData() { const r = q.get.get('data'); try { return r ? JSON.parse(r.v) : null; } catch { return null; } }
function findGuest(id) { const d = loadData(); return d && Array.isArray(d.guests) ? d.guests.find(g => g.id === id) : null; }
const expired = g => g.until && g.until < today();

function cookie(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([a-f0-9]{64})/);
  return m ? m[1] : null;
}
function session(req) {
  const sid = cookie(req); if (!sid) return null;
  const s = q.getSess.get(sha(sid));
  if (!s || s.exp < Date.now()) return null;
  if (s.role === 'guest') { const g = findGuest(s.ref); if (!g || expired(g)) return null; }
  return s;
}
function startSession(req, res, role, ref) {
  q.purge.run(Date.now());
  const sid = crypto.randomBytes(32).toString('hex');
  const days = role === 'owner' ? SESSION_DAYS_OWNER : SESSION_DAYS_GUEST;
  q.addSess.run(sha(sid), role, ref, Date.now() + days * 864e5);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secure}`);
}

// Wat een gast mag zien: alleen zichzelf en de notities voor die gast.
function filterForGuest(d, gid) {
  const g = (d.guests || []).find(x => x.id === gid);
  const out = { ...d };
  out.guests = g ? [{ ...g, code: undefined }] : [];
  out.notes = (d.notes || []).filter(n => (n.to || []).includes(gid));
  delete out.paid; delete out.log; delete out.tasks; delete out.shop; delete out.recipes; delete out.events;
  out.tasks = []; out.log = []; out.shop = []; out.recipes = []; out.events = []; out.paid = {};
  return out;
}

function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); }
function body(req) {
  return new Promise((ok, err) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 20e6) { err(new Error('te groot')); req.destroy(); } });
    req.on('end', () => ok(b));
    req.on('error', err);
  });
}
function file(res, name, type) {
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  fs.createReadStream(path.join(PUB, name)).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
  try {
    const p = url.pathname;
    if (p === '/api/health') return json(res, 200, { ok: true });

    if (p === '/api/me') {
      if (q.ownerCount.get().n === 0) return json(res, 200, { setup: true, owners: OWNERS });
      const s = session(req);
      if (!s) return json(res, 401, { owners: OWNERS });
      if (s.role === 'owner') return json(res, 200, { role: 'owner', name: s.ref });
      const g = findGuest(s.ref);
      return json(res, 200, { role: 'guest', id: g.id, name: g.n });
    }

    if (p === '/api/setup' && req.method === 'POST') {
      if (q.ownerCount.get().n > 0) return json(res, 403, { error: 'Al ingesteld' });
      const b = JSON.parse(await body(req));
      for (const n of OWNERS) if (typeof b[n] !== 'string' || b[n].length < 8) return json(res, 400, { error: 'Elk wachtwoord moet minstens 8 tekens hebben.' });
      for (const n of OWNERS) { const salt = crypto.randomBytes(16).toString('hex'); q.addOwner.run(n, salt, hashPw(b[n], salt)); }
      startSession(req, res, 'owner', OWNERS[0]);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/login' && req.method === 'POST') {
      if (limited(ip)) return json(res, 429, { error: 'Te vaak geprobeerd. Wacht even en probeer het later opnieuw.' });
      const b = JSON.parse(await body(req));
      if (b.code) {
        const d = loadData();
        const code = String(b.code).trim();
        const g = d && (d.guests || []).find(x => x.code && same(x.code, code) && !expired(x));
        if (g) { startSession(req, res, 'guest', g.id); return json(res, 200, { ok: true }); }
      } else if (OWNERS.includes(b.name) && typeof b.password === 'string') {
        const o = q.owner.get(b.name);
        if (o && same(hashPw(b.password, o.salt), o.hash)) { startSession(req, res, 'owner', o.name); return json(res, 200, { ok: true }); }
      }
      failed(ip);
      return json(res, 401, { error: 'Inloggen is niet gelukt. Controleer de gegevens.' });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const sid = cookie(req); if (sid) q.delSess.run(sha(sid));
      res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    const m = p.match(/^\/api\/state\/(\w+)$/);
    if (m) {
      const s = session(req);
      if (!s) return json(res, 401, { error: 'Niet ingelogd' });
      if (!KEYS.has(m[1])) return json(res, 404, { error: 'Onbekend' });
      if (req.method === 'GET') {
        const r = q.get.get(m[1]);
        if (!r) { res.writeHead(204); return res.end(); }
        if (s.role === 'guest' && m[1] === 'data') return json(res, 200, filterForGuest(JSON.parse(r.v), s.ref));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(r.v);
      }
      if (req.method === 'PUT') {
        if (s.role !== 'owner') return json(res, 403, { error: 'Alleen eigenaren mogen opslaan' });
        const b = await body(req); JSON.parse(b);
        q.put.run(m[1], b, Date.now());
        res.writeHead(204); return res.end();
      }
      return json(res, 405, { error: 'Niet toegestaan' });
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'Onbekend' });
    // Pagina's: zonder sessie alleen de loginpagina
    if (!session(req) || q.ownerCount.get().n === 0) return file(res, 'login.html', 'text/html; charset=utf-8');
    return file(res, 'index.html', 'text/html; charset=utf-8');
  } catch (e) {
    json(res, 500, { error: String(e.message) });
  }
}).listen(PORT, () => console.log('Huis-server luistert op poort ' + PORT));
