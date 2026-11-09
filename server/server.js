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

function turnOnData(entity, b) {
  const data = { entity_id: entity };
  if (Number.isFinite(+b.b) && b.b !== null) data.brightness_pct = Math.min(100, Math.max(1, Math.round(+b.b)));
  if (Number.isFinite(+b.k)) data.color_temp_kelvin = Math.min(10000, Math.max(1500, Math.round(+b.k)));
  else if (Number.isFinite(+b.h) && Number.isFinite(+b.s)) data.hs_color = [Math.min(360, Math.max(0, +b.h)), Math.min(100, Math.max(0, +b.s))];
  return data;
}
function haCfg() { const r = q.get.get('ha'); const c = r ? JSON.parse(r.v) : null; return c && c.url && c.token ? c : null; }
function loadRooms() { const r = q.get.get('rooms'); try { const x = r ? JSON.parse(r.v) : []; return Array.isArray(x) ? x : []; } catch { return []; } }
async function haCall(cfg, path, payload) {
  const r = await fetch(cfg.url + path, {
    method: payload ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('Home Assistant antwoordde met ' + r.status);
  return r.json();
}
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
      catch (e) { return json(res, 502, { error: 'Geen verbinding met Home Assistant: ' + (e.cause && e.cause.code || e.message) }); }
    }
    if (p === '/api/lights' || p === '/api/light' || p === '/api/apply') {
      const s = session(req);
      if (!s) return json(res, 401, { error: 'Niet ingelogd' });
      const cfg = haCfg();
      if (!cfg) return json(res, 200, { lights: {} });
      const rooms = loadRooms();
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
      } catch (e) { return json(res, 502, { error: 'Geen verbinding met Home Assistant: ' + (e.cause && e.cause.code || e.message) }); }
      return json(res, 405, { error: 'Niet toegestaan' });
    }
    if (p === '/api/cf/token') {
      const s = session(req);
      if (!s || s.role !== 'owner') return json(res, 403, { error: 'Alleen eigenaren' });
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
    if (p.startsWith('/api/ha/')) {
      const s = session(req);
      if (!s || s.role !== 'owner') return json(res, 403, { error: 'Alleen eigenaren' });
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
        if (p === '/api/ha/entities') {
          const all = await ha('/api/states');
          const keep = new Set(['light', 'climate', 'media_player', 'switch', 'binary_sensor', 'sensor', 'camera', 'lock']);
          const out = all.filter(e => keep.has(e.entity_id.split('.')[0]) && !(e.entity_id.startsWith('sensor.') && !e.attributes.device_class))
            .map(e => ({ id: e.entity_id, naam: e.attributes.friendly_name || e.entity_id, staat: e.state }));
          return json(res, 200, { aantal: out.length, entiteiten: out });
        }
      } catch (e) { return json(res, 502, { error: 'Geen verbinding met Home Assistant: ' + (e.cause && e.cause.code || e.message) }); }
      return json(res, 404, { error: 'Onbekend' });
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'Onbekend' });
    if (p === '/ha') {
      const s = session(req);
      if (s && s.role === 'owner') return file(res, 'ha.html', 'text/html; charset=utf-8');
    }
    // Pagina's: zonder sessie alleen de loginpagina
    if (!session(req) || q.ownerCount.get().n === 0) return file(res, 'login.html', 'text/html; charset=utf-8');
    return file(res, 'index.html', 'text/html; charset=utf-8');
  } catch (e) {
    json(res, 500, { error: String(e.message) });
  }
}).listen(PORT, () => console.log('Huis-server luistert op poort ' + PORT));
