// Call a Burger — scripted outbound calls, prepaid per-minute billing loaded with crypto,
// and a live transcript streamed to each user's Telegram.
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID, // set in your host's settings (starts with AC)
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER = '', // only needed when DEDICATED_NUMBERS=false
  TELEGRAM_BOT_TOKEN,
  ADMIN_TELEGRAM_CHAT_ID = '', // optional: your own chat/group that sees every call and top-up
  PUBLIC_BASE_URL,
  DAILY_CALL_LIMIT = '20',
  ANNOUNCE_CALLER = 'true',
  RECORD_CALLS = 'true', // record calls and send the audio to the customer's Telegram (then delete it from Twilio)
  KEEP_CONVERSATION_MINUTES = '60', // transcripts are deleted this long after the call hangs up
  PORT = 3000,
  VOICE_FEMALE = 'Polly.Joanna-Neural',
  VOICE_MALE = 'Polly.Matthew-Neural',
  VALIDATE_TWILIO_SIGNATURE = 'true',
  TELEGRAM_MOCK = 'false',
  DATA_DIR = path.join(__dirname, 'data'),

  // --- Billing ---
  PRICE_PER_MINUTE = '1.00', // USD charged per started minute of a connected call
  TOPUP_AMOUNTS = '10,25,50,100', // preset top-up buttons (USD)
  MIN_TOPUP = '10',
  MAX_TOPUP = '1000',
  SIGNUP_BONUS = '0', // free credit for new accounts (USD)
  ADMIN_TELEGRAM_IDS = '', // comma-separated Telegram user IDs that can credit balances manually
  ADMIN_EMAILS = '', // comma-separated account emails that can credit balances manually

  // --- Captcha on sign-up and sign-in (Cloudflare Turnstile, free) ---
  // Blank = Cloudflare's always-pass TEST keys (fine for trying it out, NOT real protection).
  TURNSTILE_SITE_KEY = '',
  TURNSTILE_SECRET_KEY = '',

  // --- Crypto processors (fill in one or both) ---
  NOWPAYMENTS_API_KEY = '',
  NOWPAYMENTS_IPN_SECRET = '',
  NOWPAYMENTS_SANDBOX = 'false',
  STRIPE_SECRET_KEY = '',
  STRIPE_WEBHOOK_SECRET = '',
  // Direct to your own wallet (Phantom or any Solana wallet) — PUBLIC address only, never a seed phrase.
  SOLANA_RECEIVE_ADDRESS = 'wuCR8rgxTGxbdir67knyVBDtTuL6R2YGPqGR3nPbzBd', // your Phantom wallet (public address)
  SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com',
  // Direct Bitcoin to your own wallet (Native SegWit, bc1q…). Public address only.
  BITCOIN_RECEIVE_ADDRESS = 'bc1qadrgzjlqq7ndykh9507v77uvldpjfamcqsje5z', // your Phantom Bitcoin address
  BITCOIN_API_URL = 'https://mempool.space/api', // free public block explorer API
  BITCOIN_CONFIRMATIONS = '1', // confirmations required before crediting

  // --- Dedicated numbers (one per account) ---
  DEDICATED_NUMBERS = 'true', // false = everyone calls from TWILIO_FROM_NUMBER
  NUMBER_MONTHLY_FEE = '2.00', // USD taken from the user's balance every 30 days (Twilio charges you ~$1.15)
  NUMBER_GRACE_DAYS = '7', // after a missed renewal, the number is released this many days later
  NUMBER_COUNTRY = 'US',
} = process.env;

const APP_NAME = 'Call a Burger';

// The logo images are kept in public/images.json as text (so they can live alongside the code);
// write out any that are missing from public/ before anything uses them.
(function ensureImages() {
  const dir = path.join(__dirname, 'public');
  try {
    const { files } = JSON.parse(fs.readFileSync(path.join(dir, 'images.json'), 'utf8'));
    for (const [name, b64] of Object.entries(files)) {
      const out = path.join(dir, path.basename(name));
      if (!fs.existsSync(out)) fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    }
  } catch (e) {
    console.warn('Could not unpack logo images from public/images.json:', e.message);
  }
})();

// ---------- Config check ----------
const missing = Object.entries({ TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TELEGRAM_BOT_TOKEN, PUBLIC_BASE_URL, ...(DEDICATED_NUMBERS === 'false' ? { TWILIO_FROM_NUMBER } : {}) })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`Missing required settings in .env: ${missing.join(', ')}`);
  process.exit(1);
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const BASE = PUBLIC_BASE_URL.replace(/\/+$/, '');
const SECURE_COOKIE = BASE.startsWith('https://');
const VOICES = { female: VOICE_FEMALE, male: VOICE_MALE };
const E164 = /^\+[1-9]\d{7,14}$/;
const LIMIT = Math.max(1, parseInt(DAILY_CALL_LIMIT, 10) || 20);
const TG_SECRET = crypto.createHash('sha256').update('tg-webhook:' + TELEGRAM_BOT_TOKEN).digest('hex').slice(0, 48);

// Money is stored as integer cents everywhere.
const toCents = (usd) => Math.round(parseFloat(usd) * 100);
const RATE_CENTS = Math.max(1, toCents(PRICE_PER_MINUTE) || 100);
const PRESETS = TOPUP_AMOUNTS.split(',').map((x) => toCents(x)).filter((x) => x > 0);
const MIN_TOPUP_CENTS = toCents(MIN_TOPUP) || 1000;
const MAX_TOPUP_CENTS = toCents(MAX_TOPUP) || 100000;
const BONUS_CENTS = Math.max(0, toCents(SIGNUP_BONUS) || 0);
const ADMINS = ADMIN_TELEGRAM_IDS.split(',').map((e) => e.trim()).filter(Boolean);
const MAX_CALL_SECONDS = 4 * 60 * 60;
const DEDICATED = DEDICATED_NUMBERS !== 'false';
const NUMBER_FEE_CENTS = Math.max(0, toCents(NUMBER_MONTHLY_FEE) || 0);
const GRACE_MS = Math.max(0, parseInt(NUMBER_GRACE_DAYS, 10) || 7) * 86400000;
const PERIOD_MS = 30 * 86400000;
const prettyPhone = (e164) => {
  const m = String(e164 || '').match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164 || '';
};
const money = (cents) => (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toFixed(2);

const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

// ---------- Solana Pay: USDC straight into your Phantom wallet ----------
// Each top-up gets a unique "reference" key that the customer's wallet attaches to the transfer,
// so the server can find that exact payment on-chain and check the amount, token and recipient.
let sol = null;
if (SOLANA_RECEIVE_ADDRESS) {
  try {
    const web3 = require('@solana/web3.js');
    const pay = require('@solana/pay');
    const BigNumber = require('bignumber.js');
    sol = {
      web3, pay, BigNumber,
      recipient: new web3.PublicKey(SOLANA_RECEIVE_ADDRESS.trim()),
      usdc: new web3.PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), // USDC on Solana mainnet
      connection: new web3.Connection(SOLANA_RPC_URL, 'confirmed'),
    };
  } catch (e) {
    console.error('SOLANA_RECEIVE_ADDRESS is not a valid Solana address — Phantom payments are off.', e.message);
  }
}

// ---------- Direct Bitcoin ----------
// Every top-up asks for a unique amount of sats (the USD price plus a few random sats), so a payment
// to your one address can be matched to the right customer by its exact amount.
let btc = null;
if (BITCOIN_RECEIVE_ADDRESS) {
  try {
    const { bech32 } = require('bech32');
    const addr = BITCOIN_RECEIVE_ADDRESS.trim();
    const d = bech32.decode(addr);
    if (d.prefix !== 'bc' || d.words[0] !== 0 || bech32.fromWords(d.words.slice(1)).length !== 20) throw new Error('not a bc1q address');
    btc = { address: addr, api: BITCOIN_API_URL.replace(/\/+$/, ''), confirmations: Math.max(0, parseInt(BITCOIN_CONFIRMATIONS, 10) || 1) };
  } catch (e) {
    console.error('BITCOIN_RECEIVE_ADDRESS must be a Native SegWit (bc1q…) address — Bitcoin payments are off.', e.message);
  }
}

const PROVIDERS = {
  ...(sol ? { solana: { label: 'Pay USDC from Phantom or any Solana wallet', short: 'Phantom' } } : {}),
  ...(btc ? { bitcoin: { label: 'Pay BTC from any Bitcoin wallet', short: 'Bitcoin' } } : {}),
  ...(NOWPAYMENTS_API_KEY && NOWPAYMENTS_IPN_SECRET
    ? { nowpayments: { label: 'Bitcoin, ETH, USDT & 300+ coins', short: 'Any coin' } }
    : {}),
  ...(stripe && STRIPE_WEBHOOK_SECRET ? { stripe: { label: 'USDC stablecoin (via Stripe)', short: 'USDC' } } : {}),
};
if (!Object.keys(PROVIDERS).length) console.warn('WARNING: No crypto processor configured — users cannot add funds.');

// ---------- Tiny file-backed database ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : {};
db.users ||= {};
db.sessions ||= {};
db.calls ||= {};
db.topups ||= {};
db.ledger ||= [];
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 200);
}

const id = (n = 16) => crypto.randomBytes(n).toString('hex');
// Accounts sign in with email + password, with Telegram, or both (an email account can link its Telegram).
const hashPass = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const userByEmail = (email) => Object.values(db.users).find((u) => u.email === email);
const userByTg = (tgId) => Object.values(db.users).find((u) => u.tgId != null && String(u.tgId) === String(tgId));
const userLabel = (u) =>
  u.email ? u.email + (u.tgUsername ? ` / @${u.tgUsername}` : '')
    : (u.tgUsername ? '@' + u.tgUsername : u.tgName || 'Telegram user') + ` (id ${u.tgId})`;
const ADMIN_EMAIL_LIST = ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const isAdmin = (u) => (u.tgId != null && ADMINS.includes(String(u.tgId))) || (u.email && ADMIN_EMAIL_LIST.includes(u.email));

// Captcha: Cloudflare Turnstile. The test keys always pass, so a fresh install works before you add real ones.
const TS_SITE = TURNSTILE_SITE_KEY || '1x00000000000000000000AA';
const TS_SECRET = TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA';
if (!TURNSTILE_SECRET_KEY) console.warn('WARNING: Captcha is using Cloudflare TEST keys — set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY before launch.');
async function verifyCaptcha(token, ip) {
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: TS_SECRET, response: String(token), remoteip: ip }),
    });
    const data = await r.json();
    return data.success === true;
  } catch (e) {
    console.error('Captcha check failed:', e.message);
    return false;
  }
}
function callsToday(u) {
  const today = new Date().toISOString().slice(0, 10);
  return Object.values(db.calls).filter((c) => c.userId === u.id && c.createdAt.startsWith(today)).length;
}
const publicUser = (u) => ({
  email: u.email || '',
  name: u.tgName || u.callerName,
  username: u.tgUsername || '',
  photoUrl: u.tgPhoto || '',
  callerName: u.callerName,
  telegram: u.telegram.map(({ chatId, title, type }) => ({ chatId, title, type })),
  callsToday: callsToday(u),
  dailyLimit: LIMIT,
  balanceCents: u.balanceCents || 0,
  isAdmin: isAdmin(u),
  number: u.number
    ? { phone: u.number.phone, pretty: prettyPhone(u.number.phone), paidUntil: u.number.paidUntil, status: u.number.status }
    : null,
  areaCode: u.areaCode || '',
});

// Every balance change goes through here so the ledger always explains the balance.
function adjustBalance(u, cents, type, note, ref) {
  u.balanceCents = (u.balanceCents || 0) + cents;
  db.ledger.push({ id: id(8), userId: u.id, type, cents, balanceAfter: u.balanceCents, note, ref: ref || null, at: new Date().toISOString() });
  save();
  return u.balanceCents;
}

// ---------- Helpers ----------
const escapeHtml = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tgApi(method, payload) {
  if (TELEGRAM_MOCK === 'true') {
    console.log(`[telegram:${method}]`, JSON.stringify(payload));
    return method === 'getMe' ? { username: 'CallABurgerBot' } : {};
  }
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.description || r.status}`);
  return data.result;
}

const queues = new Map();
function sendTo(chatId, text, extra = {}) {
  const body = text.length > 4000 ? text.slice(0, 3990) + '…' : text;
  const q = (queues.get(chatId) || Promise.resolve())
    .then(() => tgApi('sendMessage', { chat_id: chatId, text: body, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }))
    .catch((e) => {
      console.error(`Telegram send to ${chatId} failed:`, e.message);
      if (/blocked|kicked|chat not found|deactivated/i.test(e.message)) unlinkChatEverywhere(chatId);
    })
    .then(() => sleep(1100));
  queues.set(chatId, q);
  return q;
}

// Send to a user's linked chats, plus the admin feed (admin copy can carry extra detail).
function notifyUser(u, text, adminExtra = '') {
  const own = new Set(u ? u.telegram.map((t) => String(t.chatId)) : []);
  own.forEach((c) => sendTo(c, text));
  const admin = String(ADMIN_TELEGRAM_CHAT_ID || '');
  if (admin && !own.has(admin)) sendTo(admin, adminExtra ? `${text}\n${adminExtra}` : text);
}
const notifyCall = (rec, text, adminExtra) => notifyUser(rec && db.users[rec.userId], text, adminExtra);

function unlinkChatEverywhere(chatId) {
  for (const u of Object.values(db.users)) u.telegram = u.telegram.filter((t) => String(t.chatId) !== String(chatId));
  save();
}

// ---------- Auth ----------
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
// Sessions work two ways: a cookie for the website, and a bearer token for the Telegram Mini App
// (some Telegram clients run Mini Apps in an iframe where cookies are blocked).
const SESSION_MS = 30 * 86400000;
function startSession(res, userId) {
  const token = id(32);
  db.sessions[token] = { userId, createdAt: Date.now() };
  save();
  res.setHeader('Set-Cookie', `cb_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${SECURE_COOKIE ? '; Secure' : ''}`);
  return token;
}
function sessionToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : getCookie(req, 'cb_session');
}
function requireUser(req, res, next) {
  const tok = sessionToken(req);
  const s = tok && db.sessions[tok];
  if (s && Date.now() - s.createdAt > SESSION_MS) { delete db.sessions[tok]; save(); }
  const u = s && db.sessions[tok] && db.users[s.userId];
  if (!u) return res.status(401).json({ error: 'Please sign in.' });
  req.user = u;
  next();
}
function jsonOnly(req, res, next) {
  if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
  next();
}
const attempts = new Map();
function throttle(req, res, next) {
  const now = Date.now();
  const a = (attempts.get(req.ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (a.length >= 20) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  a.push(now);
  attempts.set(req.ip, a);
  next();
}
function verifyTwilio(req, res, next) {
  if (VALIDATE_TWILIO_SIGNATURE === 'false') return next();
  const ok = twilio.validateRequest(TWILIO_AUTH_TOKEN, req.headers['x-twilio-signature'], BASE + req.originalUrl, req.body);
  if (ok) return next();
  console.warn('Rejected request with invalid Twilio signature:', req.originalUrl);
  res.status(403).send('Invalid signature');
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);

// Payment webhooks need the raw body for signature checks, so they're registered before the JSON parser.
app.post('/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), stripeWebhook);
app.post('/webhooks/nowpayments', express.raw({ type: '*/*', limit: '1mb' }), nowpaymentsWebhook);

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));
// Pages are served with your real address filled into the link-preview tags (__BASE__), so links to the
// site shared in Telegram, iMessage, etc. show the Call a Burger card.
const PUBLIC_DIR = path.join(__dirname, 'public');
const pageCache = {};
function sendPage(file) {
  return (_req, res) => {
    if (!pageCache[file]) pageCache[file] = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8').replaceAll('__BASE__', BASE);
    res.type('html').set('Cache-Control', 'no-cache').send(pageCache[file]);
  };
}
app.get(['/', '/index.html'], sendPage('index.html'));
app.get('/login.html', sendPage('login.html'));
app.get('/login', (_req, res) => res.redirect(301, '/login.html'));
// "Add to Home Screen" app icon and name
app.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json').json({
    name: APP_NAME,
    short_name: APP_NAME,
    description: 'Scripted calls with a male or female voice and a live transcript in Telegram.',
    start_url: '/',
    display: 'standalone',
    background_color: '#14110f',
    theme_color: '#14110f',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
});
app.get('/images.json', (_req, res) => res.sendStatus(404)); // internal bundle, not a page
app.use(express.static(PUBLIC_DIR, { maxAge: '1d' }));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api', jsonOnly);

app.get('/api/config', (_req, res) =>
  res.json({
    botUsername,
    turnstileSiteKey: TS_SITE,
    pricePerMinuteCents: RATE_CENTS,
    topupPresetsCents: PRESETS,
    minTopupCents: MIN_TOPUP_CENTS,
    maxTopupCents: MAX_TOPUP_CENTS,
    signupBonusCents: BONUS_CENTS,
    dedicatedNumbers: DEDICATED,
    numberMonthlyFeeCents: NUMBER_FEE_CENTS,
    providers: Object.entries(PROVIDERS).map(([key, p]) => ({ key, ...p })),
  })
);

// ---------- Sign in with Telegram ----------
// Two ways in, both signed by Telegram with your bot token so they can't be faked:
//  • Mini App (the app opened inside Telegram): sends `initData`
//  • Login Widget (the website in a normal browser): sends the user fields + `hash`
const safeEqualHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const AUTH_MAX_AGE_S = 24 * 60 * 60;

function verifyMiniApp(initData) {
  const p = new URLSearchParams(String(initData || ''));
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (!safeEqualHex(hash, expected)) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > AUTH_MAX_AGE_S) return null;
  try { return JSON.parse(p.get('user') || 'null'); } catch { return null; }
}

function verifyLoginWidget(data) {
  const { hash, ...fields } = data || {};
  if (!hash || !fields.id) return null;
  const check = Object.keys(fields).filter((k) => fields[k] !== undefined && fields[k] !== null).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (!safeEqualHex(String(hash), expected)) return null;
  if (Date.now() / 1000 - Number(fields.auth_date || 0) > AUTH_MAX_AGE_S) return null;
  return fields;
}

// Find or create the account for a verified Telegram user, and link their private chat for transcripts.
function upsertTelegramUser(tg, canMessage, { welcome = true } = {}) {
  const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ') || tg.username || 'Telegram user';
  let u = userByTg(tg.id);
  const isNew = !u;
  if (!u) {
    u = { id: id(12), tgId: tg.id, callerName: name.slice(0, 60), telegram: [], linkCode: null, balanceCents: 0, createdAt: new Date().toISOString() };
    db.users[u.id] = u;
    if (BONUS_CENTS) adjustBalance(u, BONUS_CENTS, 'bonus', 'Welcome credit');
  }
  u.tgName = name;
  u.tgUsername = tg.username || '';
  u.tgPhoto = tg.photo_url || u.tgPhoto || '';
  // A user's private chat with the bot has the same ID as the user.
  if (canMessage && !u.telegram.some((t) => String(t.chatId) === String(tg.id))) {
    u.telegram.unshift({ chatId: tg.id, title: name, type: 'private' });
  }
  save();
  if (isNew && welcome) notifyUser(u, `🍔 Welcome to <b>${APP_NAME}</b>! Top up in the app to start calling — live transcripts will land right here.`, `New user: ${escapeHtml(userLabel(u))}`);
  else if (isNew && ADMIN_TELEGRAM_CHAT_ID) sendTo(ADMIN_TELEGRAM_CHAT_ID, `🆕 New user: ${escapeHtml(userLabel(u))}`);
  return u;
}

app.post('/api/auth/telegram', throttle, (req, res) => {
  const { initData, widget } = req.body || {};
  let tg = null, canMessage = false;
  if (initData) {
    tg = verifyMiniApp(initData);
    canMessage = !!(tg && tg.allows_write_to_pm !== false); // opened from the bot, so the bot can message them
  } else if (widget) {
    tg = verifyLoginWidget(widget);
    canMessage = !!tg; // the login button asks the user to let the bot message them
  }
  if (!tg || !tg.id) return res.status(401).json({ error: 'Telegram sign-in could not be verified. Please try again.' });
  const u = upsertTelegramUser(tg, canMessage);
  const token = startSession(res, u.id);
  res.json({ token, me: publicUser(u) });
});

// ---------- Email + password accounts (with captcha) ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/signup', throttle, async (req, res) => {
  const { email = '', password = '', callerName = '', captcha = '' } = req.body || {};
  const e = String(email).trim().toLowerCase();
  if (!(await verifyCaptcha(captcha, req.ip))) return res.status(400).json({ error: 'Please complete the captcha.', captcha: true });
  if (!EMAIL_RE.test(e) || e.length > 200) return res.status(400).json({ error: 'Enter a valid email.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (String(password).length > 200) return res.status(400).json({ error: 'Password is too long.' });
  if (!String(callerName).trim()) return res.status(400).json({ error: 'Enter your name or business — calls say who they are from.' });
  if (userByEmail(e)) return res.status(409).json({ error: 'That email already has an account. Sign in instead.' });

  const salt = id(16);
  const u = {
    id: id(12),
    email: e,
    salt,
    passHash: hashPass(String(password), salt),
    callerName: String(callerName).trim().slice(0, 60),
    telegram: [],
    linkCode: null,
    balanceCents: 0,
    createdAt: new Date().toISOString(),
  };
  db.users[u.id] = u;
  if (BONUS_CENTS) adjustBalance(u, BONUS_CENTS, 'bonus', 'Welcome credit');
  save();
  if (ADMIN_TELEGRAM_CHAT_ID) sendTo(ADMIN_TELEGRAM_CHAT_ID, `🆕 New account: ${escapeHtml(e)}`);
  const token = startSession(res, u.id);
  res.json({ token, me: publicUser(u) });
});

app.post('/api/login', throttle, async (req, res) => {
  const { email = '', password = '', captcha = '' } = req.body || {};
  if (!(await verifyCaptcha(captcha, req.ip))) return res.status(400).json({ error: 'Please complete the captcha.', captcha: true });
  const u = userByEmail(String(email).trim().toLowerCase());
  // Same work whether or not the email exists, so response time doesn't reveal which emails have accounts.
  const salt = u ? u.salt : 'no-such-user-salt';
  const attempt = Buffer.from(hashPass(String(password).slice(0, 200), salt), 'hex');
  const ok = !!u && u.passHash && crypto.timingSafeEqual(attempt, Buffer.from(u.passHash, 'hex'));
  if (!ok) return res.status(401).json({ error: 'Wrong email or password.' });
  const token = startSession(res, u.id);
  res.json({ token, me: publicUser(u) });
});

app.post('/api/logout', (req, res) => {
  delete db.sessions[sessionToken(req)];
  save();
  res.setHeader('Set-Cookie', 'cb_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => res.json(publicUser(req.user)));
app.post('/api/me', requireUser, (req, res) => {
  const body = req.body || {};
  if ('callerName' in body) {
    const name = String(body.callerName || '').trim();
    if (!name) return res.status(400).json({ error: 'Caller name cannot be empty.' });
    req.user.callerName = name.slice(0, 60);
  }
  if ('areaCode' in body) {
    const ac = String(body.areaCode || '').replace(/\D/g, '');
    if (ac && !/^[2-9]\d{2}$/.test(ac)) return res.status(400).json({ error: 'Area code must be 3 digits, like 828.' });
    req.user.areaCode = ac;
  }
  save();
  res.json(publicUser(req.user));
});

// ---------- Balance & crypto top-ups ----------
app.get('/api/ledger', requireUser, (req, res) => {
  res.json(db.ledger.filter((l) => l.userId === req.user.id).slice(-30).reverse());
});

app.post('/api/topup', requireUser, async (req, res) => {
  const { amountCents, provider } = req.body || {};
  const cents = parseInt(amountCents, 10);
  if (!PROVIDERS[provider]) return res.status(400).json({ error: 'That payment option is not available.' });
  if (!cents || cents < MIN_TOPUP_CENTS || cents > MAX_TOPUP_CENTS) {
    return res.status(400).json({ error: `Top-ups must be between ${money(MIN_TOPUP_CENTS)} and ${money(MAX_TOPUP_CENTS)}.` });
  }

  const t = { id: 'tp_' + id(10), userId: req.user.id, provider, cents, status: 'pending', createdAt: new Date().toISOString() };
  const back = `${BASE}/?topup=${t.id}`;

  try {
    if (provider === 'nowpayments') {
      const api = NOWPAYMENTS_SANDBOX === 'true' ? 'https://api-sandbox.nowpayments.io/v1' : 'https://api.nowpayments.io/v1';
      const r = await fetch(`${api}/invoice`, {
        method: 'POST',
        headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          price_amount: (cents / 100).toFixed(2),
          price_currency: 'usd',
          order_id: t.id,
          order_description: `${APP_NAME} call credit`,
          ipn_callback_url: `${BASE}/webhooks/nowpayments`,
          success_url: back,
          cancel_url: `${BASE}/?topup=canceled`,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.invoice_url) throw new Error(data.message || `NOWPayments error ${r.status}`);
      t.providerRef = String(data.id);
      t.url = data.invoice_url;
    } else if (provider === 'stripe') {
      const s = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['crypto'],
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cents, product_data: { name: `${APP_NAME} call credit` } } }],
        client_reference_id: t.id,
        metadata: { topupId: t.id, userId: req.user.id },
        success_url: back,
        cancel_url: `${BASE}/?topup=canceled`,
      });
      t.providerRef = s.id;
      t.url = s.url;
    } else if (provider === 'solana') {
      const reference = sol.web3.Keypair.generate().publicKey;
      const amount = new sol.BigNumber(cents).dividedBy(100);
      t.reference = reference.toBase58();
      t.url = sol.pay.encodeURL({
        recipient: sol.recipient,
        amount,
        splToken: sol.usdc,
        reference,
        label: APP_NAME,
        message: `${money(cents)} call credit`,
      }).toString();
      t.expiresAt = new Date(Date.now() + SOL_WINDOW_MS).toISOString();
    } else if (provider === 'bitcoin') {
      const usdPerBtc = await btcPrice();
      // Unique amount: the quoted price plus a few random sats worth at most ~25¢, never matching another open request.
      const base = Math.ceil(((cents / 100) / usdPerBtc) * 1e8);
      const taken = new Set(Object.values(db.topups).filter((x) => x.provider === 'bitcoin' && ['pending', 'confirming'].includes(x.status)).map((x) => x.sats));
      let range = Math.max(100, Math.floor((0.25 / usdPerBtc) * 1e8));
      let sats, tries = 0;
      do {
        if (++tries % 50 === 0) range *= 2; // very busy: widen the range rather than loop forever
        sats = base + 1 + crypto.randomInt(range);
      } while (taken.has(sats));
      t.sats = sats;
      t.btcPrice = usdPerBtc;
      t.expiresAt = new Date(Date.now() + BTC_QUOTE_MS).toISOString();
      t.url = `bitcoin:${btc.address}?amount=${(sats / 1e8).toFixed(8)}&label=${encodeURIComponent(APP_NAME)}&message=${encodeURIComponent(`${money(cents)} call credit`)}`;
    }
    db.topups[t.id] = t;
    save();
    if (provider === 'bitcoin') {
      const qr = await require('qrcode').toDataURL(t.url, { margin: 1, width: 280 });
      return res.json({
        id: t.id,
        kind: 'bitcoin',
        url: t.url,
        qr,
        address: btc.address,
        amount: (t.sats / 1e8).toFixed(8),
        expiresInMinutes: Math.round(BTC_QUOTE_MS / 60000),
      });
    }
    if (provider === 'solana') {
      const qr = await require('qrcode').toDataURL(t.url, { margin: 1, width: 280 });
      return res.json({
        id: t.id,
        kind: 'solana',
        url: t.url,
        qr,
        address: sol.recipient.toBase58(),
        amount: (cents / 100).toFixed(2),
        expiresInMinutes: Math.round(SOL_WINDOW_MS / 60000),
      });
    }
    res.json({ id: t.id, url: t.url });
  } catch (e) {
    console.error('Top-up create failed:', e.message);
    res.status(502).json({ error: 'Could not start the payment. Try again or pick another option.' });
  }
});

app.get('/api/topup/:id', requireUser, async (req, res) => {
  const t = db.topups[req.params.id];
  if (!t || t.userId !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (t.provider === 'solana' && t.status === 'pending') await checkSolanaTopup(t);
  if (t.provider === 'bitcoin' && ['pending', 'confirming'].includes(t.status)) await checkBitcoin();
  res.json({ id: t.id, status: t.status, cents: t.cents, creditedCents: t.creditedCents || 0, balanceCents: req.user.balanceCents || 0 });
});

// Credit a top-up exactly once, no matter how many times a webhook repeats.
function creditTopup(t, cents, providerNote) {
  if (!t || t.status === 'paid') return;
  const u = db.users[t.userId];
  if (!u) return;
  t.status = 'paid';
  t.creditedCents = cents;
  t.paidAt = new Date().toISOString();
  const bal = adjustBalance(u, cents, 'topup', `Crypto top-up (${providerNote})`, t.id);
  notifyUser(u, `💰 <b>${money(cents)} added</b> via ${escapeHtml(providerNote)}\nBalance: <b>${money(bal)}</b>`, `User: ${escapeHtml(userLabel(u))}`);
  // First paid top-up: give this customer their own phone number right away.
  if (DEDICATED && !hasLiveNumber(u) && !u.number && bal >= NUMBER_FEE_CENTS) {
    provisionNumber(u).catch((e) => console.error('Number setup after top-up failed (will retry on first call):', e.message));
  }
}

// Look on-chain for a pending Phantom/Solana payment. Called when the app polls and by a background sweep.
const SOL_WINDOW_MS = 60 * 60 * 1000; // how long a payment request stays open
const solChecking = new Set();
const lastSolCheck = new Map();
async function checkSolanaTopup(t) {
  if (!sol || t.status !== 'pending' || solChecking.has(t.id)) return;
  if (Date.now() - (lastSolCheck.get(t.id) || 0) < 4000) return; // don't hammer the RPC
  lastSolCheck.set(t.id, Date.now());
  solChecking.add(t.id);
  try {
    const reference = new sol.web3.PublicKey(t.reference);
    let found;
    try {
      found = await sol.pay.findReference(sol.connection, reference, { finality: 'confirmed' });
    } catch (e) {
      if (!(e instanceof sol.pay.FindReferenceError)) throw e;
      // Not paid yet. Close it once the window passes (a late payment can still be credited by an admin).
      if (Date.now() > Date.parse(t.expiresAt) + 10 * 60 * 1000) { t.status = 'expired'; save(); }
      return;
    }
    // A signature can only ever pay one top-up.
    if (Object.values(db.topups).some((x) => x.providerRef === found.signature && x.id !== t.id)) return;
    try {
      await sol.pay.validateTransfer(
        sol.connection,
        found.signature,
        { recipient: sol.recipient, amount: new sol.BigNumber(t.cents).dividedBy(100), splToken: sol.usdc, reference },
        { commitment: 'confirmed' }
      );
    } catch (e) {
      if (!(e instanceof sol.pay.ValidateTransferError)) throw e;
      // Wrong amount or token: flag it for you to sort out instead of crediting.
      t.status = 'needs_review';
      t.providerRef = found.signature;
      t.reviewNote = e.message;
      save();
      if (ADMIN_TELEGRAM_CHAT_ID) {
        sendTo(ADMIN_TELEGRAM_CHAT_ID, `⚠️ Phantom payment for top-up <code>${t.id}</code> didn't match (${escapeHtml(e.message)}).\nTx: https://solscan.io/tx/${found.signature}\nUser: ${escapeHtml(userLabel(db.users[t.userId] || {}))}`);
      }
      return;
    }
    t.providerRef = found.signature;
    creditTopup(t, t.cents, 'USDC from Phantom');
  } catch (e) {
    console.error('Solana check failed:', e.message);
  } finally {
    solChecking.delete(t.id);
  }
}
function sweepSolana() {
  Object.values(db.topups)
    .filter((t) => t.provider === 'solana' && t.status === 'pending')
    .forEach((t) => checkSolanaTopup(t));
}

// ----- Bitcoin: price quote and payment matching -----
const BTC_QUOTE_MS = 30 * 60 * 1000; // customer must SEND within 30 min; confirmation can take longer
const BTC_WATCH_MS = 24 * 60 * 60 * 1000; // keep watching for a sent payment to confirm for up to a day
let priceCache = { at: 0, usd: 0 };
async function btcPrice() {
  if (Date.now() - priceCache.at < 60 * 1000 && priceCache.usd) return priceCache.usd;
  const r = await fetch(`${btc.api}/v1/prices`);
  const data = await r.json();
  if (!(data.USD > 0)) throw new Error('Bitcoin price unavailable');
  priceCache = { at: Date.now(), usd: data.USD };
  return data.USD;
}

let btcLastCheck = 0, btcChecking = false;
async function checkBitcoin() {
  if (!btc || btcChecking || Date.now() - btcLastCheck < 10 * 1000) return;
  const open = Object.values(db.topups).filter((t) => t.provider === 'bitcoin' && ['pending', 'confirming'].includes(t.status));
  if (!open.length) return;
  btcChecking = true;
  btcLastCheck = Date.now();
  try {
    const [txsRes, tipRes] = await Promise.all([fetch(`${btc.api}/address/${btc.address}/txs`), fetch(`${btc.api}/blocks/tip/height`)]);
    const txs = await txsRes.json();
    const tip = parseInt(await tipRes.text(), 10);
    const used = new Set(Object.values(db.topups).filter((x) => x.provider === 'bitcoin' && x.providerRef).map((x) => x.providerRef));

    for (const tx of txs) {
      const sats = tx.vout.filter((o) => o.scriptpubkey_address === btc.address).reduce((s, o) => s + o.value, 0);
      if (!sats) continue;
      const t = open.find((x) => x.sats === sats && (!x.providerRef || x.providerRef === tx.txid));
      if (!t || (used.has(tx.txid) && t.providerRef !== tx.txid)) continue;
      // Only count payments made after the request, within its quote window.
      const seenAt = tx.status.confirmed ? tx.status.block_time * 1000 : Date.now();
      if (!t.providerRef && tx.status.confirmed && seenAt < Date.parse(t.createdAt) - 60 * 1000) continue;

      const confs = tx.status.confirmed ? tip - tx.status.block_height + 1 : 0;
      if (!t.providerRef) {
        t.providerRef = tx.txid;
        t.status = 'confirming';
        used.add(tx.txid);
        save();
        if (confs < btc.confirmations) {
          const u = db.users[t.userId];
          if (u) notifyUser(u, `🟠 Bitcoin payment seen for <b>${money(t.cents)}</b> — waiting for ${btc.confirmations} confirmation${btc.confirmations > 1 ? 's' : ''} (usually 10–30 min).`);
        }
      }
      if (confs >= btc.confirmations) creditTopup(t, t.cents, 'Bitcoin');
    }

    // Close requests that were never paid in time.
    for (const t of open) {
      if (t.status === 'pending' && Date.now() > Date.parse(t.expiresAt) + 30 * 60 * 1000) { t.status = 'expired'; save(); }
      if (t.status === 'confirming' && Date.now() - Date.parse(t.createdAt) > BTC_WATCH_MS) {
        t.status = 'needs_review';
        save();
        if (ADMIN_TELEGRAM_CHAT_ID) sendTo(ADMIN_TELEGRAM_CHAT_ID, `⚠️ Bitcoin top-up <code>${t.id}</code> hasn't confirmed after a day.\nTx: https://mempool.space/tx/${t.providerRef}`);
      }
    }
  } catch (e) {
    console.error('Bitcoin check failed:', e.message);
  } finally {
    btcChecking = false;
  }
}

async function stripeWebhook(req, res) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.sendStatus(404);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.warn('Stripe webhook signature failed:', e.message);
    return res.sendStatus(400);
  }
  const s = event.data.object;
  const t = s && db.topups[s.metadata?.topupId || s.client_reference_id];
  // Stablecoin payments can confirm on-chain after checkout, so both events are handled.
  if (event.type === 'checkout.session.completed' && s.payment_status === 'paid') {
    creditTopup(t, s.amount_total, 'USDC');
  } else if (event.type === 'checkout.session.async_payment_succeeded') {
    creditTopup(t, s.amount_total, 'USDC');
  } else if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired') {
    if (t && t.status === 'pending') { t.status = event.type.endsWith('expired') ? 'expired' : 'failed'; save(); }
  }
  res.sendStatus(200);
}

// NOWPayments signs the JSON body with its keys sorted alphabetically (recursively).
const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object'
    ? Object.keys(v).sort().reduce((o, k) => ((o[k] = sortKeys(v[k])), o), {})
    : v;

function nowpaymentsWebhook(req, res) {
  if (!NOWPAYMENTS_IPN_SECRET) return res.sendStatus(404);
  let body;
  try { body = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  const expected = crypto.createHmac('sha512', NOWPAYMENTS_IPN_SECRET).update(JSON.stringify(sortKeys(body))).digest('hex');
  const got = String(req.headers['x-nowpayments-sig'] || '').trim().toLowerCase();
  if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    console.warn('NOWPayments IPN signature failed');
    return res.sendStatus(400);
  }
  const t = db.topups[body.order_id];
  if (t && t.provider === 'nowpayments') {
    const coin = String(body.pay_currency || 'crypto').toUpperCase();
    if (body.payment_status === 'finished') {
      creditTopup(t, t.cents, coin);
    } else if (body.payment_status === 'partially_paid' && t.status === 'pending') {
      // Underpaid: credit what actually arrived, valued at the invoice's own rate.
      const paid = parseFloat(body.actually_paid), asked = parseFloat(body.pay_amount);
      if (paid > 0 && asked > 0) {
        const cents = Math.floor((t.cents * Math.min(paid, asked)) / asked);
        if (cents > 0) creditTopup(t, cents, `${coin}, partial payment`);
      }
    } else if (['failed', 'expired', 'refunded'].includes(body.payment_status) && t.status === 'pending') {
      t.status = body.payment_status;
      save();
    } else if (t.status === 'pending' && ['confirming', 'confirmed', 'sending'].includes(body.payment_status)) {
      t.status = 'confirming';
      save();
    }
  }
  res.sendStatus(200);
}

// Admins can credit or debit an account by hand (refunds, comps, support).
app.post('/api/admin/credit', requireUser, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only.' });
  const { user = '', amountCents, note = '' } = req.body || {};
  // `user` can be an account email, a Telegram user ID, or a Telegram @username.
  const raw = String(user).trim().toLowerCase();
  const who = raw.replace(/^@/, '');
  const u = Object.values(db.users).find(
    (x) => x.email === raw || (x.tgId != null && String(x.tgId) === who) || (x.tgUsername || '').toLowerCase() === who
  );
  const cents = parseInt(amountCents, 10);
  if (!u) return res.status(404).json({ error: 'No account with that email, Telegram ID or username.' });
  if (!cents) return res.status(400).json({ error: 'Enter a non-zero amount.' });
  const bal = adjustBalance(u, cents, 'adjustment', String(note).slice(0, 120) || 'Manual adjustment', `admin:${userLabel(req.user)}`);
  notifyUser(u, `💳 Your balance was adjusted by <b>${money(cents)}</b>${note ? ` (${escapeHtml(String(note).slice(0, 120))})` : ''}.\nBalance: <b>${money(bal)}</b>`);
  res.json({ user: userLabel(u), balanceCents: bal });
});

// ---------- Telegram linking ----------
let botUsername = null;

// A button that opens the app inside Telegram (Mini App). `start` jumps to a screen, e.g. 'topup'.
// A message with the Call a Burger banner on top. Falls back to plain text if Telegram can't fetch the image
// (it needs your public HTTPS address to do that).
function sendPhotoTo(chatId, photoUrl, caption, extra = {}) {
  if (!SECURE_COOKIE) return sendTo(chatId, caption, extra);
  const q = (queues.get(chatId) || Promise.resolve())
    .then(() => tgApi('sendPhoto', { chat_id: chatId, photo: photoUrl, caption: caption.slice(0, 1024), parse_mode: 'HTML', ...extra }))
    .catch((e) => { console.error('Welcome photo failed, sending text:', e.message); return tgApi('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', ...extra }).catch(() => {}); })
    .then(() => sleep(1100));
  queues.set(chatId, q);
  return q;
}

const appButton = (text, start = '') => ({
  reply_markup: { inline_keyboard: [[{ text, web_app: { url: `${BASE}/${start ? `?open=${start}` : ''}` } }]] },
});

app.post('/api/telegram/link', requireUser, (req, res) => {
  if (!botUsername) return res.status(503).json({ error: 'Telegram bot is not ready yet. Check the server log.' });
  req.user.linkCode = { code: id(12), expires: Date.now() + 15 * 60 * 1000 };
  save();
  const code = req.user.linkCode.code;
  res.json({ personal: `https://t.me/${botUsername}?start=${code}`, group: `https://t.me/${botUsername}?startgroup=${code}`, expiresInMinutes: 15 });
});

app.post('/api/telegram/unlink', requireUser, (req, res) => {
  const chatId = String((req.body || {}).chatId || '');
  req.user.telegram = req.user.telegram.filter((t) => String(t.chatId) !== chatId);
  save();
  sendTo(chatId, `🍔 This chat was disconnected from ${APP_NAME}.`);
  res.json(publicUser(req.user));
});

app.post('/api/telegram/test', requireUser, (req, res) => {
  if (!req.user.telegram.length) return res.status(400).json({ error: 'Connect a Telegram chat first.' });
  req.user.telegram.forEach((t) => sendTo(t.chatId, `🍔 Test from ${APP_NAME} — live transcripts will show up here.`));
  res.json({ ok: true });
});

app.post('/telegram/webhook', async (req, res) => {
  if (req.headers['x-telegram-bot-api-secret-token'] !== TG_SECRET) return res.sendStatus(403);
  res.sendStatus(200);
  const msg = req.body && req.body.message;
  if (!msg || !msg.text) return;
  const chat = msg.chat;
  const [cmdRaw, arg] = msg.text.trim().split(/\s+/, 2);
  const cmd = cmdRaw.split('@')[0].toLowerCase();
  const linked = () => Object.values(db.users).filter((u) => u.telegram.some((t) => String(t.chatId) === String(chat.id)));

  const isPrivate = chat.type === 'private';

  // "Connect Telegram" link from the app (/start <code>): attach this chat to that account.
  if (cmd === '/start' && arg && /^[a-f0-9]{24}$/.test(arg)) {
    const u = Object.values(db.users).find((x) => x.linkCode && x.linkCode.code === arg && x.linkCode.expires > Date.now());
    if (!u) return sendTo(chat.id, `🍔 That link has expired. Open ${APP_NAME} and tap <b>Connect Telegram</b> again.`);
    if (!u.telegram.some((t) => String(t.chatId) === String(chat.id))) {
      u.telegram.push({ chatId: chat.id, title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || 'Telegram', type: chat.type });
    }
    // Linking a private chat also lets this person open the app inside Telegram already signed in,
    // unless their Telegram already belongs to a different account.
    if (isPrivate && msg.from && u.tgId == null && !userByTg(msg.from.id)) {
      u.tgId = msg.from.id;
      u.tgName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
      u.tgUsername = msg.from.username || '';
    }
    u.linkCode = null;
    save();
    return sendTo(chat.id, `✅ Connected to <b>${APP_NAME}</b> (${escapeHtml(userLabel(u))}).\nLive transcripts of your calls will appear here.\n/balance — check your balance\n/stop — disconnect`);
  }

  // Private chats: the sender IS the account (Telegram vouches for msg.from via the webhook secret).
  const me = isPrivate && msg.from && !msg.from.is_bot ? upsertTelegramUser(msg.from, true, { welcome: false }) : null;

  if (cmd === '/start' && (!arg || !arg.match(/^[a-f0-9]{24}$/))) {
    if (!isPrivate) return sendTo(chat.id, `🍔 Open ${APP_NAME} in a private chat with me to get started.`, { reply_markup: { inline_keyboard: [[{ text: 'Open chat', url: `https://t.me/${botUsername}` }]] } });
    const bal = me.balanceCents || 0;
    return sendPhotoTo(
      chat.id,
      `${BASE}/social.jpg`,
      `🍔 <b>Welcome to ${APP_NAME}!</b>\n\nType a script, pick a male or female voice, and we'll make the call. You'll get a live transcript right here.\n\n` +
        `💳 Balance: <b>${money(bal)}</b> · ${money(RATE_CENTS)}/min\n` +
        (bal < RATE_CENTS ? `Top up with crypto to place your first call.` : `You're ready to call.`),
      appButton(bal < RATE_CENTS ? '💰 Top up & call' : '📞 Open Call a Burger', bal < RATE_CENTS ? 'topup' : '')
    );
  }
  if (cmd === '/app' || cmd === '/call') {
    if (!isPrivate) return sendTo(chat.id, `Open me in a private chat to place calls.`, { reply_markup: { inline_keyboard: [[{ text: 'Open chat', url: `https://t.me/${botUsername}` }]] } });
    return sendTo(chat.id, `📞 Tap below to open ${APP_NAME}.`, appButton('📞 Open Call a Burger'));
  }
  if (cmd === '/topup') {
    if (!isPrivate) return sendTo(chat.id, `Open me in a private chat to top up.`, { reply_markup: { inline_keyboard: [[{ text: 'Open chat', url: `https://t.me/${botUsername}` }]] } });
    return sendTo(chat.id, `💳 Balance: <b>${money(me.balanceCents || 0)}</b>\nTap below to add funds with crypto.`, appButton('💰 Top up', 'topup'));
  }

  if (cmd === '/balance') {
    if (me) return sendTo(chat.id, `💳 Balance: <b>${money(me.balanceCents || 0)}</b> (≈ ${Math.floor((me.balanceCents || 0) / RATE_CENTS)} min)` + (me.number ? `\n📱 Your number: ${prettyPhone(me.number.phone)}` : ''), appButton('💰 Top up', 'topup'));
    const users = linked();
    if (!users.length) return sendTo(chat.id, `This chat isn't connected to a ${APP_NAME} account.`);
    return sendTo(chat.id, users.map((u) => `💳 ${escapeHtml(userLabel(u))}: <b>${money(u.balanceCents || 0)}</b> (≈ ${Math.floor((u.balanceCents || 0) / RATE_CENTS)} min)`).join('\n'));
  }
  if (cmd === '/stop') {
    unlinkChatEverywhere(chat.id);
    return sendTo(chat.id, `🍔 Disconnected from ${APP_NAME}. You won't get transcripts here anymore.`);
  }
  if (cmd === '/help' && isPrivate) {
    return sendTo(chat.id, `🍔 <b>${APP_NAME}</b>\n/app — open the app and place a call\n/topup — add funds with crypto\n/balance — check your balance\n/stop — stop transcripts in this chat`, appButton('📞 Open Call a Burger'));
  }
});

// ---------- Dedicated numbers ----------
// Each paying account gets its own Twilio number, kept for as long as the monthly fee is covered.
const hasLiveNumber = (u) => u.number && u.number.status === 'active';

async function provisionNumber(u) {
  if (u.provisioning) throw new Error('Your number is still being set up — try again in a moment.');
  u.provisioning = true;
  try {
    // Try the preferred area code first, then any local number in the country.
    let found = [];
    if (u.areaCode) {
      found = await client.availablePhoneNumbers(NUMBER_COUNTRY).local.list({ areaCode: parseInt(u.areaCode, 10), voiceEnabled: true, limit: 5 });
    }
    if (!found.length) found = await client.availablePhoneNumbers(NUMBER_COUNTRY).local.list({ voiceEnabled: true, limit: 5 });
    if (!found.length) throw new Error('No phone numbers are available right now.');

    const bought = await client.incomingPhoneNumbers.create({
      phoneNumber: found[0].phoneNumber,
      friendlyName: `${APP_NAME} – ${userLabel(u)}`.slice(0, 64),
      voiceUrl: `${BASE}/twilio/inbound`,
      voiceMethod: 'POST',
    });
    const now = Date.now();
    u.number = { phone: bought.phoneNumber, sid: bought.sid, status: 'active', assignedAt: new Date(now).toISOString(), paidUntil: new Date(now + PERIOD_MS).toISOString() };
    if (NUMBER_FEE_CENTS) adjustBalance(u, -NUMBER_FEE_CENTS, 'number', `Phone number ${prettyPhone(bought.phoneNumber)} — first month`, bought.sid);
    save();
    notifyUser(u, `📱 <b>Your calling number is ready:</b> ${prettyPhone(bought.phoneNumber)}\nAll your calls now come from this number.${NUMBER_FEE_CENTS ? ` It renews for ${money(NUMBER_FEE_CENTS)} every 30 days from your balance.` : ''}`, `User: ${escapeHtml(userLabel(u))}`);
    return u.number;
  } finally {
    u.provisioning = false;
  }
}

async function releaseNumber(u, reason) {
  const n = u.number;
  if (!n) return;
  try { await client.incomingPhoneNumbers(n.sid).remove(); } catch (e) { console.error('Number release failed:', n.phone, e.message); }
  u.number = null;
  save();
  notifyUser(u, `📴 Your number ${prettyPhone(n.phone)} was released (${reason}). You'll get a new one on your next call.`, `User: ${escapeHtml(userLabel(u))}`);
}

// Renew numbers that are due; release ones unpaid past the grace period. Runs every 6 hours and before each call.
function renewNumber(u) {
  const n = u.number;
  if (!n || Date.now() < Date.parse(n.paidUntil)) return;
  if ((u.balanceCents || 0) >= NUMBER_FEE_CENTS) {
    if (NUMBER_FEE_CENTS) adjustBalance(u, -NUMBER_FEE_CENTS, 'number', `Phone number ${prettyPhone(n.phone)} — monthly renewal`, n.sid);
    n.paidUntil = new Date(Date.parse(n.paidUntil) + PERIOD_MS).toISOString();
    n.status = 'active';
    save();
  } else if (Date.now() > Date.parse(n.paidUntil) + GRACE_MS) {
    releaseNumber(u, 'renewal not paid');
  } else if (n.status !== 'past_due') {
    n.status = 'past_due';
    save();
    notifyUser(u, `⚠️ Your number ${prettyPhone(n.phone)} needs ${money(NUMBER_FEE_CENTS)} to renew. Add funds within ${Math.round(GRACE_MS / 86400000)} days to keep it.`);
  }
}
function sweepNumbers() { Object.values(db.users).forEach((u) => { try { renewNumber(u); } catch (e) { console.error(e); } }); }

// Someone calls a user's number back: voicemail, with the message sent to that user's Telegram.
const userByNumber = (phone) => Object.values(db.users).find((u) => u.number && u.number.phone === phone);

app.post('/twilio/inbound', verifyTwilio, (req, res) => {
  const u = userByNumber(req.body.To);
  const vr = new twilio.twiml.VoiceResponse();
  if (!u) {
    vr.say({ voice: VOICE_FEMALE }, 'This number is not in service.');
    vr.hangup();
  } else {
    vr.say({ voice: VOICE_FEMALE }, `You've reached ${u.callerName}. Please leave a message after the tone.`);
    vr.record({
      maxLength: 120,
      playBeep: true,
      transcribe: true,
      transcribeCallback: `${BASE}/twilio/voicemail`,
    });
    vr.say({ voice: VOICE_FEMALE }, 'Thank you. Goodbye.');
    notifyUser(u, `📲 <b>Incoming call</b> to your number from ${escapeHtml(req.body.From || 'unknown')}`);
  }
  res.type('text/xml').send(vr.toString());
});

app.post('/twilio/voicemail', verifyTwilio, (req, res) => {
  const { To, From, TranscriptionText, TranscriptionStatus, RecordingDuration } = req.body;
  const u = userByNumber(To);
  // The transcription callback carries the text; the plain recording callback is only used if transcription fails.
  if (u && TranscriptionStatus === 'completed' && TranscriptionText) {
    notifyUser(u, `📩 <b>Voicemail</b> from ${escapeHtml(From || 'unknown')}:\n${escapeHtml(TranscriptionText)}`);
  } else if (u && TranscriptionStatus === 'failed') {
    notifyUser(u, `📩 <b>Voicemail</b> from ${escapeHtml(From || 'unknown')} (couldn't transcribe — listen in your Twilio console).`);
  }
  res.sendStatus(204);
});

// ---------- Calls ----------
const FINAL = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];

// Rough length of a call: speech at ~150 words/min, plus the intro, the listening pause and ringing slack.
function estimateSeconds(text, listen) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words / 2.5) + (ANNOUNCE_CALLER !== 'false' ? 4 : 0) + listen + 3;
}

app.post('/api/call', requireUser, async (req, res) => {
  const u = req.user;
  const { to, script, voice = 'female', listenSeconds = 15, consent } = req.body || {};

  if (!consent) return res.status(400).json({ error: 'Confirm the person agreed to receive this call.' });
  if (!to || !E164.test(to)) return res.status(400).json({ error: 'Phone number must be in +15551234567 format.' });
  if (!script || !String(script).trim()) return res.status(400).json({ error: 'Script is empty.' });
  if (!VOICES[voice]) return res.status(400).json({ error: 'Voice must be "male" or "female".' });
  if (callsToday(u) >= LIMIT) return res.status(429).json({ error: `Daily limit of ${LIMIT} calls reached.` });

  // One call at a time per account, so two calls can't spend the same balance.
  const active = Object.values(db.calls).find(
    (c) => c.userId === u.id && !FINAL.includes(c.status) && Date.now() - Date.parse(c.createdAt) < MAX_CALL_SECONDS * 1000
  );
  if (active) return res.status(409).json({ error: 'You already have a call in progress. Wait for it to end.' });

  const listen = Math.max(0, Math.min(60, parseInt(listenSeconds, 10) || 0));
  const text = String(script).trim();

  // Keep the user's number current before anything else.
  if (DEDICATED) renewNumber(u);
  if (DEDICATED && u.number && u.number.status === 'past_due') {
    return res.status(402).json({ error: `Your number ${prettyPhone(u.number.phone)} needs ${money(NUMBER_FEE_CENTS)} to renew. Add funds to keep calling from it.`, needsFunds: true });
  }
  const needsNumber = DEDICATED && !hasLiveNumber(u);

  // Balance check: must cover the estimated length (plus the first month of a new number),
  // and the call is hard-capped at what the balance can pay for.
  const estMinutes = Math.max(1, Math.ceil(estimateSeconds(text, listen) / 60));
  const numberFee = needsNumber ? NUMBER_FEE_CENTS : 0;
  const needed = estMinutes * RATE_CENTS + numberFee;
  if ((u.balanceCents || 0) < needed) {
    return res.status(402).json({
      error: `This call needs about ${estMinutes} min (${money(estMinutes * RATE_CENTS)})` +
        (numberFee ? ` plus ${money(numberFee)} for your own phone number's first month` : '') +
        `. Your balance is ${money(u.balanceCents || 0)} — add funds to continue.`,
      needsFunds: true,
    });
  }

  // First paid call: get this account its own number.
  if (needsNumber) {
    try {
      await provisionNumber(u);
    } catch (e) {
      console.error('Number provisioning failed:', e.message);
      return res.status(503).json({ error: `Couldn't set up your phone number: ${e.message}` });
    }
  }
  const fromNumber = DEDICATED ? u.number.phone : TWILIO_FROM_NUMBER;
  const balance = u.balanceCents || 0;
  const affordableMinutes = Math.floor(balance / RATE_CENTS);
  const timeLimit = Math.min(MAX_CALL_SECONDS, affordableMinutes * 60);

  // Record only when there's a Telegram chat to deliver the recording to.
  const record = RECORD_CALLS !== 'false' && u.telegram.length > 0;

  const vr = new twilio.twiml.VoiceResponse();
  // partialResults: words show on the Live call screen while they're being spoken.
  vr.start().transcription({ statusCallbackUrl: `${BASE}/twilio/transcription`, track: 'both_tracks', languageCode: 'en-US', partialResults: true });
  vr.pause({ length: 1 });
  if (ANNOUNCE_CALLER !== 'false' || record) {
    // Recorded calls always say so — required in states where everyone on the call must consent.
    const intro = ANNOUNCE_CALLER !== 'false' ? `Hello, this is an automated call from ${u.callerName}.` : 'Hello.';
    vr.say({ voice: VOICES[voice] }, record ? `${intro} This call is recorded.` : intro);
  }
  vr.say({ voice: VOICES[voice] }, text);
  if (listen > 0) vr.pause({ length: listen });
  vr.hangup();
  const twiml = vr.toString();
  if (twiml.length > 4000) return res.status(400).json({ error: 'Script is too long for one call (about 3,500 characters max).' });

  try {
    const call = await client.calls.create({
      to,
      from: fromNumber,
      twiml,
      timeLimit,
      statusCallback: `${BASE}/twilio/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      ...(record ? { record: true, recordingStatusCallback: `${BASE}/twilio/recording`, recordingStatusCallbackEvent: ['completed'] } : {}),
    });

    // Only the most recent conversation is kept: clear this customer's earlier transcripts now.
    Object.values(db.calls).filter((c) => c.userId === u.id && !c.purged).forEach((c) => purgeConversation(c));

    const rec = { sid: call.sid, userId: u.id, to, from: fromNumber, voice, script: text, status: call.status, transcript: [], recorded: record, createdAt: new Date().toISOString(), chargedCents: null };
    db.calls[call.sid] = rec;
    save();

    notifyCall(
      rec,
      `📞 <b>Call started</b>\nTo: ${escapeHtml(to)}\nFrom: ${prettyPhone(fromNumber)}\nVoice: ${voice}\nRate: ${money(RATE_CENTS)}/min · Balance: ${money(balance)}\nCall ID: <code>${call.sid}</code>\n\n<b>Script</b>\n${escapeHtml(text)}`,
      `User: ${escapeHtml(userLabel(u))}`
    );
    res.json({ sid: call.sid, status: call.status, maxMinutes: affordableMinutes });
  } catch (e) {
    console.error('Call failed:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// What the app sees of a call. Live partial text comes from memory, never from disk.
const callView = (rec) => ({
  sid: rec.sid, to: rec.to, from: rec.from, voice: rec.voice, status: rec.status,
  createdAt: rec.createdAt, answeredAt: rec.answeredAt || null, endedAt: rec.endedAt || null,
  durationSeconds: rec.durationSeconds ?? null, chargedCents: rec.chargedCents, recorded: !!rec.recorded,
  purged: !!rec.purged,
  deleteAt: rec.endedAt && !rec.purged ? new Date(Date.parse(rec.endedAt) + KEEP_MS).toISOString() : null,
  transcript: rec.purged ? [] : rec.transcript,
  partial: rec.purged ? {} : partials.get(rec.sid) || {},
});

app.get('/api/calls', requireUser, (req, res) => {
  res.json(Object.values(db.calls).filter((c) => c.userId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25).map(callView));
});
app.get('/api/calls/:sid', requireUser, (req, res) => {
  const rec = db.calls[req.params.sid];
  if (!rec || rec.userId !== req.user.id) return res.status(404).json({ error: 'Not found' });
  res.json(callView(rec));
});

// ---------- Keep only the latest conversation, for one hour ----------
const KEEP_MS = Math.max(1, parseInt(KEEP_CONVERSATION_MINUTES, 10) || 60) * 60 * 1000;
const partials = new Map(); // callSid -> { caller, recipient } words being spoken right now (memory only)

// Deletes what was said (transcript, script, any undelivered recording). Billing facts — number dialed,
// duration, cost — stay so the balance history still adds up.
function purgeConversation(rec) {
  if (rec.purged) return;
  rec.transcript = [];
  rec.script = null;
  rec.purged = true;
  partials.delete(rec.sid);
  if (rec.recordingSid && !rec.recordingDeleted) deleteRecording(rec);
  save();
}
function sweepConversations() {
  for (const rec of Object.values(db.calls)) {
    if (!rec.purged && rec.endedAt && Date.now() - Date.parse(rec.endedAt) >= KEEP_MS) purgeConversation(rec);
    // A recording that couldn't be delivered: retry until the hour is up.
    if (rec.recordingSid && !rec.recordingDeleted && !rec.recordingSent && !rec.purged) deliverRecording(rec);
  }
}

// ---------- Call recordings → Telegram ----------
// The logo, used as artwork on recordings sent to Telegram.
const THUMB = (() => { try { return fs.readFileSync(path.join(__dirname, 'public', 'thumb.jpg')); } catch { return null; } })();
const twilioAuth = 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

async function tgSendAudio(chatId, buf, filename, caption) {
  if (TELEGRAM_MOCK === 'true') { console.log(`[telegram:sendAudio] ${chatId} ${filename} ${buf.length} bytes — ${caption}`); return; }
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('title', filename.replace(/\.mp3$/, ''));
  form.append('audio', new Blob([buf], { type: 'audio/mpeg' }), filename);
  form.append('performer', APP_NAME);
  if (THUMB) form.append('thumbnail', new Blob([THUMB], { type: 'image/jpeg' }), 'thumb.jpg'); // logo as the track artwork
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendAudio`, { method: 'POST', body: form });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) throw new Error(`sendAudio: ${data.description || r.status}`);
}

const delivering = new Set();
async function deliverRecording(rec) {
  if (delivering.has(rec.sid) || rec.recordingSent) return;
  const last = rec.recordingTriedAt ? Date.parse(rec.recordingTriedAt) : 0;
  if (Date.now() - last < 60 * 1000) return; // retry at most once a minute
  delivering.add(rec.sid);
  rec.recordingTriedAt = new Date().toISOString();
  try {
    const u = db.users[rec.userId];
    const chats = u ? u.telegram.map((t) => t.chatId) : [];
    if (!chats.length) throw new Error('no Telegram chat connected');
    const r = await fetch(`${rec.recordingUrl}.mp3`, { headers: { Authorization: twilioAuth } });
    if (!r.ok) throw new Error(`download ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 49 * 1024 * 1024) throw new Error('recording is over Telegram’s 50 MB limit');
    const secs = rec.recordingSeconds || rec.durationSeconds || 0;
    const len = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const when = new Date(rec.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    const caption = `🎙 <b>Call recording</b> — to ${escapeHtml(rec.to)} · ${len}`;
    let sent = 0;
    for (const chatId of chats) {
      try { await tgSendAudio(chatId, buf, `Call ${rec.to} ${when}.mp3`, caption); sent++; } catch (e) { console.error(`Recording to ${chatId} failed:`, e.message); }
    }
    if (!sent) throw new Error('could not send to any chat');
    rec.recordingSent = true;
    save();
    await deleteRecording(rec); // Telegram is the copy; nothing is kept on Twilio
  } catch (e) {
    console.error(`Recording delivery for ${rec.sid} failed (will retry):`, e.message);
  } finally {
    delivering.delete(rec.sid);
  }
}
async function deleteRecording(rec) {
  try {
    await client.recordings(rec.recordingSid).remove();
  } catch (e) {
    if (e.status !== 404) { console.error('Recording delete failed:', e.message); return; }
  }
  rec.recordingDeleted = true;
  save();
}

app.post('/twilio/recording', verifyTwilio, (req, res) => {
  const { CallSid, RecordingSid, RecordingUrl, RecordingStatus, RecordingDuration } = req.body;
  const rec = db.calls[CallSid];
  if (rec && RecordingStatus === 'completed' && RecordingSid && !rec.recordingSid) {
    rec.recordingSid = RecordingSid;
    rec.recordingUrl = RecordingUrl;
    rec.recordingSeconds = parseInt(RecordingDuration, 10) || 0;
    save();
    if (rec.purged) deleteRecording(rec);
    else deliverRecording(rec);
  }
  res.sendStatus(204);
});

// ---------- Twilio webhooks ----------
const STATUS_LABEL = {
  initiated: '⏳ Dialing', ringing: '🔔 Ringing', 'in-progress': '✅ Answered', completed: '🏁 Call ended',
  busy: '🚫 Busy', 'no-answer': '📵 No answer', failed: '❌ Failed', canceled: '⛔ Canceled',
};

app.post('/twilio/status', verifyTwilio, (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  const rec = db.calls[CallSid];
  // Ignore repeats of an event we've already handled.
  if (rec && !(rec.status === CallStatus && FINAL.includes(CallStatus))) {
    rec.status = CallStatus;
    if (CallStatus === 'in-progress' && !rec.answeredAt) rec.answeredAt = new Date().toISOString();
    if (FINAL.includes(CallStatus) && !rec.endedAt) { rec.endedAt = new Date().toISOString(); partials.delete(CallSid); }
    let msg = `${STATUS_LABEL[CallStatus] || CallStatus} — <code>${CallSid}</code>`;

    // Charge once, when the call ends: every started minute of connected time. Unanswered calls are free.
    if (CallStatus === 'completed' && rec.chargedCents === null) {
      const secs = parseInt(CallDuration, 10) || 0;
      const minutes = Math.ceil(secs / 60);
      const cost = minutes * RATE_CENTS;
      rec.durationSeconds = secs;
      rec.chargedCents = cost;
      const u = db.users[rec.userId];
      if (u && cost > 0) {
        const bal = adjustBalance(u, -cost, 'call', `${minutes} min call to ${rec.to}`, CallSid);
        msg += `\nDuration: ${secs}s · Charged ${minutes} min × ${money(RATE_CENTS)} = <b>${money(cost)}</b>\nBalance: <b>${money(bal)}</b>`;
        if (bal < RATE_CENTS * 2) msg += `\n⚠️ Balance is low — add funds in the app.`;
      } else {
        msg += `\nDuration: ${secs}s · No charge`;
      }
    } else if (FINAL.includes(CallStatus) && CallStatus !== 'completed' && rec.chargedCents === null) {
      rec.chargedCents = 0;
      msg += `\nNo charge`;
    }
    if (CallStatus === 'completed') {
      const mins = Math.round(KEEP_MS / 60000);
      msg += `\n🗑 The app deletes this transcript ${mins >= 60 && mins % 60 === 0 ? `${mins / 60} hour${mins > 60 ? 's' : ''}` : `${mins} min`} after the call. It stays here in Telegram.`;
      if (rec.recorded) msg += `\n🎙 Recording coming up…`;
    }
    save();
    notifyCall(rec, msg);
  }
  res.sendStatus(204);
});

app.post('/twilio/transcription', verifyTwilio, (req, res) => {
  const { TranscriptionEvent, CallSid, Track, Final } = req.body;
  const rec = db.calls[CallSid];
  if (rec && !rec.purged && TranscriptionEvent === 'transcription-content') {
    let data = {};
    try { data = JSON.parse(req.body.TranscriptionData || '{}'); } catch {}
    const text = (data.transcript || '').trim();
    const who = Track === 'outbound_track' ? 'caller' : 'recipient';
    if (Final === 'false') {
      // Still talking: show it live on screen only.
      if (text) partials.set(CallSid, { ...(partials.get(CallSid) || {}), [who]: text });
    } else if (text) {
      const p = partials.get(CallSid);
      if (p) { delete p[who]; }
      const speaker = who === 'caller' ? 'Caller (bot)' : 'Recipient';
      const icon = who === 'caller' ? '🤖' : '👤';
      rec.transcript.push({ speaker, text, at: new Date().toISOString() });
      save();
      notifyCall(rec, `${icon} <b>${speaker}:</b> ${escapeHtml(text)}`);
    }
  } else if (rec && TranscriptionEvent === 'transcription-error') {
    notifyCall(rec, `⚠️ Transcription error on <code>${CallSid}</code>`);
  }
  res.sendStatus(204);
});

// ---------- Start ----------
async function setupTelegram() {
  try {
    const me = await tgApi('getMe');
    botUsername = me.username;
    if (TELEGRAM_MOCK !== 'true') {
      await tgApi('setWebhook', { url: `${BASE}/telegram/webhook`, secret_token: TG_SECRET, allowed_updates: ['message'] });
      // The bot's menu button opens the app inside Telegram, and the "/" menu lists the commands.
      if (SECURE_COOKIE) {
        await tgApi('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Call a Burger', web_app: { url: `${BASE}/` } } });
      } else {
        console.warn('PUBLIC_BASE_URL is not HTTPS — Telegram will not open the app inside Telegram until it is.');
      }
      await tgApi('setMyCommands', {
        commands: [
          { command: 'app', description: 'Open the app and place a call' },
          { command: 'topup', description: 'Add funds with crypto' },
          { command: 'balance', description: 'Check your balance' },
          { command: 'help', description: 'How it works' },
          { command: 'stop', description: 'Stop transcripts in this chat' },
        ],
      });
    }
    console.log(`Telegram bot @${botUsername} connected (webhook: ${BASE}/telegram/webhook)`);
  } catch (e) {
    console.error('Telegram setup failed — check TELEGRAM_BOT_TOKEN:', e.message);
  }
}

app.listen(PORT, () => {
  console.log(`${APP_NAME} running on port ${PORT}`);
  console.log(`App: ${BASE}/  ·  Rate ${money(RATE_CENTS)}/min  ·  Crypto: ${Object.keys(PROVIDERS).join(', ') || 'none configured'}`);
  setupTelegram();
  if (DEDICATED) {
    sweepNumbers();
    setInterval(sweepNumbers, 6 * 60 * 60 * 1000);
  }
  // Catches Phantom payments even if the customer closed the app before it confirmed.
  if (sol) setInterval(sweepSolana, 20 * 1000);
  if (btc) setInterval(checkBitcoin, 60 * 1000);
  // Delete conversations an hour after hang-up (and retry any undelivered recordings).
  sweepConversations();
  setInterval(sweepConversations, 60 * 1000);
});
