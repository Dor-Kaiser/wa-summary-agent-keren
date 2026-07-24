const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const axios = require('axios');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
let lastQR = null;
let isReady = false;
let connectionStatus = 'starting';
let eventLog = [];
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const AUTH_DIR = path.join(DATA_DIR, '.wwebjs_auth');
const DB_PATH = path.join(DATA_DIR, 'messages.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });

function log(emoji, msg) {
  const entry = `${new Date().toISOString()} ${emoji} ${msg}`;
  console.log(entry);
  eventLog.unshift(entry);
  if (eventLog.length > 200) eventLog.pop();
}

const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const TARGET_GROUP_NAME = process.env.TARGET_GROUP_NAME || '';
const MY_NUMBER         = process.env.MY_NUMBER || '';
const SUMMARY_HOUR      = process.env.SUMMARY_HOUR || '18';
const SUMMARY_MINUTE    = process.env.SUMMARY_MINUTE || '0';
const SUMMARY_TIMEZONE  = process.env.SUMMARY_TIMEZONE || 'Asia/Jerusalem';
const REQUIRED_ENV      = ['GEMINI_API_KEY', 'TARGET_GROUP_NAME', 'MY_NUMBER'];

log('⚙️', `Config — GROUP="${TARGET_GROUP_NAME}" NUMBER="${MY_NUMBER}" SUMMARY=${SUMMARY_HOUR}:${SUMMARY_MINUTE} TZ=${SUMMARY_TIMEZONE}`);

function missingEnv() {
  return REQUIRED_ENV.filter(name => !process.env[name]);
}

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '');
}

function todayInTZ() {
  return new Date().toLocaleDateString('en-CA', { timeZone: SUMMARY_TIMEZONE });
}

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id    TEXT,
    day       TEXT NOT NULL,
    sender    TEXT,
    body      TEXT,
    timestamp INTEGER,
    UNIQUE(timestamp, sender)
  )
`);
const messageCols = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
if (!messageCols.includes("msg_id")) {
  db.exec("ALTER TABLE messages ADD COLUMN msg_id TEXT");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_msg_id ON messages(msg_id)");
log('🗄️', `Database ready at ${DB_PATH}`);

function saveMessage(msgId, sender, body, ts) {
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    log("ERR", "saveMessage invalid ts: " + String(ts) + " msgId=" + String(msgId));
    return;
  }
  const day = new Date(tsNum * 1000).toISOString().slice(0, 10);
  try {
    db.prepare("INSERT OR IGNORE INTO messages (msg_id, day, sender, body, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run(String(msgId || (String(tsNum) + "-" + String(sender || "unknown"))), day, String(sender || "Unknown"), String(body || ""), tsNum);
    log("SAVE", "Saved [" + day + "] from " + String(sender) + ': "' + String(body).slice(0, 60) + '"');
  } catch (e) {
    log("ERR", "Failed to save message: " + e.message);
  }
}

function fetchLast24HoursMessages() {
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - 86400;
  log("FETCH", "Fetching messages from last 24h: since=" + sinceSec + " now=" + nowSec);
  return db.prepare("SELECT sender, body, timestamp FROM messages WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp")
    .all(sinceSec, nowSec);
}

function deleteOldMessages() {
  db.prepare("DELETE FROM messages WHERE day < date('now', '-7 days')").run();
}

async function summariseMessages(messages) {
  if (!messages.length) return 'No messages were received in this group today.';
  const transcript = messages.map(m => {
    const time = new Date(m.timestamp * 1000).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', timeZone: SUMMARY_TIMEZONE
    });
    return `[${time}] ${m.sender}: ${m.body}`;
  }).join('\n');
  const prompt = `You are a concise assistant that summarises WhatsApp group conversations.
Given the messages below, produce a brief daily summary with exactly three sections:
1. 📌 Key Topics Discussed
2. ✅ Important Decisions Made
3. 📋 Action Items / Tasks
Be concise. Use bullet points. If a section has nothing, write "None".
Messages:
${transcript}`;
  log('🤖', `Sending ${messages.length} messages to Gemini for summarisation`);
  let res, lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: prompt }] }] },
        { timeout: 60000 }
      );
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        log("\u26a0\ufe0f", `Gemini attempt ${attempt} failed (${e.message}), retrying in ${attempt * 2}s...`);
        await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }
  }
  if (!res) throw lastErr;
  const summary = res?.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!summary) throw new Error("Gemini returned empty or unexpected response");
  return summary;
}

let isSummaryRunning = false;
async function dailySummaryJob() {
  if (isSummaryRunning) {
    log("SUM", "Skip: daily summary already running");
    return;
  }
  isSummaryRunning = true;
  log('⏰', 'Running daily summary job');
  try {
    const syncOk = await syncTodayMessagesFromWhatsApp();

    if (!syncOk) {
      log('❌', 'Skipping summary because WhatsApp sync failed');
      return;
    }

    const messages = fetchLast24HoursMessages();

    if (messages.length === 0) {
      log('📊', 'Skipping summary: no messages found');
      return;
    }

    log('📊', `Total messages to summarise: ${messages.length}`);
    const summary = await withTimeout(summariseMessages(messages), 90000, "summariseMessages");
    const today = new Date().toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: SUMMARY_TIMEZONE
    });
    const text = `📊 *Daily Group Summary — ${today}*\n\n${summary}`;
    for (const num of MY_NUMBER.split(",").map(n => n.trim()).filter(Boolean)) {
      try {
        const numberId = await client.getNumberId(num);
        if (!numberId) { log('⚠️', `Number not on WhatsApp, skipping: ${num}`); continue; }
        await withTimeout(client.sendMessage(numberId._serialized, text), 30000, "sendMessage");
        log('✅', `Summary sent to ${num}`);
      } catch (e) {
        log('❌', `Failed to send to ${num}: ${e.message}`);
      }
    }
    deleteOldMessages();
  } catch (err) {
    log('❌', `Daily summary failed: ${err.message}`);
    throw err;
  } finally {
    isSummaryRunning = false;
  }
}


let cachedTargetChat = null;

let isSyncRunning = false;

async function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(label + " timed out after " + ms + "ms")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}


async function syncTodayMessagesFromWhatsApp() {
  if (isSyncRunning) {
    log("SYNC", "Skip: already running");
    return;
  }

  isSyncRunning = true;
  log("SYNC", "Start");

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceSec = nowSec - 172800;

    async function waitForStoreReady() {
      for (let i = 1; i <= 20; i++) {
        try {
          const ready = await client.pupPage.evaluate(() => {
            return !!(window.Store && window.Store.Chat && window.Store.Msg);
          });

          if (ready) {
            log("WAIT", "WhatsApp Store ready");
            return;
          }
        } catch (e) {}

        log("WAIT", `Store not ready (${i}/20)`);
        await new Promise(r => setTimeout(r, 3000));
      }

      throw new Error("WhatsApp Store never became ready");
    }

    await waitForStoreReady();

    const normalize = s => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "");

    let target = cachedTargetChat;

    if (!target) {
      let chats;

      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          chats = await withTimeout(client.getChats(), 30000, "getChats");
          break;
        } catch (e) {
          log("WARN", `getChats attempt ${attempt}/5 failed: ${e.message || e}`);
          if (attempt === 5) throw e;
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      const groups = chats.filter(c => c.isGroup);
      target = groups.find(g => normalize(g.name).includes(normalize(TARGET_GROUP_NAME)));

      if (!target) {
        log("WARN", "Target group not found: " + TARGET_GROUP_NAME);
        return;
      }

      cachedTargetChat = target;
      log("SYNC", "Cached target group: " + target.name);
    }

    await withTimeout(target.fetchMessages({ limit: 1 }), 15000, "warmup fetch");
    const messages = await withTimeout(target.fetchMessages({ limit: 2000 }), 45000, "fetchMessages");
    if (messages.length) {
      const toSec = (v) => {
        const n = Number(v || 0);
        return n > 1000000000000 ? Math.floor(n / 1000) : Math.floor(n);
      };
      const secs = messages.map(m => toSec(m.timestamp)).filter(Boolean);
      const minTs = Math.min(...secs);
      const maxTs = Math.max(...secs);
      log("SYNC", "Fetched ts range min=" + minTs + " max=" + maxTs + " count=" + secs.length);
      log("SYNC", "Fetched ts ISO min=" + new Date(minTs * 1000).toISOString() + " max=" + new Date(maxTs * 1000).toISOString());
    }

    let saved = 0, old = 0, dup = 0;

    for (const msg of messages) {
      const rawTs = Number(msg.timestamp || 0);
      const ts = rawTs > 1000000000000 ? Math.floor(rawTs / 1000) : Math.floor(rawTs);
      if (!ts || ts < sinceSec || ts > nowSec) { old++; continue; }

      const msgId = (msg.id && (msg.id._serialized || msg.id.id)) || (String(ts) + "-" + (msg.author || msg.from || "unknown"));
      const exists = db.prepare("SELECT id FROM messages WHERE msg_id = ?").get(msgId);
      if (exists) { dup++; continue; }

      const sender = (msg._data && msg._data.notifyName) || msg.author || msg.from || "Unknown";
      if (!msg.body || msg.body.trim().length === 0) { old++; continue; }
      const body = msg.body.trim();

      saveMessage(msgId, sender, body, ts);
      saved++;
    }

    log("SYNC", "Done: fetched=" + messages.length + " saved=" + saved + " old=" + old + " dup=" + dup);
  } catch (e) {
    log("ERR", "SYNC failed: " + (e?.message || String(e)));
    log("ERR", e?.stack || "no stack");
  } finally {
    isSyncRunning = false;
  }
}

const style = `font-family:sans-serif;background:#111;color:#fff;padding:40px;text-align:center`;
const monoStyle = `font-family:monospace;background:#111;color:#eee;padding:30px`;

app.get('/', async (req, res) => {
  const missing = missingEnv();
  if (missing.length) {
    return res.send(`<html><body style="${style}">
      <h1>⚠️ Missing configuration</h1>
      <p>Set these environment variables and restart:</p>
      <pre style="display:inline-block;text-align:left;background:#222;padding:16px;border-radius:8px">${missing.join('\n')}</pre>
    </body></html>`);
  }
  if (isReady) {
    return res.send(`<html><body style="${style}">
      <h1>✅ Connected to WhatsApp</h1>
      <p>Monitoring: <strong>${TARGET_GROUP_NAME}</strong></p>
      <p>Daily summary at <strong>${SUMMARY_HOUR}:${String(SUMMARY_MINUTE).padStart(2,'0')}</strong> (${SUMMARY_TIMEZONE})</p>
      <br>
      <a href="/sync" style="background:#25D366;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;margin:8px;display:inline-block">🔄 Sync Messages</a>
      <a href="/summary" style="background:#128C7E;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;margin:8px;display:inline-block">📊 Send Summary Now</a>
      <br><br>
      <a href="/debug" style="color:#aaa;margin:10px;display:inline-block">📋 View Captured Messages</a>
      <a href="/diagnose" style="color:#aaa;margin:10px;display:inline-block">🔍 Diagnose Groups</a>
      <a href="/eventlog" style="color:#aaa;margin:10px;display:inline-block">📜 Event Log</a>
    </body></html>`);
  }
  if (!lastQR) {
    return res.send(`<html><head><meta http-equiv="refresh" content="3"></head>
    <body style="${style}"><h1>⏳ ${connectionStatus}</h1><p>Refreshing...</p></body></html>`);
  }
  const qrImage = await QRCode.toDataURL(lastQR);
  res.send(`<html><head><meta http-equiv="refresh" content="30"></head>
  <body style="${style}">
    <h1>📱 Scan with WhatsApp</h1>
    <p>Settings → Linked Devices → Link a Device</p>
    <img src="${qrImage}" style="width:300px;height:300px;border:10px solid white;border-radius:12px"/>
  </body></html>`);
});

app.get('/health', (req, res) => {
  res.json({ status: missingEnv().length ? 'missing_config' : (isReady ? 'ok' : 'connecting'), ready: isReady, connectionStatus, timezone: SUMMARY_TIMEZONE, todayInTZ: todayInTZ(), missing: missingEnv() });
});

app.get('/sync', async (req, res) => {
  if (!isReady) return res.send(`<html><body style="${style}"><h1>⚠️ Not connected yet</h1><a href="/">← Back</a></body></html>`);
  await syncTodayMessagesFromWhatsApp();
  const messages = fetchLast24HoursMessages();
  res.send(`<html><body style="${style}"><h1>🔄 Sync complete</h1><p>Found <strong>${messages.length}</strong> messages from today.</p><a href="/debug" style="color:#25D366">📋 View messages</a> &nbsp;<a href="/" style="color:#aaa">← Back</a></body></html>`);
});

app.get('/summary', async (req, res) => {
  if (!isReady) return res.send(`<html><body style="${style}"><h1>⚠️ Not connected yet</h1><a href="/">← Back</a></body></html>`);
  try {
    await dailySummaryJob();
    res.send(`<html><body style="${style}"><h1>✅ Summary sent!</h1><a href="/" style="color:#25D366">← Back</a></body></html>`);
  } catch (err) {
    log('❌', `Summary error: ${err.message}`);
    res.send(`<html><body style="${monoStyle}"><h1 style="color:red">Error</h1><pre>${err.message}\n${err.stack}</pre></body></html>`);
  }
});

app.get('/debug', (req, res) => {
  const messages = db.prepare('SELECT * FROM messages ORDER BY timestamp DESC LIMIT 100').all();
  const total = db.prepare('SELECT COUNT(*) as n FROM messages').get();
  res.send(`<html><body style="${monoStyle}"><h2>📋 Messages in DB: ${total.n} total, showing last 100</h2>${messages.length === 0 ? '<p style="color:orange">⚠️ No messages yet. Try /sync first.</p>' : ''}${messages.map(m => `<div style="border-bottom:1px solid #333;padding:6px 0"><span style="color:#aaa">${new Date(m.timestamp*1000).toLocaleString('en-GB', { timeZone: SUMMARY_TIMEZONE })} [${m.day}]</span><strong style="color:#25D366"> ${m.sender}</strong>: ${m.body}</div>`).join('')}<br><a href="/" style="color:#25D366">← Back</a></body></html>`);
});

app.get('/diagnose', async (req, res) => {
  if (!isReady) return res.send(`<html><body style="${style}"><h1>⚠️ Not connected yet</h1><a href="/">← Back</a></body></html>`);
  try {
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);
    const today = todayInTZ();
    res.send(`<html><body style="${monoStyle}"><h2>🔍 Diagnostics</h2><p>Server time (UTC): <strong>${new Date().toISOString()}</strong></p><p>Today (${SUMMARY_TIMEZONE}): <strong>${today}</strong></p><p>TARGET_GROUP_NAME: <strong>"${TARGET_GROUP_NAME}"</strong></p><p>Total chats: ${chats.length} | Groups: ${groups.length}</p><hr><h3>All Groups (${groups.length}):</h3>${groups.map(g => { const matches = normalize(g.name).includes(normalize(TARGET_GROUP_NAME)); return `<div style="padding:8px;border-bottom:1px solid #333;background:${matches ? '#1a3a1a' : 'transparent'}">${matches ? '✅ MATCH' : '❌'} <strong>"${g.name}"</strong><span style="color:#aaa;font-size:12px"> — ${g.participants?.length || '?'} participants</span></div>`; }).join('')}<br><a href="/" style="color:#25D366">← Back</a></body></html>`);
  } catch (err) {
    res.send(`<pre style="color:red">${err.message}\n${err.stack}</pre>`);
  }
});

app.get('/eventlog', (req, res) => {
  res.send(`<html><body style="${monoStyle}"><h2>📜 Event Log (last 200 events)</h2><div style="font-size:12px;line-height:1.8">${eventLog.map(e => `<div style="border-bottom:1px solid #222">${e}</div>`).join('')}</div><br><a href="/" style="color:#25D366">← Back</a></body></html>`);
});

app.listen(PORT, () => log('🌐', `Web server on port ${PORT}`));

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    protocolTimeout: 120000
  },
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
  }
});

client.on('qr', qr => { lastQR = qr; connectionStatus = 'QR ready — open this URL to scan'; log('📱', 'QR code generated'); });
client.on('authenticated', () => { connectionStatus = 'authenticated'; log('🔐', 'Authenticated'); });
client.on('auth_failure', msg => { connectionStatus = 'auth failed'; log('❌', `Auth failure: ${msg}`); });

client.on('change_state', state => {
  log('📱', `WhatsApp state changed: ${state}`);
});

client.on('loading_screen', (percent, message) => {
  log('⏳', `WhatsApp loading: ${percent}% ${message}`);
});

client.on('ready', async () => {
  isReady = true;
  lastQR = null;
  connectionStatus = 'connected';

  log('✅', 'Client ready');
  log('📡', `Monitoring: "${TARGET_GROUP_NAME}"`);

  setTimeout(() => {
    syncTodayMessagesFromWhatsApp();
  }, 15000);
});
client.on('disconnected', reason => { cachedTargetChat = null;
  isReady = false;
  connectionStatus = 'disconnected';
  log('🔌', `Disconnected: ${reason}`);
  process.exit(1);
});

client.on('message', async msg => {
  try {
    if (!msg.from.endsWith('@g.us')) return;
    const chat = await msg.getChat();
    if (!normalize(chat.name).includes(normalize(TARGET_GROUP_NAME))) return;
    const contact = await msg.getContact();
    const sender = contact.pushname || contact.name || contact.number;
    const ts = Math.floor(Number(msg.timestamp || 0));
    if (!msg.body || msg.body.trim().length === 0) return;
    const msgId = (msg.id && (msg.id._serialized || msg.id.id)) || `${ts}-${sender || "unknown"}`;
    saveMessage(msgId, sender, msg.body.trim(), ts);
  } catch (err) { log('❌', `message event error: ${err.message}`); }
});



setInterval(async () => {
  if (!isReady) return;

  try {
    await withTimeout(client.getState(), 10000, "health check");
  } catch (e) {
    log("💀", "WhatsApp unhealthy: " + e.message);
    process.exit(1);
  }
}, 5 * 60 * 1000);

cron.schedule('0 * * * *', () => {
  if (!isReady) {
    log('⏸️', 'Skipping sync: WhatsApp not ready');
    return;
  }
  log('⏰', 'Hourly sync');
  syncTodayMessagesFromWhatsApp();
}, { timezone: SUMMARY_TIMEZONE });
cron.schedule(`${SUMMARY_MINUTE} ${SUMMARY_HOUR} * * *`, () => {
  dailySummaryJob().catch(err => log('❌', `Scheduled summary error: ${err.message}`));
}, { timezone: SUMMARY_TIMEZONE });

log('🚀', 'Initializing WhatsApp client...');
try { const lockPath = path.join(AUTH_DIR, "session", "SingletonLock"); if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch (e) {}
client.initialize();
