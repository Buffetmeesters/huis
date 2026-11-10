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
const ADMIN = 'Admin';
const isAdmin = s => !!s && s.role === 'owner' && s.ref === ADMIN;
const SESSION_DAYS_OWNER = 365, SESSION_DAYS_GUEST = 7;
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'huis.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, t INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS owners (name TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, role TEXT NOT NULL, ref TEXT NOT NULL, exp INTEGER NOT NULL);`);
for (const c of ['ua TEXT', 'created INTEGER', 'seen INTEGER']) { try { db.exec('ALTER TABLE sessions ADD COLUMN ' + c); } catch {} }
const q = {
  get: db.prepare('SELECT v, t FROM kv WHERE k = ?'),
  put: db.prepare('INSERT INTO kv (k, v, t) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t'),
  owner: db.prepare('SELECT * FROM owners WHERE name = ?'),
  ownerCount: db.prepare('SELECT COUNT(*) AS n FROM owners'),
  addOwner: db.prepare('INSERT INTO owners (name, salt, hash) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET salt = excluded.salt, hash = excluded.hash'),
  addSess: db.prepare('INSERT INTO sessions (sid, role, ref, exp, ua, created, seen) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  touchSess: db.prepare('UPDATE sessions SET seen = ? WHERE sid = ?'),
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

function turnOnData(entity, b) {
  const data = { entity_id: entity };
  if (Number.isFinite(+b.b) && b.b !== null) data.brightness_pct = Math.min(100, Math.max(1, Math.round(+b.b)));
  if (Number.isFinite(+b.k)) data.color_temp_kelvin = Math.min(10000, Math.max(1500, Math.round(+b.k)));
  else if (Number.isFinite(+b.h) && Number.isFinite(+b.s)) data.hs_color = [Math.min(360, Math.max(0, +b.h)), Math.min(100, Math.max(0, +b.s))];
  return data;
}
function haErr(e) { return /^Home Assistant antwoordde/.test(e.message) ? e.message : 'Geen verbinding met Home Assistant: ' + (e.cause && e.cause.code || e.message); }
function haCfg() { const r = q.get.get('ha'); const c = r ? JSON.parse(r.v) : null; return c && c.url && c.token ? c : null; }
const DEF_ROOMS = [['woon','Woonkamer'],['keuken','Keuken'],['hal','Hal'],['voordeur','Voordeur'],['hal2','Hal bij trap'],['toilet','Toilet'],['tuin','Tuin'],['sl14','Onze slaapkamer'],['sl12','Logeerkamer'],['sl9','Gamekamer'],['bad','Badkamer'],['ol1','Overloop 1e verdieping'],['sl13','Slaapkamer Dennis'],['zolder','Zolder'],['ol2','Overloop zolder']].map(([id, name]) => ({ id, name }));
function roomList() { const r = loadRooms(); return r.length ? r : DEF_ROOMS; }
function loadRooms() { const r = q.get.get('rooms'); try { const x = r ? JSON.parse(r.v) : []; return Array.isArray(x) ? x : []; } catch { return []; } }
async function haCall(cfg, path, payload) {
  const r = await fetch(cfg.url + path, {
    method: payload ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) { let t = ''; try { t = (await r.text()).slice(0, 200); } catch {} throw new Error('Home Assistant antwoordde met ' + r.status + (t ? ': ' + t : '')); }
  return r.json();
}
function cookie(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([a-f0-9]{64})/);
  return m ? m[1] : null;
}
const guestsOn = () => { const r = q.get.get('guestsOn'); try { return r ? JSON.parse(r.v) === true : false; } catch { return false; } };
function session(req) {
  const sid = cookie(req); if (!sid) return null;
  const s = q.getSess.get(sha(sid));
  if (!s || s.exp < Date.now()) return null;
  if (s.role === 'guest') { if (!guestsOn()) return null; const g = findGuest(s.ref); if (!g || expired(g)) return null; }
  if (!s.seen || Date.now() - s.seen > 36e5) { try { q.touchSess.run(Date.now(), s.sid); } catch {} }
  return s;
}
// Alleen thuis: gasten mogen alleen binnen via het thuisnetwerk of met GPS dichtbij het huis.
const geoCfg = () => kvGet('geo') || {};
const normIp = ip => { ip = String(ip || '').replace(/^::ffff:/, ''); return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip; };
const geoOk = new Map();
const distM = (a, b, c, d) => { const R = 6371000, r = x => x * Math.PI / 180, dl = r(c - a), dn = r(d - b), h = Math.sin(dl / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
function isAway(req, s) {
  if (!s || s.role !== 'guest') return false;
  const cfg = geoCfg(); if (!cfg.on || !((cfg.ips || []).length || cfg.lat != null)) return false;
  const g = findGuest(s.ref); if (g && g.anyw) return false;
  const ipn = normIp(req.headers['cf-connecting-ip'] || req.socket.remoteAddress);
  if ((cfg.ips || []).some(x => x.ip === ipn)) return false;
  const sid = cookie(req); if (sid && (geoOk.get(sha(sid)) || 0) > Date.now()) return false;
  return true;
}
function startSession(req, res, role, ref) {
  q.purge.run(Date.now());
  const sid = crypto.randomBytes(32).toString('hex');
  const days = role === 'owner' ? SESSION_DAYS_OWNER : SESSION_DAYS_GUEST;
  q.addSess.run(sha(sid), role, ref, Date.now() + days * 864e5, String(req.headers['user-agent'] || '').slice(0, 300), Date.now(), Date.now());
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secure}`);
}

// Wat een gast mag zien: alleen zichzelf en de notities voor die gast.
function filterForGuest(d, gid) {
  const g = (d.guests || []).find(x => x.id === gid);
  const out = { ...d };
  out.guests = g ? [{ ...g, code: undefined }] : [];
  out.notes = (d.notes || []).filter(n => (n.to || []).includes(gid));
  delete out.gcal; delete out.paid; delete out.log; delete out.recipes; delete out.events;
  const m = (g && g.mod) || {};
  out.tasks = m.taken ? (d.tasks || []) : []; out.shop = m.shop ? (d.shop || []) : []; out.afval = m.afval ? (d.afval || []) : [];
  out.phr = (d.phr || []).map((p, i) => ({ t: p.t, i, id: p.id })).filter(p => p.id && ((g && g.ph) || []).includes(p.id)); delete out.spf; delete out.spl;
  out.log = []; out.recipes = []; out.events = []; out.paid = {};
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


// ---- Google Agenda ----
const kvGet = k => { const r = q.get.get(k); try { return r ? JSON.parse(r.v) : null; } catch { return null; } };
const kvPut = (k, v) => q.put.run(k, JSON.stringify(v), Date.now());
const kvDel = k => db.prepare('DELETE FROM kv WHERE k = ?').run(k);
const G_TOKEN = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const G_API = process.env.GOOGLE_API_URL || 'https://www.googleapis.com/calendar/v3';
const GSCOPE = 'https://www.googleapis.com/auth/calendar';
const gAccess = {};
function gOrigin(req) { const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim(); return proto + '://' + req.headers.host; }
async function gForm(url, data) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error_description || j.error || ('Google antwoordde met ' + r.status)); e.code = j.error; throw e; }
  return j;
}
async function gToken(who) {
  const c = gAccess[who]; if (c && c.exp > Date.now() + 60e3) return c.t;
  const cfg = kvGet('gcfg'), tok = kvGet('gtok:' + who);
  if (!cfg || !tok) throw new Error('Google Agenda is niet gekoppeld voor ' + who);
  try {
    const j = await gForm(G_TOKEN, { client_id: cfg.id, client_secret: cfg.secret, refresh_token: tok.refresh, grant_type: 'refresh_token' });
    gAccess[who] = { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return j.access_token;
  } catch (e) {
    if (e.code === 'invalid_grant') { kvDel('gtok:' + who); delete gAccess[who]; throw new Error('De koppeling van ' + who + ' met Google is verlopen. Koppel opnieuw.'); }
    throw e;
  }
}
async function gApi(who, method, path_, bodyObj) {
  const t = await gToken(who);
  const r = await fetch(G_API + path_, { method, headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: bodyObj ? JSON.stringify(bodyObj) : undefined });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google Agenda: ' + ((j.error && j.error.message) || r.status));
  return j;
}
const gConnected = () => OWNERS.filter(n => kvGet('gtok:' + n));

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
  try {
    const p = url.pathname;
    if (p === '/api/health') return json(res, 200, { ok: true });
    if (p.startsWith('/api/') && !['/api/me', '/api/login', '/api/logout', '/api/geo'].includes(p)) {
      const s0 = session(req); if (isAway(req, s0)) return json(res, 403, { error: 'Alleen thuis', away: true });
    }
    if (p === '/api/geo' && req.method === 'POST') {
      const s = session(req); if (!s) return json(res, 401, { error: 'Niet ingelogd' });
      const b = JSON.parse(await body(req)), cfg = geoCfg();
      if (cfg.lat == null || typeof b.lat !== 'number' || typeof b.lon !== 'number') return json(res, 200, { ok: false, reden: cfg.lat == null ? 'Het huis heeft nog geen locatie.' : 'Geen locatie ontvangen.' });
      const acc = Math.min(Math.max(+b.acc || 0, 0), 100), dm = Math.round(distM(cfg.lat, cfg.lon, b.lat, b.lon));
      if (dm - acc <= (cfg.radius || 150)) { const sid = cookie(req); if (sid) geoOk.set(sha(sid), Date.now() + 10 * 60e3); return json(res, 200, { ok: true }); }
      return json(res, 200, { ok: false, afstand: dm });
    }
    if (p === '/api/geo/cfg') {
      const s = session(req); if (!isAdmin(s)) return json(res, 403, { error: 'Alleen de beheerder' });
      let c = geoCfg();
      if (req.method === 'PUT') {
        const b = JSON.parse(await body(req)); c = { ...c, ips: c.ips || [] };
        if (typeof b.on === 'boolean') c.on = b.on;
        if (b.radius) c.radius = Math.min(Math.max(+b.radius || 150, 30), 2000);
        if (typeof b.lat === 'number' && typeof b.lon === 'number') { c.lat = b.lat; c.lon = b.lon; }
        if (b.addNet) { const ipn = normIp(ip); if (!c.ips.some(x => x.ip === ipn)) c.ips.push({ ip: ipn, d: new Date().toISOString().slice(0, 10) }); c.ips = c.ips.slice(-5); }
        if (typeof b.delIp === 'string') c.ips = c.ips.filter(x => x.ip !== b.delIp);
        kvPut('geo', c);
      }
      return json(res, 200, { on: !!c.on, lat: c.lat ?? null, lon: c.lon ?? null, radius: c.radius || 150, ips: c.ips || [], me: normIp(ip) });
    }

    if (p === '/api/me') {
      if (q.ownerCount.get().n === 0) return json(res, 200, { setup: true, owners: OWNERS, guests: guestsOn() });
      const s = session(req);
      const names = db.prepare('SELECT name FROM owners ORDER BY name = ?, name').all(ADMIN).map(r => r.name);
      if (!s) return json(res, 401, { owners: names, guests: guestsOn() });
      if (s.role === 'owner') return json(res, 200, { role: 'owner', guests: guestsOn(), name: s.ref, admin: isAdmin(s), canCreateAdmin: s.ref === 'Joshua' && !q.owner.get(ADMIN) });
      const g = findGuest(s.ref);
      return json(res, 200, { role: 'guest', id: g.id, name: g.n, away: isAway(req, s), geo: !!geoCfg().on });
    }

    if (p === '/api/setup' && req.method === 'POST') {
      if (q.ownerCount.get().n > 0) return json(res, 403, { error: 'Al ingesteld' });
      const b = JSON.parse(await body(req));
      for (const n of OWNERS) if (typeof b[n] !== 'string' || b[n].length < 8) return json(res, 400, { error: 'Elk wachtwoord moet minstens 8 tekens hebben.' });
      const mk = n => { const salt = crypto.randomBytes(16).toString('hex'); q.addOwner.run(n, salt, hashPw(b[n], salt)); };
      for (const n of OWNERS) mk(n);
      if (typeof b[ADMIN] === 'string' && b[ADMIN].length >= 8) mk(ADMIN);
      startSession(req, res, 'owner', OWNERS[0]);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/login' && req.method === 'POST') {
      if (limited(ip)) return json(res, 429, { error: 'Te vaak geprobeerd. Wacht even en probeer het later opnieuw.' });
      const b = JSON.parse(await body(req));
      if (b.code) {
        if (!guestsOn()) { failed(ip); return json(res, 403, { error: 'Toegang staat uit.' }); }
        const d = loadData();
        const code = String(b.code).trim();
        const g = d && (d.guests || []).find(x => x.code && same(x.code, code) && !expired(x));
        if (g) { startSession(req, res, 'guest', g.id); return json(res, 200, { ok: true }); }
      } else if (typeof b.name === 'string' && typeof b.password === 'string') {
        const o = q.owner.get(b.name);
        if (o && same(hashPw(b.password, o.salt), o.hash)) { startSession(req, res, 'owner', o.name); return json(res, 200, { ok: true }); }
      }
      failed(ip);
      return json(res, 401, { error: 'Inloggen is niet gelukt. Controleer de gegevens.' });
    }

    if (p === '/api/guests/enabled') {
      const s = session(req);
      if (!s || s.role !== 'owner') return json(res, 403, { error: 'Alleen Joshua en Lorenzo' });
      if (req.method === 'PUT') {
        const b = JSON.parse(await body(req));
        kvPut('guestsOn', b.on === true);
        if (b.on !== true) db.prepare("DELETE FROM sessions WHERE role = 'guest'").run();
      }
      return json(res, 200, { on: guestsOn() });
    }
    if (p === '/api/sessions') {
      const s = session(req);
      if (!s || s.role !== 'owner') return json(res, 403, { error: 'Alleen Joshua en Lorenzo' });
      const me = sha(cookie(req));
      if (req.method === 'DELETE') {
        const b = JSON.parse(await body(req));
        if (b.others) { db.prepare("DELETE FROM sessions WHERE role = 'owner' AND ref = ? AND sid != ?").run(s.ref, me); return json(res, 200, { ok: true }); }
        const row = db.prepare("SELECT sid FROM sessions WHERE role = 'owner' AND ref = ? AND substr(sid, 1, 12) = ?").get(s.ref, String(b.id || ''));
        if (!row) return json(res, 404, { error: 'Apparaat niet gevonden' });
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
        return json(res, 200, { ok: true });
      }
      const dev = ua => { ua = String(ua || ''); const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone of iPad' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Onbekend apparaat'; const br = /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Edg\//.test(ua) ? 'Edge' : /Firefox/.test(ua) ? 'Firefox' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : ''; return br ? os + ' · ' + br : os; };
      const rows = db.prepare("SELECT sid, ua, created, seen, exp FROM sessions WHERE role = 'owner' AND ref = ? AND exp > ? ORDER BY seen DESC").all(s.ref, Date.now());
      return json(res, 200, { sessions: rows.map(r => ({ id: r.sid.slice(0, 12), apparaat: dev(r.ua), sinds: r.created || null, gezien: r.seen || null, nu: r.sid === me })) });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const sid = cookie(req); if (sid) q.delSess.run(sha(sid));
      res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    if (p === '/api/guest/act' && req.method === 'POST') {
      const s = session(req);
      if (!s || s.role !== 'guest') return json(res, 403, { error: 'Alleen voor gasten' });
      const g = findGuest(s.ref); const b = JSON.parse(await body(req));
      const r = q.get.get('data'); const d = r ? JSON.parse(r.v) : null;
      if (!g || !d) return json(res, 404, { error: 'Niet gevonden' });
      const m = g.mod || {}; const today = new Date().toISOString().slice(0, 10);
      if (b.k === 'task' && m.taken) {
        const t = (d.tasks || []).find(x => x.id === b.id); if (!t) return json(res, 404, { error: 'Taak niet gevonden' });
        if (!t.by) { t.by = g.n; t.next = t.rep && /^\d{4}-\d\d-\d\d$/.test(b.next || '') ? b.next : ''; d.log = d.log || []; d.log.push({ tid: t.id, w: g.n, p: t.p, d: today, n: t.n }); }
        else if (t.by === g.n) { t.by = ''; t.next = ''; const x = (d.log || []).map(e => e.tid).lastIndexOf(t.id); if (x >= 0) d.log.splice(x, 1); }
        else return json(res, 403, { error: 'Alleen jezelf terugzetten' });
      } else if (b.k === 'shop' && m.shop) {
        const it = (d.shop || [])[b.i]; if (!it) return json(res, 404, { error: 'Niet gevonden' });
        it.g = it.g ? 0 : 1;
      } else if (b.k === 'afval' && m.afval) {
        const e = (d.afval || []).find(x => x.t === b.t && x.d === b.d); if (!e) return json(res, 404, { error: 'Niet gevonden' });
        if (!e.by) e.by = g.n; else if (e.by === g.n) delete e.by; else return json(res, 403, { error: 'Alleen jezelf terugzetten' });
      } else return json(res, 403, { error: 'Geen toegang' });
      q.put.run('data', JSON.stringify(d), Date.now());
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

    if (p === '/api/guest/say' && req.method === 'POST') {
      const s = session(req);
      if (!s || s.role !== 'guest') return json(res, 403, { error: 'Alleen voor gasten' });
      const g = findGuest(s.ref), d = loadData(), cfg = haCfg(), b = JSON.parse(await body(req));
      if (!g || !d || !(g.ph && g.ph.length)) return json(res, 403, { error: 'Geen toegang' });
      const ph = (d.phr || [])[b.i]; if (!ph || !ph.id || !g.ph.includes(ph.id)) return json(res, 403, { error: 'Deze zin mag niet' });
      if (!cfg) return json(res, 400, { error: 'Home Assistant is nog niet ingesteld.' });
      const spf = d.spf || {}, fl = ph.fl || [];
      const targets = (d.spl || []).filter(x => /^media_player\.[\w]+$/.test(x) && (spf[x] == null || fl.includes(spf[x]))).slice(0, 20);
      if (!targets.length) return json(res, 400, { error: 'Geen boxen beschikbaar.' });
      try {
        const r = await fetch(cfg.url + '/api/states', { headers: { Authorization: 'Bearer ' + cfg.token }, signal: AbortSignal.timeout(8000) });
        const all = await r.json(); const tts = all.map(e => e.entity_id).filter(id => id.startsWith('tts.'));
        const pick = tts.find(id => id.includes('google')) || tts[0];
        if (!pick) return json(res, 400, { error: 'Geen spraakdienst in Home Assistant.' });
        for (const t of targets) await haCall(cfg, '/api/services/tts/speak', { entity_id: pick, media_player_entity_id: t, message: String(ph.t).slice(0, 500), language: 'nl' });
        return json(res, 200, { ok: true, speakers: targets.length });
      } catch (e) { return json(res, 502, { error: haErr(e) }); }
    }

    if (p === '/api/hscene' && req.method === 'POST') {
      const s = session(req);
      if (!s) return json(res, 401, { error: 'Niet ingelogd' });
      const cfg = haCfg(); if (!cfg) return json(res, 400, { error: 'Home Assistant is nog niet ingesteld.' });
      const b = JSON.parse(await body(req));
      const d = loadData();
      const sc = d && (d.scn || []).find(x => x.id === b.id && x.hue);
      if (!sc) return json(res, 404, { error: 'Scène niet gevonden' });
      if (s.role !== 'owner') {
        const room = loadRooms().find(r => r.id === sc.room);
        const g = findGuest(s.ref);
        if (!room || room.own || !g || expired(g) || !(g.rp && g.rp[room.id] && g.rp[room.id].sfeer)) return json(res, 403, { error: 'Geen toegang tot deze scène' });
      }
      if (!/^scene\.[\w]+$/.test(sc.hue)) return json(res, 400, { error: 'Ongeldige scène' });
      try { await haCall(cfg, '/api/services/scene/turn_on', { entity_id: sc.hue }); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 502, { error: haErr(e) }); }
    }
    if (p === '/api/film') {
      const s = session(req);
      if (!s) return json(res, 401, { error: 'Niet ingelogd' });
      if (s.role !== 'owner') {
        const g = findGuest(s.ref);
        if (!(g && !expired(g) && g.rp && g.rp.woon && g.rp.woon.film)) return json(res, 403, { error: 'Geen toegang tot Film kijken' });
      }
      const fc = kvGet('film'), fs0 = kvGet('filmstate');
      const ready = !!(fc && ((fc.lights && fc.lights.length) || (fc.sync && fc.sync.length)));
      if (req.method !== 'POST') return json(res, 200, { on: !!(fs0 && fs0.on), ready });
      const cfg = haCfg(); if (!cfg) return json(res, 400, { error: 'Home Assistant is nog niet ingesteld.' });
      if (!ready) return json(res, 400, { error: 'Film kijken is nog niet ingesteld. Kies de lampen en de Sync Box op de Admin-pagina.' });
      const b = JSON.parse(await body(req));
      const errs = [];
      const call = async (svc, data) => { try { await haCall(cfg, '/api/services/' + svc, data); return true; } catch (e) { errs.push(haErr(e)); return false; } };
      try {
        if (b.on) {
          if (fs0 && fs0.on) return json(res, 200, { on: true });
          const st = new Map((await haCall(cfg, '/api/states')).map(e => [e.entity_id, e]));
          const saved = fc.lights.map(id => { const e = st.get(id); const a = e ? e.attributes : {}; return { id, on: !!e && e.state === 'on', bri: a.brightness || null, mode: a.color_mode || null, k: a.color_temp_kelvin || null, xy: a.xy_color || null }; });
          kvPut('filmstate', { on: true, saved, at: Date.now() });
          for (const l of fc.lights) {
            if (fc.bri <= 0) await call('light/turn_off', { entity_id: l });
            else if (!(await (async () => { try { await haCall(cfg, '/api/services/light/turn_on', { entity_id: l, brightness_pct: fc.bri, color_temp_kelvin: 2200 }); return true; } catch { return false; } })())) await call('light/turn_on', { entity_id: l, brightness_pct: fc.bri });
          }
          for (const x of fc.sync) await call('homeassistant/turn_on', { entity_id: x });
        } else {
          for (const x of fc.sync) await call('homeassistant/turn_off', { entity_id: x });
          for (const l of (fs0 && fs0.saved) || []) {
            if (!l.on) { await call('light/turn_off', { entity_id: l.id }); continue; }
            const d = { entity_id: l.id };
            if (l.bri) d.brightness = l.bri;
            if (l.mode === 'color_temp' && l.k) d.color_temp_kelvin = l.k; else if (l.xy) d.xy_color = l.xy;
            if (!(await (async () => { try { await haCall(cfg, '/api/services/light/turn_on', d); return true; } catch { return false; } })())) await call('light/turn_on', { entity_id: l.id, brightness: l.bri || 255 });
          }
          kvDel('filmstate');
        }
      } catch (e) { errs.push(haErr(e)); }
      return json(res, errs.length ? 502 : 200, errs.length ? { error: errs[0], on: !!b.on } : { on: !!b.on });
    }
    if (p === '/api/sensors') {
      const s = session(req);
      if (!s || s.role !== 'owner') return json(res, 403, { error: 'Alleen Joshua en Lorenzo' });
      const cfg = haCfg(); if (!cfg) return json(res, 400, { error: 'Home Assistant is nog niet ingesteld.' });
      try {
        const st = new Map((await haCall(cfg, '/api/states')).map(e => [e.entity_id, e]));
        const links = kvGet('sensors') || {};
        const num = id => { const e = id && st.get(id); const v = e ? parseFloat(e.state) : NaN; return Number.isFinite(v) ? v : null; };
        const out = {};
        for (const [room, l] of Object.entries(links)) {
          const m = st.get(l.m);
          out[room] = { m: m ? (m.state === 'on' ? true : m.state === 'off' ? false : null) : null, mt: m ? m.last_changed : null, t: num(l.t), lx: num(l.lx), bat: num(l.bat), ok: !!m };
        }
        return json(res, 200, { sensors: out });
      } catch (e) { return json(res, 502, { error: haErr(e) }); }
    }
    if (p === '/api/lights' || p === '/api/light' || p === '/api/apply' || p === '/api/climate') {
      const s = session(req);
      if (!s) return json(res, 401, { error: 'Niet ingelogd' });
      const cfg = haCfg();
      if (!cfg) return json(res, 200, { lights: {} });
      const rooms = loadRooms();
      const allowedKey = (room, key) => {
        if (s.role === 'owner') return true;
        if (room.own) return false;
        const g = findGuest(s.ref);
        return !!(g && !expired(g) && g.rp && g.rp[room.id] && g.rp[room.id][key]);
      };
      const allowed = (room, light) => {
        if (s.role === 'owner') return true;
        if (room.own) return false;
        const g = findGuest(s.ref);
        return !!(g && !expired(g) && g.rp && g.rp[room.id] && g.rp[room.id].licht);
      };
      try {
        if (p === '/api/lights' && req.method === 'GET') {
          const all = await haCall(cfg, '/api/states');
          const st = new Map(all.map(e => [e.entity_id, e]));
          const out = {};
          for (const room of rooms) room.lights.forEach(l => {
            if (!l.e || !allowed(room, l)) return;
            const e = st.get(l.e); if (!e) return;
            const br = e.attributes && e.attributes.brightness;
            out[room.id + ':' + room.lights.indexOf(l)] = { on: e.state === 'on', b: br ? Math.max(1, Math.round(br / 2.55)) : null, bad: e.state === 'unavailable', cm: e.attributes.supported_color_modes || [], hs: e.attributes.hs_color || null, k: e.attributes.color_temp_kelvin || null };
          });
          return json(res, 200, { lights: out });
        }
        if (p === '/api/climate' && req.method === 'GET') {
          const all = await haCall(cfg, '/api/states');
          const st = new Map(all.map(e => [e.entity_id, e]));
          const out = {};
          for (const room of rooms) {
            if (!room.ce || !allowedKey(room, 'klimaat')) continue;
            const e = st.get(room.ce); if (!e) continue;
            const a = e.attributes || {};
            out[room.id] = { mode: e.state, modes: a.hvac_modes || [], fan: a.fan_mode ?? null, fans: a.fan_modes || [], swing: a.swing_mode ?? null, swings: a.swing_modes || [], cur: a.current_temperature ?? null, set: a.temperature ?? null, min: a.min_temp ?? null, max: a.max_temp ?? null, step: a.target_temp_step || a.temp_step || null };
          }
          return json(res, 200, { climate: out });
        }
        if (p === '/api/climate' && req.method === 'POST') {
          const b = JSON.parse(await body(req));
          const room = rooms.find(r => r.id === b.room);
          if (!room || !room.ce) return json(res, 404, { error: 'Airco is niet gekoppeld' });
          if (!allowedKey(room, 'klimaat')) return json(res, 403, { error: 'Geen toegang tot deze airco' });
          const e = (await haCall(cfg, '/api/states/' + room.ce));
          const a = e.attributes || {};
          const svc = (n, d) => haCall(cfg, '/api/services/climate/' + n, Object.assign({ entity_id: room.ce }, d));
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          const waitFor = async (test, what) => {
            let st = null;
            for (let k = 0; k < 6; k++) { await sleep(1500); st = await haCall(cfg, '/api/states/' + room.ce); if (test(st)) return null; }
            const x = st.attributes || {};
            console.log('airco', room.ce, 'bleef', st.state, x.temperature, x.fan_mode, x.swing_mode, 'na', what);
            return 'De airco neemt het niet over (' + what + '). Hij meldt nog: ' + st.state + (x.temperature != null ? ', ' + x.temperature + ' °C' : '') + '. Home Assistant gaf zelf geen foutmelding.';
          };
          console.log('airco opdracht', JSON.stringify(b), 'nu', e.state, a.temperature);
          let bad = null;
          if (typeof b.mode === 'string') {
            if (b.mode === 'off') { try { await svc('turn_off', {}); } catch (err) { await svc('set_hvac_mode', { hvac_mode: 'off' }); } bad = await waitFor(st => st.state === 'off', 'uitzetten'); }
            else {
              if (!(a.hvac_modes || []).includes(b.mode)) return json(res, 400, { error: 'Deze stand kent de airco niet' });
              await svc('set_hvac_mode', { hvac_mode: b.mode }); bad = await waitFor(st => st.state === b.mode, 'stand ' + b.mode);
            }
          } else if (typeof b.fan === 'string') {
            if (!(a.fan_modes || []).includes(b.fan)) return json(res, 400, { error: 'Deze ventilatiestand kent de airco niet' });
            await svc('set_fan_mode', { fan_mode: b.fan }); bad = await waitFor(st => (st.attributes || {}).fan_mode === b.fan, 'ventilatie ' + b.fan);
          } else if (typeof b.swing === 'boolean') {
            const sm = a.swing_modes || [];
            const offM = sm.find(m => /^off$/i.test(m)) || sm[0];
            const onM = ['on', 'both', 'vertical', 'horizontal'].map(w => sm.find(m => m.toLowerCase() === w)).find(Boolean) || sm.find(m => m !== offM);
            const want = b.swing ? onM : offM;
            if (!want) return json(res, 400, { error: 'Deze airco heeft geen swing' });
            await svc('set_swing_mode', { swing_mode: want }); bad = await waitFor(st => (st.attributes || {}).swing_mode === want, 'swing ' + want);
          } else {
            if (b.on === true && e.state === 'off') {
              const modes = a.hvac_modes || [];
              const pick = ['cool', 'heat_cool', 'auto', 'heat'].find(m => modes.includes(m)) || modes.find(m => m !== 'off');
              if (pick) { await svc('set_hvac_mode', { hvac_mode: pick }); bad = await waitFor(st => st.state !== 'off', 'aanzetten'); }
            } else if (b.on === false && e.state !== 'off') {
              try { await svc('turn_off', {}); } catch (err) { await svc('set_hvac_mode', { hvac_mode: 'off' }); }
              bad = await waitFor(st => st.state === 'off', 'uitzetten');
            }
            if (!bad && b.on !== false && b.temp !== undefined && b.temp !== null && Number.isFinite(+b.temp)) {
              const lo = a.min_temp ?? 10, hi = a.max_temp ?? 35;
              const t = Math.min(hi, Math.max(lo, +b.temp));
              try { await svc('set_temperature', { temperature: t }); }
              catch (err) { if (e.state === 'off') throw err; await svc('set_temperature', { temperature: t, hvac_mode: e.state }); }
              bad = await waitFor(st => Math.abs(+((st.attributes || {}).temperature) - t) < 0.01, 'temperatuur ' + t);
            }
          }
          if (bad) return json(res, 502, { error: bad });
          return json(res, 200, { ok: true });
        }
        if (p === '/api/light' && req.method === 'POST') {
          const b = JSON.parse(await body(req));
          const room = rooms.find(r => r.id === b.room);
          const light = room && room.lights[b.i | 0];
          if (!light || !light.e) return json(res, 404, { error: 'Lamp is niet gekoppeld' });
          if (!allowed(room, light)) return json(res, 403, { error: 'Geen toegang tot deze lamp' });
          if (b.on === false) await haCall(cfg, '/api/services/light/turn_off', { entity_id: light.e });
          else await haCall(cfg, '/api/services/light/turn_on', turnOnData(light.e, b));
          return json(res, 200, { ok: true });
        }
        if (p === '/api/apply' && req.method === 'POST') {
          const b = JSON.parse(await body(req));
          const ok = new Set();
          for (const room of rooms) room.lights.forEach(l => { if (l.e && allowed(room, l)) ok.add(l.e); });
          let done = 0, skipped = 0;
          for (const it of (Array.isArray(b.items) ? b.items.slice(0, 100) : [])) {
            if (!it || !ok.has(it.e)) { skipped++; continue; }
            if (it.on === false) await haCall(cfg, '/api/services/light/turn_off', { entity_id: it.e });
            else await haCall(cfg, '/api/services/light/turn_on', turnOnData(it.e, it));
            done++;
          }
          return json(res, 200, { ok: true, done, skipped });
        }
      } catch (e) { return json(res, 502, { error: haErr(e) }); }
      return json(res, 405, { error: 'Niet toegestaan' });
    }

    if (p === '/api/google/callback') {
      const st = url.searchParams.get('state'), code = url.searchParams.get('code');
      const nonce = st && kvGet('gstate:' + st);
      if (st) kvDel('gstate:' + st);
      const back = '/?google=';
      if (!nonce || nonce.exp < Date.now()) { res.writeHead(302, { location: back + 'verlopen' }); return res.end(); }
      if (!code) { res.writeHead(302, { location: back + 'geweigerd' }); return res.end(); }
      try {
        const cfg = kvGet('gcfg');
        const j = await gForm(G_TOKEN, { code, client_id: cfg.id, client_secret: cfg.secret, redirect_uri: nonce.redir, grant_type: 'authorization_code' });
        if (!j.refresh_token) { res.writeHead(302, { location: back + 'geenrefresh' }); return res.end(); }
        kvPut('gtok:' + nonce.ref, { refresh: j.refresh_token, at: Date.now() });
        delete gAccess[nonce.ref];
        res.writeHead(302, { location: back + 'ok' }); return res.end();
      } catch (e) { console.log('google callback', e.message); res.writeHead(302, { location: back + 'fout' }); return res.end(); }
    }
    if (p === '/api/google/config') {
      const s = session(req);
      if (!isAdmin(s)) return json(res, 403, { error: 'Alleen de beheerder' });
      const cfg = kvGet('gcfg') || {};
      if (req.method === 'GET') return json(res, 200, { idSet: !!cfg.id, secretSet: !!cfg.secret, redirect: 'https://huis.huizecpvh.nl/api/google/callback' });
      if (req.method === 'PUT') {
        const b = JSON.parse(await body(req));
        const id = String(b.id || cfg.id || '').trim(), secret = String(b.secret || cfg.secret || '').trim();
        if (!/^[\w\-]+\.apps\.googleusercontent\.com$/.test(id)) return json(res, 400, { error: 'Dat lijkt geen client-ID. Het eindigt op .apps.googleusercontent.com' });
        if (secret.length < 10) return json(res, 400, { error: 'Vul het client-geheim in.' });
        kvPut('gcfg', { id, secret });
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'Niet toegestaan' });
    }
    if (p.startsWith('/api/google/') || p === '/api/agenda' || p.startsWith('/api/agenda/')) {
      const s = session(req);
      if (!s || s.role !== 'owner' || !OWNERS.includes(s.ref)) return json(res, 403, { error: 'Alleen Joshua en Lorenzo' });
      try {
        if (p === '/api/google/status') {
          const cfg = kvGet('gcfg');
          return json(res, 200, { configured: !!(cfg && cfg.id && cfg.secret), me: s.ref, connected: gConnected() });
        }
        if (p === '/api/google/auth') {
          const cfg = kvGet('gcfg');
          if (!cfg || !cfg.id) return json(res, 400, { error: 'De beheerder moet eerst het client-ID en geheim invullen op de beheerpagina.' });
          const nonce = crypto.randomBytes(16).toString('hex'), redir = gOrigin(req) + '/api/google/callback';
          kvPut('gstate:' + nonce, { ref: s.ref, exp: Date.now() + 10 * 60e3, redir });
          const u = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: cfg.id, redirect_uri: redir, response_type: 'code', scope: GSCOPE, access_type: 'offline', prompt: 'consent', state: nonce }).toString();
          return json(res, 200, { url: u, redirect: redir });
        }
        if (p === '/api/google/disconnect' && req.method === 'POST') { kvDel('gtok:' + s.ref); delete gAccess[s.ref]; return json(res, 200, { ok: true }); }
        if (p === '/api/agenda' && req.method === 'GET') {
          const from = url.searchParams.get('from'), to = url.searchParams.get('to');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return json(res, 400, { error: 'Datum ontbreekt' });
          const out = [], errors = [], calsAll = new Map();
          for (const who of gConnected()) {
            try {
              const cl = await gApi(who, 'GET', '/users/me/calendarList?minAccessRole=reader&maxResults=50');
              const cals = (cl.items || []).filter(c => c.selected !== false && !/#(holiday|contacts)@group\.v\.calendar\.google\.com$/.test(c.id)).slice(0, 8);
              for (const c of cals) {
                if (!calsAll.has(c.id)) calsAll.set(c.id, { id: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || '', role: c.accessRole || '' });
                const ev = await gApi(who, 'GET', '/calendars/' + encodeURIComponent(c.id) + '/events?' + new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '100', timeMin: from + 'T00:00:00Z', timeMax: to + 'T23:59:59Z' }).toString());
                for (const e of ev.items || []) {
                  if (e.status === 'cancelled') continue;
                  const allDay = !!(e.start && e.start.date);
                  const st = allDay ? e.start.date : (e.start && e.start.dateTime) || '';
                  if (!st) continue;
                  let d, t = '';
                  if (allDay) d = st; else { const dd = new Date(st); const f = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(dd); d = f.slice(0, 10); t = f.slice(11, 16); }
                  let t2 = '';
                  if (!allDay && e.end && e.end.dateTime) t2 = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' }).format(new Date(e.end.dateTime));
                  const d2 = allDay && e.end && e.end.date ? (() => { const x = new Date(e.end.date + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); })() : '';
                  out.push({ id: e.id, who, d2, calId: c.id, cal: c.summaryOverride || c.summary || '', color: c.backgroundColor || '', d, t, t2, allDay, wie: (e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.wie) || '', n: e.summary || '(zonder titel)', loc: e.location || '', canEdit: ['owner', 'writer'].includes(c.accessRole) });
                }
              }
            } catch (e) { errors.push(e.message); }
          }
          const seen = new Set(), uniq = out.filter(e => { const k = e.calId + '|' + e.id; if (seen.has(k)) return false; seen.add(k); return true; });
          uniq.sort((a, b) => (a.d + (a.t || '00:00')).localeCompare(b.d + (b.t || '00:00')));
          return json(res, 200, { calendars: [...calsAll.values()], events: uniq, errors, connected: gConnected() });
        }
        if (p === '/api/agenda/add' && req.method === 'POST') {
          const b = JSON.parse(await body(req));
          const who = OWNERS.includes(b.who) ? b.who : s.ref;
          if (!gConnected().includes(who)) return json(res, 400, { error: 'Google Agenda van ' + who + ' is niet gekoppeld' });
          const title = String(b.title || '').trim().slice(0, 200);
          if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) return json(res, 400, { error: 'Titel en datum zijn nodig' });
          let ev;
          const last = /^\d{4}-\d{2}-\d{2}$/.test(b.end || '') && b.end > b.date ? b.end : b.date;
          if (!b.time || b.allday || last !== b.date) {
            const nx = new Date(last + 'T12:00:00Z'); nx.setUTCDate(nx.getUTCDate() + 1);
            ev = { summary: title, start: { date: b.date }, end: { date: nx.toISOString().slice(0, 10) } };
          } else {
            if (!/^\d{2}:\d{2}$/.test(b.time)) return json(res, 400, { error: 'Tijd klopt niet' });
            let end = /^\d{2}:\d{2}$/.test(b.end || '') && b.end > b.time ? b.end : null;
            if (!end) { const h = (+b.time.slice(0, 2) + 1) % 24; end = (h === 0 ? '23:59' : String(h).padStart(2, '0') + b.time.slice(2)); }
            ev = { summary: title, start: { dateTime: b.date + 'T' + b.time + ':00', timeZone: 'Europe/Amsterdam' }, end: { dateTime: b.date + 'T' + end + ':00', timeZone: 'Europe/Amsterdam' } };
          }
          if (b.loc) ev.location = String(b.loc).slice(0, 200);
          if (b.wie) ev.extendedProperties = { private: { wie: String(b.wie).slice(0, 40) } };
          const cal = /^[\w.@#\-]{3,200}$/.test(String(b.cal || '')) ? String(b.cal) : 'primary';
          await gApi(who, 'POST', '/calendars/' + encodeURIComponent(cal) + '/events', ev);
          return json(res, 200, { ok: true });
        }
        if (p === '/api/agenda/wie' && req.method === 'POST') {
          const b = JSON.parse(await body(req));
          if (!OWNERS.includes(b.who) || !gConnected().includes(b.who)) return json(res, 400, { error: 'Onbekend account' });
          await gApi(b.who, 'PATCH', '/calendars/' + encodeURIComponent(String(b.calId)) + '/events/' + encodeURIComponent(String(b.id)), { extendedProperties: { private: { wie: String(b.wie || '').slice(0, 40) } } });
          return json(res, 200, { ok: true });
        }
        if (p === '/api/agenda/del' && req.method === 'POST') {
          const b = JSON.parse(await body(req));
          if (!OWNERS.includes(b.who) || !gConnected().includes(b.who)) return json(res, 400, { error: 'Onbekend account' });
          await gApi(b.who, 'DELETE', '/calendars/' + encodeURIComponent(String(b.calId)) + '/events/' + encodeURIComponent(String(b.id)));
          return json(res, 200, { ok: true });
        }
      } catch (e) { return json(res, 502, { error: e.message }); }
      return json(res, 404, { error: 'Onbekend' });
    }
    if (p === '/api/cf/token') {
      const s = session(req);
      if (!isAdmin(s)) return json(res, 403, { error: 'Alleen de beheerder' });
      const f = path.join(DATA, 'cf-token');
      if (req.method === 'GET') return json(res, 200, { set: fs.existsSync(f) });
      if (req.method === 'PUT') {
        const b = JSON.parse(await body(req));
        const t = String(b.token || '').trim().split(/\s+/).pop();
        if (!/^[A-Za-z0-9_=\-]{50,}$/.test(t)) return json(res, 400, { error: 'Dat lijkt geen tunneltoken. Plak alleen de lange tekst die begint met eyJ.' });
        fs.writeFileSync(f, t, { mode: 0o644 });
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'Niet toegestaan' });
    }
    if (p.startsWith('/api/admin/')) {
      const s = session(req);
      if (p === '/api/admin/create' && req.method === 'POST') {
        if (!s || s.role !== 'owner' || s.ref !== 'Joshua') return json(res, 403, { error: 'Alleen Joshua kan de beheerder instellen.' });
        if (q.owner.get(ADMIN)) return json(res, 409, { error: 'Er is al een beheerder.' });
        const b = JSON.parse(await body(req));
        if (typeof b.password !== 'string' || b.password.length < 8) return json(res, 400, { error: 'Het wachtwoord moet minstens 8 tekens hebben.' });
        const salt = crypto.randomBytes(16).toString('hex'); q.addOwner.run(ADMIN, salt, hashPw(b.password, salt));
        return json(res, 200, { ok: true });
      }
      if (!isAdmin(s)) return json(res, 403, { error: 'Alleen de beheerder' });
      if (p === '/api/admin/info') {
        let size = 0; try { size = fs.statSync(path.join(DATA, 'huis.db')).size; } catch {}
        return json(res, 200, { node: process.version, uptimeMin: Math.round(process.uptime() / 60), dbKB: Math.round(size / 1024), accounts: db.prepare('SELECT name FROM owners').all().map(r => r.name) });
      }
      if (p === '/api/admin/scan' && req.method === 'POST') {
        const b = JSON.parse(await body(req));
        const m = String(b.prefix || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\.\d{0,3})?$/);
        if (!m || [m[1], m[2], m[3]].some(x => +x > 255)) return json(res, 400, { error: 'Vul de eerste drie getallen van je netwerk in, bijvoorbeeld 192.168.1' });
        const prefix = m[1] + '.' + m[2] + '.' + m[3], hits = [], jobs = [];
        for (let i = 1; i <= 254; i++) for (const port of [8123, 80]) jobs.push([prefix + '.' + i, port]);
        let k = 0;
        const worker = async () => { while (k < jobs.length) { const [ip, port] = jobs[k++]; try { const r = await fetch('http://' + ip + ':' + port + '/api/', { signal: AbortSignal.timeout(700) }); const t = await r.text(); if (r.status === 401 && /Unauthorized/i.test(t)) hits.push(port === 80 ? 'http://' + ip : 'http://' + ip + ':' + port); } catch {} } };
        await Promise.all(Array.from({ length: 80 }, worker));
        return json(res, 200, { gevonden: hits.sort() });
      }
      if (p === '/api/admin/reset' && req.method === 'POST') {
        const b = JSON.parse(await body(req));
        if (!OWNERS.includes(b.name)) return json(res, 400, { error: 'Onbekend account' });
        if (typeof b.password !== 'string' || b.password.length < 8) return json(res, 400, { error: 'Het wachtwoord moet minstens 8 tekens hebben.' });
        const salt = crypto.randomBytes(16).toString('hex'); q.addOwner.run(b.name, salt, hashPw(b.password, salt));
        db.prepare("DELETE FROM sessions WHERE role = 'owner' AND ref = ?").run(b.name);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Onbekend' });
    }
    if (p.startsWith('/api/ha/')) {
      const s = session(req);
      if (!s || s.role !== 'owner') return json(res, 403, { error: 'Alleen eigenaren' });
      if ((p === '/api/ha/config' || p === '/api/ha/status') && !isAdmin(s)) return json(res, 403, { error: 'Alleen de beheerder' });
      const r = q.get.get('ha'); const cfg = r ? JSON.parse(r.v) : {};
      if (p === '/api/ha/config' && req.method === 'GET') return json(res, 200, { url: cfg.url || '', tokenSet: !!cfg.token });
      if (p === '/api/ha/config' && req.method === 'PUT') {
        const b = JSON.parse(await body(req));
        let u = String(b.url || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\/[\w.\-]+(:\d+)?$/.test(u)) return json(res, 400, { error: 'Adres moet er zo uitzien: http://192.168.178.68:8123' });
        const token = b.token ? String(b.token).trim() : cfg.token;
        if (!token) return json(res, 400, { error: 'Vul het token in.' });
        q.put.run('ha', JSON.stringify({ url: u, token }), Date.now());
        return json(res, 200, { ok: true });
      }
      if (!cfg.url || !cfg.token) return json(res, 400, { error: 'Home Assistant is nog niet ingesteld.' });
      const ha = async (path) => {
        const r = await fetch(cfg.url + path, { headers: { Authorization: 'Bearer ' + cfg.token }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error('Home Assistant antwoordde met ' + r.status + (r.status === 401 ? ' (token klopt niet)' : ''));
        return r.json();
      };
      try {
        if (p === '/api/ha/status') { const c = await ha('/api/config'); return json(res, 200, { ok: true, naam: c.location_name, versie: c.version }); }
        if (p === '/api/ha/say' && req.method === 'POST') {
          const b = JSON.parse(await body(req));
          const text = String(b.text || '').trim().slice(0, 500);
          if (!text) return json(res, 400, { error: 'Typ eerst een bericht.' });
          if (b.mode === 'command') {
            try { await haCall(cfg, '/api/services/google_assistant_sdk/send_text_command', { command: text }); return json(res, 200, { ok: true }); }
            catch (e) { return json(res, 400, { error: /404|400/.test(e.message) ? 'De integratie “Google Assistant SDK” is nog niet geïnstalleerd in Home Assistant.' : e.message }); }
          }
          const targets = (Array.isArray(b.targets) ? b.targets : []).filter(x => /^media_player\.[\w]+$/.test(x)).slice(0, 20);
          if (!targets.length) return json(res, 400, { error: 'Kies minstens één speaker.' });
          const all = await ha('/api/states');
          const tts = all.map(e => e.entity_id).filter(id => id.startsWith('tts.'));
          const pick = tts.find(id => id.includes('google')) || tts[0];
          if (!pick) return json(res, 400, { error: 'Home Assistant heeft nog geen spraakdienst. Voeg de integratie “Google Translate text-to-speech” toe.' });
          for (const t of targets) await haCall(cfg, '/api/services/tts/speak', { entity_id: pick, media_player_entity_id: t, message: text, language: 'nl' });
          return json(res, 200, { ok: true, speakers: targets.length });
        }
        if (p === '/api/ha/scenes') {
          const all = await ha('/api/states');
          const out = all.filter(e => e.entity_id.startsWith('scene.')).map(e => ({ id: e.entity_id, naam: e.attributes.name || e.attributes.friendly_name || e.entity_id, groep: e.attributes.group_name || '' }));
          return json(res, 200, { scenes: out });
        }
        if (p === '/api/ha/sensors') {
          if (!isAdmin(s)) return json(res, 403, { error: 'Alleen de beheerder' });
          const SEN = ['motion', 'occupancy', 'temperature', 'illuminance', 'battery'];
          const nm = e => (e.attributes.friendly_name || e.entity_id).toLowerCase();
          const kind = e => { const d = e.attributes.device_class; if (SEN.includes(d)) return d === 'occupancy' ? 'motion' : d; const n = nm(e) + ' ' + e.entity_id; if (/beweging|motion/.test(n) && e.entity_id.startsWith('binary_sensor.') && !/ingeschakeld|enabled/.test(n)) return 'motion'; if (!e.entity_id.startsWith('sensor.')) return ''; if (/temperatuur|temperature/.test(n)) return 'temperature'; if (/licht|illuminance|lux/.test(n)) return 'illuminance'; if (/batterij|battery/.test(n)) return 'battery'; return ''; };
          const all = await ha('/api/states');
          const list = all.map(e => ({ e, k: kind(e) })).filter(x => x.k);
          const items = list.map(({ e, k }) => ({ id: e.entity_id, naam: e.attributes.friendly_name || e.entity_id, soort: k, staat: e.state, eenheid: e.attributes.unit_of_measurement || '', wijzig: e.last_changed, klasse: e.attributes.device_class || '' }));
          const base = id => id.split('.')[1].replace(/_(beweging|motion|temperatuur|temperature|lichtniveau|licht|illuminance|batterij|battery)(_\d+)?$/, '');
          for (const it of items) if (it.soort === 'motion') { const bs = base(it.id); it.sib = [['t', 'temperature'], ['lx', 'illuminance'], ['bat', 'battery']].filter(([, kd]) => list.some(x => x.k === kd && x.e.entity_id.startsWith('sensor.') && base(x.e.entity_id) === bs)).map(([k]) => k); }
          const links = kvGet('sensors') || {};
          if (req.method === 'PUT') {
            const b = JSON.parse(await body(req));
            const room = String(b.room || ''); if (!roomList().some(r => r.id === room)) return json(res, 400, { error: 'Onbekende ruimte' });
            if (!b.m) { delete links[room]; kvPut('sensors', links); return json(res, 200, { ok: true, link: null }); }
            const mo = list.find(x => x.e.entity_id === b.m && x.k === 'motion'); if (!mo) return json(res, 400, { error: 'Die bewegingssensor staat niet in Home Assistant.' });
            const bs = base(b.m), l = { m: b.m };
            for (const [key, kd] of [['t', 'temperature'], ['lx', 'illuminance'], ['bat', 'battery']]) {
              const c = list.filter(x => x.k === kd && x.e.entity_id.startsWith('sensor.') && base(x.e.entity_id) === bs);
              if (c.length) l[key] = c[0].e.entity_id;
            }
            links[room] = l; kvPut('sensors', links);
            return json(res, 200, { ok: true, link: l });
          }
          return json(res, 200, { items, links, rooms: roomList().map(r => ({ id: r.id, naam: r.name })) });
        }
        if (p === '/api/ha/film') {
          const all = await ha('/api/states');
          const nm = e => e.attributes.friendly_name || e.entity_id;
          if (req.method === 'PUT') {
            const b = JSON.parse(await body(req));
            const ids = new Set(all.map(e => e.entity_id));
            const lights = (Array.isArray(b.lights) ? b.lights : []).filter(x => /^light\.[\w]+$/.test(x) && ids.has(x)).slice(0, 40);
            const sync = (Array.isArray(b.sync) ? b.sync : []).filter(x => /^(media_player|switch|remote|light|input_boolean)\.[\w]+$/.test(x) && ids.has(x)).slice(0, 8);
            const bri = Math.max(0, Math.min(100, parseInt(b.bri, 10) || 0));
            kvPut('film', { lights, sync, bri });
            return json(res, 200, { ok: true });
          }
          return json(res, 200, {
            cfg: kvGet('film') || { lights: [], sync: [], bri: 10 },
            lights: all.filter(e => e.entity_id.startsWith('light.')).map(e => ({ id: e.entity_id, naam: nm(e), staat: e.state })),
            sync: all.filter(e => /^(media_player|switch|remote|input_boolean)\./.test(e.entity_id)).map(e => ({ id: e.entity_id, naam: nm(e), staat: e.state }))
          });
        }
        if (p === '/api/ha/entities') {
          const all = await ha('/api/states');
          const keep = new Set(['light', 'climate', 'media_player', 'switch', 'binary_sensor', 'sensor', 'camera', 'lock']);
          const out = all.filter(e => keep.has(e.entity_id.split('.')[0]) && !(e.entity_id.startsWith('sensor.') && !e.attributes.device_class))
            .map(e => ({ id: e.entity_id, naam: e.attributes.friendly_name || e.entity_id, staat: e.state }));
          return json(res, 200, { aantal: out.length, entiteiten: out });
        }
      } catch (e) { return json(res, 502, { error: haErr(e) }); }
      return json(res, 404, { error: 'Onbekend' });
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'Onbekend' });
    const ICONS = { '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'], '/icon-maskable.png': ['icon-maskable.png', 'image/png'], '/sw.js': ['sw.js', 'text/javascript'] };
    if (ICONS[p]) { res.writeHead(200, { 'content-type': ICONS[p][1], 'cache-control': p === '/sw.js' ? 'no-cache' : 'public, max-age=86400' }); return fs.createReadStream(path.join(PUB, ICONS[p][0])).pipe(res); }
    if (p === '/manifest.webmanifest') { res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=3600' }); return res.end(JSON.stringify({ id: '/', name: 'Huis CPvH', short_name: 'Huis', start_url: '/', scope: '/', display: 'standalone', orientation: 'any', background_color: '#000000', theme_color: '#1b2748', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }] })); }
    if (p === '/privacy') return file(res, 'privacy.html', 'text/html; charset=utf-8');
    if (p === '/admin') {
      const s = session(req);
      if (isAdmin(s) || (s && s.role === 'owner' && s.ref === 'Joshua' && !q.owner.get(ADMIN))) return file(res, 'admin.html', 'text/html; charset=utf-8');
    }
    // Pagina's: zonder sessie alleen de loginpagina
    if (!session(req) || q.ownerCount.get().n === 0) return file(res, 'login.html', 'text/html; charset=utf-8');
    return file(res, 'index.html', 'text/html; charset=utf-8');
  } catch (e) {
    json(res, 500, { error: String(e.message) });
  }
}).listen(PORT, () => console.log('Huis-server luistert op poort ' + PORT));
