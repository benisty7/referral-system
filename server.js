require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'referral-system-secret-2024';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/referrals';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db();
  console.log('Connected to MongoDB');

  const count = await db.collection('users').countDocuments();
  if (count === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await db.collection('users').insertOne({ username: 'admin', password_hash: hash, full_name: 'מנהל ראשי', created_at: now() });
    console.log('Created default user: admin / admin123');
  }
}

// ── Email (Resend API) ────────────────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'benisty.law@gmail.com';

async function getReferrerEmail(referrerName) {
  if (!referrerName || !db) return null;
  const user = await db.collection('users').findOne({
    $or: [{ full_name: referrerName }, { username: referrerName }]
  });
  return user?.username || null;
}

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) return;
  // TODO: add referrer email after domain verification at resend.com/domains
  const recipients = [ADMIN_EMAIL];
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'לוח הפניות - אלי בניסטי <onboarding@resend.dev>',
        to: recipients,
        subject,
        html
      })
    });
    const data = await res.json();
    if (res.ok) console.log('Email sent to:', recipients.join(', '));
    else console.error('Email error:', JSON.stringify(data));
  } catch (e) {
    console.error('Email error:', e.message);
  }
}

function emailTemplate(title, rows) {
  const rowsHtml = rows.map(([k, v]) =>
    `<tr><td style="padding:6px 12px;font-weight:bold;background:#f0f4f8;border:1px solid #ddd">${k}</td><td style="padding:6px 12px;border:1px solid #ddd">${v || '—'}</td></tr>`
  ).join('');
  return `
    <div style="font-family:Arial,sans-serif;direction:rtl;max-width:560px;margin:0 auto">
      <div style="background:#1F4E79;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:18px">⚖️ לוח הפניות המשפטיות</h2>
        <p style="margin:4px 0 0;font-size:13px;opacity:.85">${title}</p>
      </div>
      <div style="border:1px solid #ddd;border-top:none;padding:16px;border-radius:0 0 8px 8px">
        <table style="width:100%;border-collapse:collapse;font-size:14px">${rowsHtml}</table>
        <p style="margin:16px 0 0;font-size:12px;color:#888">אלי בניסטי, עו"ד וסוכן ביטוח פנסיוני | 054-5285230</p>
      </div>
    </div>
  `;
}

function now() { return new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }); }
function today() { return new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' }); }
function oid(id) { try { return new ObjectId(id); } catch { return id; } }
function fmt(doc) { if (!doc) return null; const { _id, ...rest } = doc; return { id: _id.toString(), ...rest }; }

function auth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'לא מחובר' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'פג תוקף ההתחברות' }); }
}

// ── Auth ───────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.collection('users').findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
    const token = jwt.sign({ id: user._id.toString(), username: user.username, full_name: user.full_name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, full_name: user.full_name, username: user.username });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users', auth, async (req, res) => {
  try {
    const users = await db.collection('users').find({}).toArray();
    res.json(users.map(fmt));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', auth, async (req, res) => {
  try {
    const { username, password, full_name } = req.body;
    if (!username || !password || !full_name) return res.status(400).json({ error: 'כל השדות נדרשים' });
    if (await db.collection('users').findOne({ username })) return res.status(400).json({ error: 'שם משתמש כבר קיים' });
    const hash = await bcrypt.hash(password, 10);
    await db.collection('users').insertOne({ username, password_hash: hash, full_name, created_at: now() });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', auth, async (req, res) => {
  try { await db.collection('users').deleteOne({ _id: oid(req.params.id) }); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Clients ────────────────────────────────────────────────────────────────────
app.get('/api/clients', auth, async (req, res) => {
  try {
    const clients = await db.collection('clients').find({}).sort({ updated_at: -1 }).toArray();
    res.json(clients.map(fmt));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clients/:id', auth, async (req, res) => {
  try {
    const c = await db.collection('clients').findOne({ _id: oid(req.params.id) });
    if (!c) return res.status(404).json({ error: 'לא נמצא' });
    res.json(fmt(c));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients', auth, async (req, res) => {
  try {
    const { first_name, last_name, city, id_number, phone, email, spouse_name, referrer_name } = req.body;
    if (!first_name || !last_name) return res.status(400).json({ error: 'שם פרטי ושם משפחה נדרשים' });
    const r = await db.collection('clients').insertOne({
      first_name, last_name, city, id_number, phone, email, spouse_name, referrer_name,
      referral_date: today(), updated_at: now(), created_by: req.user.id
    });
    res.json({ id: r.insertedId.toString() });
    const referrerEmail = await getReferrerEmail(referrer_name);
    sendEmail({
      to: referrerEmail,
      subject: `לקוח חדש נוסף – ${first_name} ${last_name}`,
      html: emailTemplate('לקוח חדש נוסף למערכת', [
        ['שם מלא', `${first_name} ${last_name}`],
        ['עיר', city],
        ['טלפון', phone],
        ['מפנה', referrer_name],
        ['תאריך הפניה', today()],
        ['נוסף ע"י', req.user.full_name],
      ])
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id', auth, async (req, res) => {
  try {
    const { first_name, last_name, city, id_number, phone, email, spouse_name, referrer_name } = req.body;
    await db.collection('clients').updateOne(
      { _id: oid(req.params.id) },
      { $set: { first_name, last_name, city, id_number, phone, email, spouse_name, referrer_name, updated_at: now() } }
    );
    res.json({ success: true });
    const referrerEmail = await getReferrerEmail(referrer_name);
    sendEmail({
      to: referrerEmail,
      subject: `פרטי לקוח עודכנו – ${first_name} ${last_name}`,
      html: emailTemplate('פרטי לקוח עודכנו', [
        ['שם מלא', `${first_name} ${last_name}`],
        ['עיר', city],
        ['טלפון', phone],
        ['מפנה', referrer_name],
        ['עודכן ע"י', req.user.full_name],
        ['תאריך', now()],
      ])
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id', auth, async (req, res) => {
  try {
    const cid = req.params.id;
    await db.collection('clients').deleteOne({ _id: oid(cid) });
    await Promise.all([
      db.collection('journal').deleteMany({ client_id: cid }),
      db.collection('dates').deleteMany({ client_id: cid }),
      db.collection('products').deleteMany({ client_id: cid }),
    ]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Journal ────────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/journal', auth, async (req, res) => {
  try {
    const entries = await db.collection('journal').find({ client_id: req.params.id }).sort({ created_at: -1 }).toArray();
    res.json(entries.map(fmt));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/journal', auth, async (req, res) => {
  try {
    const { note } = req.body;
    if (!note) return res.status(400).json({ error: 'הערה נדרשת' });
    const r = await db.collection('journal').insertOne({
      client_id: req.params.id, note, created_by: req.user.id, author_name: req.user.full_name, created_at: now()
    });
    await db.collection('clients').updateOne({ _id: oid(req.params.id) }, { $set: { updated_at: now() } });
    res.json({ id: r.insertedId.toString() });
    const c = await db.collection('clients').findOne({ _id: oid(req.params.id) });
    if (c) {
      const referrerEmail = await getReferrerEmail(c.referrer_name);
      sendEmail({
        to: referrerEmail,
        subject: `עדכון יומן – ${c.first_name} ${c.last_name}`,
        html: emailTemplate('הערה חדשה נוספה ליומן הטיפול', [
          ['לקוח', `${c.first_name} ${c.last_name}`],
          ['מפנה', c.referrer_name],
          ['הערה', note],
          ['נוסף ע"י', req.user.full_name],
          ['תאריך', now()],
        ])
      });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id/journal/:entryId', auth, async (req, res) => {
  try { await db.collection('journal').deleteOne({ _id: oid(req.params.entryId) }); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Important Dates ────────────────────────────────────────────────────────────
app.get('/api/clients/:id/dates', auth, async (req, res) => {
  try {
    const dates = await db.collection('dates').find({ client_id: req.params.id }).sort({ date: 1 }).toArray();
    res.json(dates.map(fmt));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/dates', auth, async (req, res) => {
  try {
    const { date, time, notes } = req.body;
    const r = await db.collection('dates').insertOne({ client_id: req.params.id, date, time, notes, created_at: now() });
    await db.collection('clients').updateOne({ _id: oid(req.params.id) }, { $set: { updated_at: now() } });
    res.json({ id: r.insertedId.toString() });
    const c = await db.collection('clients').findOne({ _id: oid(req.params.id) });
    if (c) {
      const referrerEmail = await getReferrerEmail(c.referrer_name);
      sendEmail({
        to: referrerEmail,
        subject: `מועד חשוב נוסף – ${c.first_name} ${c.last_name}`,
        html: emailTemplate('תאריך חשוב נוסף ללקוח', [
          ['לקוח', `${c.first_name} ${c.last_name}`],
          ['מפנה', c.referrer_name],
          ['תאריך', date],
          ['שעה', time],
          ['הערות', notes],
          ['נוסף ע"י', req.user.full_name],
        ])
      });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id/dates/:dateId', auth, async (req, res) => {
  try {
    const { date, time, notes } = req.body;
    await db.collection('dates').updateOne({ _id: oid(req.params.dateId) }, { $set: { date, time, notes } });
    res.json({ success: true });
    const c = await db.collection('clients').findOne({ _id: oid(req.params.id) });
    if (c) {
      const referrerEmail = await getReferrerEmail(c.referrer_name);
      sendEmail({
        to: referrerEmail,
        subject: `מועד עודכן – ${c.first_name} ${c.last_name}`,
        html: emailTemplate('תאריך חשוב עודכן', [
          ['לקוח', `${c.first_name} ${c.last_name}`],
          ['מפנה', c.referrer_name],
          ['תאריך', date],
          ['שעה', time],
          ['הערות', notes],
          ['עודכן ע"י', req.user.full_name],
        ])
      });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id/dates/:dateId', auth, async (req, res) => {
  try { await db.collection('dates').deleteOne({ _id: oid(req.params.dateId) }); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Products ───────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/products', auth, async (req, res) => {
  try {
    const products = await db.collection('products').find({ client_id: req.params.id }).sort({ created_at: -1 }).toArray();
    res.json(products.map(fmt));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/products', auth, async (req, res) => {
  try {
    const { product_name, price, status } = req.body;
    const r = await db.collection('products').insertOne({
      client_id: req.params.id, product_name, price, status: status || 'ממתין', created_at: now()
    });
    await db.collection('clients').updateOne({ _id: oid(req.params.id) }, { $set: { updated_at: now() } });
    res.json({ id: r.insertedId.toString() });
    const c = await db.collection('clients').findOne({ _id: oid(req.params.id) });
    if (c) {
      const referrerEmail = await getReferrerEmail(c.referrer_name);
      sendEmail({
        to: referrerEmail,
        subject: `מוצר חדש נוסף – ${c.first_name} ${c.last_name}`,
        html: emailTemplate('מוצר חדש נוסף ללקוח', [
          ['לקוח', `${c.first_name} ${c.last_name}`],
          ['מפנה', c.referrer_name],
          ['מוצר', product_name],
          ['מחיר', price],
          ['סטטוס', status || 'ממתין'],
          ['נוסף ע"י', req.user.full_name],
        ])
      });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id/products/:productId', auth, async (req, res) => {
  try {
    const { product_name, price, status } = req.body;
    await db.collection('products').updateOne({ _id: oid(req.params.productId) }, { $set: { product_name, price, status } });
    res.json({ success: true });
    const c = await db.collection('clients').findOne({ _id: oid(req.params.id) });
    if (c) {
      const referrerEmail = await getReferrerEmail(c.referrer_name);
      sendEmail({
        to: referrerEmail,
        subject: `עדכון מוצר – ${c.first_name} ${c.last_name}`,
        html: emailTemplate('סטטוס מוצר עודכן', [
          ['לקוח', `${c.first_name} ${c.last_name}`],
          ['מפנה', c.referrer_name],
          ['מוצר', product_name],
          ['מחיר', price],
          ['סטטוס חדש', status],
          ['עודכן ע"י', req.user.full_name],
        ])
      });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id/products/:productId', auth, async (req, res) => {
  try { await db.collection('products').deleteOne({ _id: oid(req.params.productId) }); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

connectDB().then(() => {
  app.listen(PORT, () => console.log('Server running on http://localhost:' + PORT));
}).catch(e => { console.error('DB connection failed:', e.message); process.exit(1); });
