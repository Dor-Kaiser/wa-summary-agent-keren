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
const WORKER_API_TOKEN  = process.env.WORKER_API_TOKEN || '';
const REQUIRED_ENV      = ['GEMINI_API_KEY', 'TARGET_GROUP_NAME', 'MY_NUMBER', 'WORKER_API_TOKEN'];

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
        const jid = serializedId(numberId);
        if (!jid) { log('⚠️', `Could not resolve WhatsApp id for: ${num}`); continue; }
        await withTimeout(client.sendMessage(jid, text), 30000, "sendMessage");
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

function serializedId(id) {
  if (!id) return '';
  if (typeof id === 'string') return id;
  return id._serialized || id.$1 || id.id || '';
}

function isEvaluateStoreError(err) {
  const msg = String((err && err.message) || err || '');
  return /(^|\b)r(: r)?\b/i.test(msg) || /Evaluation failed/i.test(msg);
}

async function evaluateOnPage(fn, ...args) {
  if (!client.pupPage) throw new Error('WhatsApp page is not ready');
  return client.pupPage.evaluate(fn, ...args);
}

async function listChatsViaPage() {
  return evaluateOnPage(() => {
    const sid = (id) => (id && (id._serialized || id.$1)) || '';
    let Chat = null;
    try {
      Chat = window.Store && window.Store.Chat;
    } catch (e) {}
    
    if (!Chat && typeof window.require !== 'undefined') {
      try {
        Chat = window.require('WAWebCollections').Chat;
      } catch (e) {}
    }
    
    if (!Chat && window.webpackChunkwhatsapp_web_client) {
      window.webpackChunkwhatsapp_web_client.push([
        ["hack_chats_sync"],
        {},
        (e) => {
          for (let m in e.m) {
            try {
              let mod = e(m);
              if (mod && mod.Chat && mod.Chat.getModelsArray) {
                Chat = mod.Chat;
                break;
              }
            } catch (err) {}
          }
        }
      ]);
    }
    
    if (!Chat) {
      return [];
    }

    const models = Chat.getModelsArray ? Chat.getModelsArray() : (Chat.models || []);
    return models.map((c) => {
      const id = sid(c.id);
      return {
        id,
        name: c.name || c.formattedTitle || (c.contact && (c.contact.name || c.contact.pushname)) || '',
        isGroup: !!(c.isGroup || (c.id && c.id.server === 'g.us') || String(id).endsWith('@g.us'))
      };
    }).filter((c) => c.id);
  });
}

async function getChatsSafe() {
  try {
    const chats = await withTimeout(listChatsViaPage(), 30000, 'getChatsFallback');
    if (chats && chats.length > 0) {
      return chats;
    }
    log('WARN', 'listChatsViaPage returned empty, trying client.getChats()');
  } catch (e) {
    log('WARN', `listChatsViaPage failed (${e.message || e}), trying client.getChats()`);
  }
  
  try {
    return await withTimeout(client.getChats(), 30000, 'getChats');
  } catch (e) {
    log('ERR', `Both getChats methods failed: ${e.message || e}`);
    return [];
  }
}

async function fetchChatMessagesViaPage(chatId, limit) {
  return evaluateOnPage(async (chatId, limit) => {
    const sid = (id) => (id && (id._serialized || id.$1)) || '';
    
    let Chat = null;
    try { Chat = window.Store && window.Store.Chat; } catch (e) {}
    if (!Chat && typeof window.require !== 'undefined') {
      try { Chat = window.require('WAWebCollections').Chat; } catch (e) {}
    }
    if (!Chat && window.webpackChunkwhatsapp_web_client) {
      window.webpackChunkwhatsapp_web_client.push([
        ["hack_chat_msgs"], {}, (e) => {
          for (let m in e.m) {
            try {
              let mod = e(m);
              if (mod && mod.Chat && mod.Chat.getModelsArray) {
                Chat = mod.Chat;
                break;
              }
            } catch (err) {}
          }
        }
      ]);
    }

    if (!Chat) throw new Error('Chat collection unavailable');

    let chat = Chat.get ? Chat.get(chatId) : null;
    if (!chat) {
      try {
        const WidFactory = window.require('WAWebWidFactory');
        chat = Chat.get(WidFactory.createWid(chatId));
      } catch (e) {}
    }
    if (!chat) {
      const models = Chat.getModelsArray ? Chat.getModelsArray() : (Chat.models || []);
      chat = models.find((c) => sid(c.id) === chatId);
    }
    if (!chat) throw new Error('Chat not found: ' + chatId);

    const msgFilter = (m) => m && !m.isNotification;
    const getMsgs = () => {
      const col = chat.msgs;
      if (!col) return [];
      const arr = col.getModelsArray ? col.getModelsArray() : (col.models || []);
      return arr.filter(msgFilter);
    };

    let loadEarlier = null;
    try { loadEarlier = window.Store && window.Store.ConversationMsgs && window.Store.ConversationMsgs.loadEarlierMsgs; } catch (e) {}
    if (!loadEarlier && typeof window.require !== 'undefined') {
      try { loadEarlier = window.require('WAWebChatLoadMessages').loadEarlierMsgs; } catch (e) {}
    }
    if (!loadEarlier && window.webpackChunkwhatsapp_web_client) {
      window.webpackChunkwhatsapp_web_client.push([
        ["hack_load_msgs"], {}, (e) => {
          for (let m in e.m) {
            try {
              let mod = e(m);
              if (mod && mod.loadEarlierMsgs) {
                loadEarlier = mod.loadEarlierMsgs;
                break;
              }
            } catch (err) {}
          }
        }
      ]);
    }

    let msgs = getMsgs();
    let guard = 0;
    while (msgs.length < limit && loadEarlier && guard < 30) {
      guard += 1;
      const loaded = await loadEarlier(chat);
      if (!loaded || !loaded.length) break;
      msgs = getMsgs();
    }
    if (msgs.length > limit) msgs = msgs.slice(-limit);

    return msgs.map((m) => ({
      id: { _serialized: sid(m.id), id: m.id && m.id.id },
      timestamp: m.t || m.timestamp || 0,
      body: m.body || '',
      author: sid(m.author) || sid(m.from) || '',
      from: sid(m.from) || '',
      _data: { notifyName: m.notifyName || (m.senderObj && (m.senderObj.pushname || m.senderObj.name)) || '' }
    }));
  }, chatId, limit);
}

async function fetchTargetMessages(target, limit) {
  const chatId = serializedId(target.id) || target.id;
  if (typeof target.fetchMessages === 'function') {
    try {
      return await withTimeout(target.fetchMessages({ limit }), 45000, 'fetchMessages');
    } catch (e) {
      log('WARN', `fetchMessages failed (${e.message || e}), using page.evaluate fallback`);
    }
  }
  return withTimeout(fetchChatMessagesViaPage(chatId, limit), 45000, 'fetchMessagesFallback');
}

async function resolveTargetGroup() {
  if (cachedTargetChat) return cachedTargetChat;

  let chats;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      chats = await getChatsSafe();
      break;
    } catch (e) {
      log('WARN', `getChats attempt ${attempt}/5 failed: ${e.message || e}`);
      if (attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  const groups = (chats || []).filter((c) => c.isGroup);
  const target = groups.find((g) => normalize(g.name).includes(normalize(TARGET_GROUP_NAME)));
  if (!target) {
    log('WARN', 'Target group not found: ' + TARGET_GROUP_NAME);
    return null;
  }

  cachedTargetChat = target;
  log('SYNC', 'Cached target group: ' + target.name);
  return target;
}

async function syncTodayMessagesFromWhatsApp() {
  if (isSyncRunning) {
    log('SYNC', 'Skip: already running');
    return false;
  }

  isSyncRunning = true;
  log('SYNC', 'Start');

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceSec = nowSec - 172800;

    const target = await resolveTargetGroup();
    if (!target) return false;

    try {
      await fetchTargetMessages(target, 1);
    } catch (e) {
      log('WARN', 'warmup fetch failed: ' + (e.message || e));
    }

    const messages = await fetchTargetMessages(target, 2000);
    if (messages.length) {
      const toSec = (v) => {
        const n = Number(v || 0);
        return n > 1000000000000 ? Math.floor(n / 1000) : Math.floor(n);
      };
      const secs = messages.map((m) => toSec(m.timestamp)).filter(Boolean);
      const minTs = Math.min(...secs);
      const maxTs = Math.max(...secs);
      log('SYNC', 'Fetched ts range min=' + minTs + ' max=' + maxTs + ' count=' + secs.length);
      log('SYNC', 'Fetched ts ISO min=' + new Date(minTs * 1000).toISOString() + ' max=' + new Date(maxTs * 1000).toISOString());
    }

    let saved = 0, old = 0, dup = 0;

    for (const msg of messages) {
      const rawTs = Number(msg.timestamp || 0);
      const ts = rawTs > 1000000000000 ? Math.floor(rawTs / 1000) : Math.floor(rawTs);
      if (!ts || ts < sinceSec || ts > nowSec) { old++; continue; }

      const msgId = serializedId(msg.id) || (String(ts) + '-' + (msg.author || msg.from || 'unknown'));
      const exists = db.prepare('SELECT id FROM messages WHERE msg_id = ?').get(msgId);
      if (exists) { dup++; continue; }

      const sender = (msg._data && msg._data.notifyName) || msg.author || msg.from || 'Unknown';
      if (!msg.body || msg.body.trim().length === 0) { old++; continue; }
      const body = msg.body.trim();

      saveMessage(msgId, sender, body, ts);
      saved++;
    }

    log('SYNC', 'Done: fetched=' + messages.length + ' saved=' + saved + ' old=' + old + ' dup=' + dup);
    return true;
  } catch (e) {
    log('ERR', 'SYNC failed: ' + (e?.message || String(e)));
    log('ERR', e?.stack || 'no stack');
    cachedTargetChat = null;
    return false;
  } finally {
    isSyncRunning = false;
  }
}

// The worker API is called only by the Vercel server-side proxy. Keep its
// liveness endpoint deliberately minimal; every endpoint with WhatsApp or
// message data requires the shared worker token.
function requireWorkerToken(req, res, next) {
  const provided = req.get('authorization') || '';
  const expected = `Bearer ${WORKER_API_TOKEN}`;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (!WORKER_API_TOKEN || providedBuffer.length !== expectedBuffer.length ||
      !require('crypto').timingSafeEqual(providedBuffer, expectedBuffer)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api', requireWorkerToken);

app.get('/api/status', async (_req, res) => {
  let qrDataUrl = null;
  if (!isReady && lastQR) qrDataUrl = await QRCode.toDataURL(lastQR);
  res.json({
    status: missingEnv().length ? 'missing_config' : (isReady ? 'ok' : 'connecting'),
    ready: isReady,
    connectionStatus,
    qrDataUrl,
    targetGroupName: TARGET_GROUP_NAME,
    summaryHour: SUMMARY_HOUR,
    summaryMinute: String(SUMMARY_MINUTE).padStart(2, '0'),
    timezone: SUMMARY_TIMEZONE,
    todayInTZ: todayInTZ(),
    missing: missingEnv()
  });
});

app.post('/api/sync', async (_req, res) => {
  if (!isReady) return res.status(409).json({ error: 'WhatsApp is not connected yet' });
  const ok = await syncTodayMessagesFromWhatsApp();
  res.status(ok ? 200 : 502).json({ ok, messageCount: fetchLast24HoursMessages().length });
});

app.post('/api/summary', async (_req, res) => {
  if (!isReady) return res.status(409).json({ error: 'WhatsApp is not connected yet' });
  try {
    await dailySummaryJob();
    res.json({ ok: true });
  } catch (err) {
    log('❌', `Summary error: ${err.message}`);
    res.status(500).json({ error: 'Summary failed. Check worker logs.' });
  }
});

app.get('/api/messages', (_req, res) => {
  const messages = db.prepare('SELECT sender, body, timestamp, day FROM messages ORDER BY timestamp DESC LIMIT 100').all();
  const total = db.prepare('SELECT COUNT(*) as n FROM messages').get().n;
  res.json({ total, messages });
});

app.get('/api/diagnostics', async (_req, res) => {
  if (!isReady) return res.status(409).json({ error: 'WhatsApp is not connected yet' });
  try {
    const chats = await getChatsSafe();
    const groups = chats.filter(c => c.isGroup).map(g => ({
      name: g.name,
      participants: g.participants?.length ?? null,
      matches: normalize(g.name).includes(normalize(TARGET_GROUP_NAME))
    }));
    res.json({ serverTime: new Date().toISOString(), timezone: SUMMARY_TIMEZONE, today: todayInTZ(), targetGroupName: TARGET_GROUP_NAME, totalChats: chats.length, groups });
  } catch (err) {
    log('❌', `Diagnostics error: ${err.message}`);
    res.status(500).json({ error: 'Diagnostics failed. Check worker logs.' });
  }
});

app.get('/api/events', (_req, res) => res.json({ events: eventLog }));

app.listen(PORT, () => log('🌐', `Web server on port ${PORT}`));

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    protocolTimeout: 120000
  }
});

const pagesWithDiagnostics = new WeakSet();
function attachBrowserDiagnostics() {
  const page = client.pupPage;
  if (!page || pagesWithDiagnostics.has(page)) return;
  pagesWithDiagnostics.add(page);
  page.on('console', message => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    log('🧭', `WhatsApp Web console ${message.type()}: ${message.text().slice(0, 500)}`);
  });
  page.on('pageerror', error => {
    log('🧭', `WhatsApp Web page error: ${String(error.stack || error.message || error).slice(0, 1000)}`);
  });
  page.on('requestfailed', request => {
    const failure = request.failure();
    const safeUrl = request.url().split(/[?#]/, 1)[0];
    log('🧭', `WhatsApp Web request failed: ${request.method()} ${safeUrl} ${failure?.errorText || ''}`.slice(0, 1000));
  });
}

client.on('qr', qr => {
  lastQR = qr;
  connectionStatus = 'QR ready — open this URL to scan';
  attachBrowserDiagnostics();
  log('📱', 'QR code generated');
});
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
  try {
    log('🌐', `WhatsApp Web version: ${await client.getWWebVersion()}`);
  } catch (e) {
    log('WARN', `Could not read WhatsApp Web version: ${e.message || e}`);
  }

  setTimeout(() => {
    syncTodayMessagesFromWhatsApp().catch((e) => {
      log('ERR', 'startup sync: ' + (e.message || e));
    });
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
    let chatName = '';
    try {
      const chat = await msg.getChat();
      chatName = chat.name;
    } catch (e) {
      if (cachedTargetChat && serializedId(cachedTargetChat.id) === msg.from) {
        chatName = cachedTargetChat.name || TARGET_GROUP_NAME;
      } else {
        log('WARN', `msg.getChat failed (${e.message || e}); skipping until group cache is ready`);
        return;
      }
    }
    if (!normalize(chatName).includes(normalize(TARGET_GROUP_NAME))) return;
    let sender = 'Unknown';
    try {
      const contact = await msg.getContact();
      sender = contact.pushname || contact.name || contact.number || sender;
    } catch (e) {
      sender = msg.author || msg.from || sender;
    }
    const ts = Math.floor(Number(msg.timestamp || 0));
    if (!msg.body || msg.body.trim().length === 0) return;
    const msgId = serializedId(msg.id) || `${ts}-${sender || "unknown"}`;
    saveMessage(msgId, sender, msg.body.trim(), ts);
  } catch (err) { log('❌', `message event error: ${err.message}`); }
});



setInterval(async () => {
  if (!isReady) return;

  try {
    await withTimeout(client.getState(), 10000, "health check");
  } catch (e) {
    if (isEvaluateStoreError(e)) {
      log('WARN', 'Health check hit WhatsApp Web evaluate error (non-fatal): ' + e.message);
      return;
    }
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
