const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

// ---------- Settings (all can be changed with environment variables) ----------
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';   // change it!
const BUSINESS = process.env.BUSINESS_NAME || 'Luna Studio';
const CURRENCY = process.env.CURRENCY || '$';
const TZ = process.env.TIMEZONE || 'UTC';                           // e.g. Africa/Algiers, Asia/Riyadh
const OPEN = (+process.env.OPEN_HOUR || 9) * 60;
const CLOSE = (+process.env.CLOSE_HOUR || 18) * 60;
const STEP = 30;                                                    // minutes between start times
const CLOSED_DAYS = (process.env.CLOSED_DAYS ?? '5').split(',').filter(x => x !== '').map(Number); // 0=Sun … 5=Fri, 6=Sat

// ---------- Database ----------
const db = new Database(process.env.DB_FILE || path.join(__dirname, 'booking.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS services(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, duration INTEGER NOT NULL,
  price REAL NOT NULL, emoji TEXT DEFAULT '✨', active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS providers(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS bookings(
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL,
  service_id INTEGER NOT NULL, provider_id INTEGER NOT NULL,
  date TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
  name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
  status TEXT DEFAULT 'Pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_b ON bookings(date, provider_id);
`);
if (db.prepare('SELECT COUNT(*) c FROM services').get().c === 0) {
  const s = db.prepare('INSERT INTO services(name,duration,price,emoji) VALUES(?,?,?,?)');
  [['Haircut & Styling', 30, 25, '✂️'], ['Facial Treatment', 60, 45, '🧖'], ['Relaxing Massage', 60, 55, '💆'], ['Manicure', 30, 20, '💅']].forEach(r => s.run(...r));
  const p = db.prepare('INSERT INTO providers(name,role) VALUES(?,?)');
  [['Lina', 'Senior stylist'], ['Rania', 'Skin specialist'], ['Yacine', 'Therapist']].forEach(r => p.run(...r));
}

// ---------- Helpers ----------
const pad = n => String(n).padStart(2, '0');
const hm = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
const toMin = s => { const m = /^(\d\d):(\d\d)$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : NaN; };
const dow = d => new Date(d + 'T00:00:00Z').getUTCDay();
const digits = s => String(s || '').replace(/\D/g, '');
function nowTz() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: TZ, hour12: false });
  return { date: s.slice(0, 10), min: +s.slice(11, 13) * 60 + +s.slice(14, 16) };
}
function dateOk(d) {
  if (!/^\d{4}-\d\d-\d\d$/.test(d || '')) return false;
  const today = nowTz().date;
  const max = new Date(Date.parse(today + 'T00:00:00Z') + 60 * 864e5).toISOString().slice(0, 10);
  return d >= today && d <= max && !CLOSED_DAYS.includes(dow(d));
}
function freeProviders(dur, date, start, providerId) {
  const end = start + dur;
  const provs = providerId
    ? db.prepare('SELECT * FROM providers WHERE id=? AND active=1').all(providerId)
    : db.prepare('SELECT * FROM providers WHERE active=1 ORDER BY id').all();
  const busy = db.prepare("SELECT 1 FROM bookings WHERE provider_id=? AND date=? AND status!='Cancelled' AND start<? AND end>? LIMIT 1");
  return provs.filter(p => !busy.get(p.id, date, end, start));
}
function startOk(date, start, dur) {
  if (!(start >= OPEN && start % STEP === 0 && start + dur <= CLOSE)) return false;
  const n = nowTz();
  return !(date === n.date && start <= n.min);
}
const SELECT = `SELECT b.*, s.name AS service, s.price, p.name AS provider
  FROM bookings b JOIN services s ON s.id=b.service_id JOIN providers p ON p.id=b.provider_id`;
const shape = b => ({ ...b, time: hm(b.start), until: hm(b.end) });
const newCode = () => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const c = Array.from(crypto.randomBytes(6), x => A[x % A.length]).join('');
    if (!db.prepare('SELECT 1 FROM bookings WHERE code=?').get(c)) return c;
  }
};

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));
const admin = (req, res, next) =>
  req.get('x-admin-password') === ADMIN_PASSWORD ? next() : res.status(401).json({ error: 'Wrong admin password' });

app.get('/api/config', (req, res) => res.json({
  business: BUSINESS, currency: CURRENCY, today: nowTz().date, closedDays: CLOSED_DAYS,
  open: hm(OPEN), close: hm(CLOSE) }));
app.get('/api/services', (req, res) => res.json(db.prepare('SELECT * FROM services WHERE active=1 ORDER BY id').all()));
app.get('/api/providers', (req, res) => res.json(db.prepare('SELECT * FROM providers WHERE active=1 ORDER BY id').all()));

// Available start times for a service on a date (provider 0 = any provider)
app.get('/api/slots', (req, res) => {
  const svc = db.prepare('SELECT * FROM services WHERE id=? AND active=1').get(+req.query.service);
  const date = req.query.date, pid = +req.query.provider || 0;
  if (!svc) return res.status(400).json({ error: 'Unknown service' });
  if (!dateOk(date)) return res.json([]);
  const out = [];
  for (let t = OPEN; t + svc.duration <= CLOSE; t += STEP)
    if (startOk(date, t, svc.duration) && freeProviders(svc.duration, date, t, pid).length) out.push(hm(t));
  res.json(out);
});

app.post('/api/bookings', (req, res) => {
  const { service_id, provider_id, date, time, name, phone, email } = req.body || {};
  const svc = db.prepare('SELECT * FROM services WHERE id=? AND active=1').get(+service_id);
  const start = toMin(time);
  if (!svc || !dateOk(date) || isNaN(start) || !startOk(date, start, svc.duration))
    return res.status(400).json({ error: 'That date or time is not available' });
  if (!name || digits(phone).length < 6) return res.status(400).json({ error: 'Enter your name and a valid phone number' });
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  const create = db.transaction(() => {
    const free = freeProviders(svc.duration, date, start, +provider_id || 0);
    if (!free.length) return null;
    const code = newCode();
    db.prepare('INSERT INTO bookings(code,service_id,provider_id,date,start,end,name,phone,email) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(code, svc.id, free[0].id, date, start, start + svc.duration, String(name).slice(0, 100), String(phone).slice(0, 30), String(email || '').slice(0, 120));
    return code;
  });
  const code = create();
  if (!code) return res.status(409).json({ error: 'Sorry, that time was just taken. Please pick another.' });
  res.json(shape(db.prepare(SELECT + ' WHERE b.code=?').get(code)));
});

const mine = (req, res) => {
  const b = db.prepare(SELECT + ' WHERE b.code=?').get(String(req.params.code || '').toUpperCase());
  const phone = req.query.phone ?? (req.body && req.body.phone);
  if (!b || digits(b.phone) !== digits(phone)) { res.status(404).json({ error: 'No booking found with this code and phone number' }); return null; }
  return b;
};
app.get('/api/bookings/:code', (req, res) => { const b = mine(req, res); if (b) res.json(shape(b)); });
app.post('/api/bookings/:code/cancel', (req, res) => {
  const b = mine(req, res); if (!b) return;
  if (!['Pending', 'Confirmed'].includes(b.status)) return res.status(400).json({ error: `This booking is already ${b.status.toLowerCase()}` });
  db.prepare("UPDATE bookings SET status='Cancelled' WHERE id=?").run(b.id);
  res.json({ ok: true });
});

// Admin
app.get('/api/admin/bookings', admin, (req, res) => {
  const d = req.query.date;
  const rows = d ? db.prepare(SELECT + ' WHERE b.date=? ORDER BY b.start').all(d)
                 : db.prepare(SELECT + ' WHERE b.date>=? ORDER BY b.date, b.start LIMIT 200').all(nowTz().date);
  res.json(rows.map(shape));
});
app.patch('/api/admin/bookings/:id', admin, (req, res) => {
  const st = req.body && req.body.status;
  if (!['Pending', 'Confirmed', 'Completed', 'Cancelled'].includes(st)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE bookings SET status=? WHERE id=?').run(st, +req.params.id);
  res.json({ ok: true });
});
app.post('/api/admin/services', admin, (req, res) => {
  const { name, duration, price, emoji } = req.body || {};
  const dur = Math.round(+duration / 15) * 15;
  if (!name || !(dur >= 15 && dur <= 240) || !(+price >= 0)) return res.status(400).json({ error: 'Name, duration and price are required' });
  const r = db.prepare('INSERT INTO services(name,duration,price,emoji) VALUES(?,?,?,?)')
    .run(String(name).slice(0, 80), dur, +price, String(emoji || '✨').slice(0, 8));
  res.json({ id: r.lastInsertRowid });
});
app.delete('/api/admin/services/:id', admin, (req, res) => {
  db.prepare('UPDATE services SET active=0 WHERE id=?').run(+req.params.id); res.json({ ok: true });
});
app.post('/api/admin/providers', admin, (req, res) => {
  const { name, role } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const r = db.prepare('INSERT INTO providers(name,role) VALUES(?,?)').run(String(name).slice(0, 80), String(role || '').slice(0, 80));
  res.json({ id: r.lastInsertRowid });
});
app.delete('/api/admin/providers/:id', admin, (req, res) => {
  db.prepare('UPDATE providers SET active=0 WHERE id=?').run(+req.params.id); res.json({ ok: true });
});

app.listen(PORT, () => console.log(`${BUSINESS} booking running on http://localhost:${PORT}`));
