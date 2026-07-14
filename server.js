const http = require("http");
const fs = require("fs");
const path = require("path");
const tls = require("tls");
const crypto = require("crypto");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const LEGACY_DATA_FILE = path.join(DATA_DIR, "receipts.json");
const DATA_FILE = process.env.DATABASE_FILE || path.join(DATA_DIR, "database.json");
const PORT = Number(process.env.PORT || 10000);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const PANEL_USERNAME = process.env.PANEL_USERNAME || "limonadmin";
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "admin123";
const PANEL_NAME = process.env.PANEL_NAME || "Limon Admin";
const MAIL_ADDRESS = process.env.DEKONT_MAIL || process.env.LIMON_MAIL || "";
const MAIL_PASSWORD = normalizeSecret(process.env.DEKONT_APP_PASSWORD || process.env.LIMON_APP_PASSWORD || "");
const SCAN_INTERVAL_MS = clamp(process.env.SCAN_INTERVAL_MS, 1000, 1000, 10000);
const SCAN_LOOKBACK_DAYS = clamp(process.env.SCAN_LOOKBACK_DAYS, 10, 1, 90);
const MANUAL_SCAN_LOOKBACK_DAYS = clamp(process.env.MANUAL_SCAN_LOOKBACK_DAYS, 45, 1, 365);
const MAX_STORED_RECEIPTS = clamp(process.env.MAX_STORED_RECEIPTS, 3000, 100, 25000);
const MAX_FETCH_PER_SCAN = clamp(process.env.MAX_FETCH_PER_SCAN, 120, 20, 1000);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RECEIPT_MAILBOXES = unique((process.env.RECEIPT_MAILBOXES || "[Gmail]/All Mail,[Gmail]/Tüm Postalar,[Google Mail]/All Mail,[Gmail]/Updates,[Gmail]/Guncellemeler,[Gmail]/Categories/Promotions,[Gmail]/Categories/Social,[Gmail]/Kategoriler/Tanıtımlar,[Gmail]/Kategoriler/Sosyal,[Gmail]/Promotions,[Gmail]/Social,[Gmail]/Spam,[Gmail]/Gereksiz,[Gmail]/Junk,INBOX").split(",").map((x) => x.trim()).filter(Boolean));
const SEARCH_TERMS = ["Kuveyt", "Kuveyt Türk", "Kuveyt Turk", "Hesabınıza", "Hesabiniza", "FAST ile para geldi", "EFT ile para geldi", "Havale ile para geldi", "Para Geldi", "Para Girişi", "Para Girisi", "Bilgilendirme"];
const RECEIPT_FIELD_LABELS = [
  "Gonderen Adi Soyadi",
  "Gönderen Adı Soyadı",
  "Gonderen Ad Soyad",
  "Gönderen Ad Soyad",
  "Gonderen",
  "Gönderen",
  "Gonderen Bankasi",
  "Gönderen Bankası",
  "Banka",
  "Tutar",
  "Gelen Tutar",
  "Para Girisi",
  "Para Girişi",
  "Aciklama",
  "Açıklama",
  "Islem Aciklamasi",
  "İşlem Açıklaması",
  "Islem Zamani",
  "İşlem Zamanı",
  "Tarih",
  "Saat"
];

fs.mkdirSync(DATA_DIR, { recursive: true });
const sessions = new Map();
const clients = new Set();
let scanBusy = false;
let scanTimer = null;
let saveTimer = null;
let state = loadState();

function clamp(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function unique(list) {
  return [...new Set(list)];
}

function normalizeSecret(value) {
  return String(value || "").replace(/\s+/g, "");
}

function loadState() {
  try {
    const sourceFile = fs.existsSync(DATA_FILE) ? DATA_FILE : LEGACY_DATA_FILE;
    const raw = fs.readFileSync(sourceFile, "utf8");
    const parsed = JSON.parse(raw);
    return {
      receipts: Array.isArray(parsed.receipts) ? sanitizeReceipts(parsed.receipts).slice(0, MAX_STORED_RECEIPTS) : [],
      seen: Array.isArray(parsed.seen) ? parsed.seen : [],
      health: parsed.health && typeof parsed.health === "object" ? parsed.health : {}
    };
  } catch (error) {
    return { receipts: [], seen: [], health: {} };
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveStateNow();
  }, 250);
}

function saveStateNow() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  state.receipts = sanitizeReceipts(state.receipts).slice(0, MAX_STORED_RECEIPTS);
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    receipts: state.receipts,
    seen: unique(state.seen).slice(-MAX_STORED_RECEIPTS * 2),
    health: state.health || {}
  }, null, 2), "utf8");
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error("Istek cok buyuk"));
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function parseCookies(header) {
  return Object.fromEntries(String(header || "").split(";").map((part) => {
    const index = part.indexOf("=");
    return index === -1 ? null : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(Boolean));
}

function authUser(req) {
  const token = parseCookies(req.headers.cookie).dk_session || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function requireAuth(req, res) {
  const user = authUser(req);
  if (!user) sendJson(res, 401, { error: "Oturum gerekli" });
  return user;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readJson(req);
      const enteredUsername = normalizeLoginName(body.username);
      const expectedUsername = normalizeLoginName(PANEL_USERNAME);
      if (enteredUsername !== expectedUsername || String(body.password || "") !== PANEL_PASSWORD) {
        return sendJson(res, 401, { error: "Kullanici adi veya sifre hatali" });
      }
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { token, name: PANEL_NAME, username: PANEL_USERNAME, expiresAt: Date.now() + SESSION_TTL_MS });
      res.setHeader("Set-Cookie", `dk_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
      return sendJson(res, 200, { token, user: { name: PANEL_NAME, username: PANEL_USERNAME } });
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const token = parseCookies(req.headers.cookie).dk_session;
      if (token) sessions.delete(token);
      res.setHeader("Set-Cookie", "dk_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/me") {
      const user = authUser(req);
      return sendJson(res, 200, { authenticated: Boolean(user), user: user ? { name: user.name, username: user.username } : null });
    }

    if (url.pathname === "/api/events") {
      const user = requireAuth(req, res);
      if (!user) return;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive"
      });
      res.write(`event: ready\ndata: ${JSON.stringify(buildPayload())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (url.pathname === "/api/receipts") {
      const user = requireAuth(req, res);
      if (!user) return;
      return sendJson(res, 200, buildPayload());
    }

    if (req.method === "POST" && url.pathname === "/api/refresh") {
      const user = requireAuth(req, res);
      if (!user) return;
      triggerScan("manual", MANUAL_SCAN_LOOKBACK_DAYS);
      return sendJson(res, 202, { ok: true, message: "Detayli tarama baslatildi" });
    }

    serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { error: sanitizeError(error) });
  }
});

function normalizeLoginName(value) {
  return String(value || "").trim().toLocaleLowerCase("tr-TR");
}

function serveStatic(req, res, url) {
  const fileMap = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/styles.css": "styles.css",
    "/logo.svg": "logo.svg",
    "/og-card.svg": "og-card.svg"
  };
  const file = fileMap[url.pathname];
  if (!file) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const full = path.join(ROOT, file);
  const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
  let body = fs.readFileSync(full);
  if (file === "index.html" && PUBLIC_BASE_URL) {
    body = Buffer.from(String(body).replace(/content="\/og-card\.svg"/g, `content="${PUBLIC_BASE_URL}/og-card.svg"`), "utf8");
  }
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
  res.end(body);
}

function buildPayload() {
  const receipts = sanitizeReceipts(state.receipts);
  const today = new Date().toLocaleDateString("tr-TR", { timeZone: "Europe/Istanbul" });
  const todayReceipts = receipts.filter((r) => new Date(r.receivedAt || r.transactionTime || 0).toLocaleDateString("tr-TR", { timeZone: "Europe/Istanbul" }) === today);
  return {
    receipts,
    stats: {
      todayTotal: todayReceipts.reduce((sum, r) => sum + Number(r.amount || 0), 0),
      totalCount: receipts.length,
      lastScanAt: state.health.lastScanAt || ""
    },
    health: state.health
  };
}

function broadcast(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of [...clients]) {
    try { client.write(data); } catch (error) { clients.delete(client); }
  }
}

function startScanLoop() {
  const run = async () => {
    await triggerScan("interval", SCAN_LOOKBACK_DAYS);
    scanTimer = setTimeout(run, SCAN_INTERVAL_MS);
  };
  scanTimer = setTimeout(run, 300);
}

async function triggerScan(mode = "interval", lookbackDays = SCAN_LOOKBACK_DAYS) {
  if (scanBusy) return;
  scanBusy = true;
  state.health = { ...state.health, status: "scanning", message: "Son dekontlar okunuyor", startedAt: new Date().toISOString() };
  broadcast("status", buildPayload());
  try {
    const result = await scanMail({ mode, lookbackDays });
    state.health = {
      status: "ok",
      message: result.newReceipts.length ? `${result.newReceipts.length} yeni dekont eklendi` : "Dekont okuma tamamlandi",
      lastScanAt: new Date().toISOString(),
      scannedCandidates: result.candidates,
      processedCandidates: result.processed,
      skippedCandidates: result.skipped,
      mailAddress: maskEmail(MAIL_ADDRESS),
      mailConfigured: Boolean(MAIL_ADDRESS && MAIL_PASSWORD),
      newCount: result.newReceipts.length
    };
    scheduleSave();
    broadcast("receipts", { ...buildPayload(), newReceipts: result.newReceipts });
  } catch (error) {
    state.health = { status: "error", message: sanitizeError(error), lastScanAt: new Date().toISOString() };
    broadcast("status", buildPayload());
    scheduleSave();
  } finally {
    scanBusy = false;
  }
}

async function scanMail({ mode = "interval", lookbackDays }) {
  if (!MAIL_ADDRESS || !MAIL_PASSWORD) {
    throw new Error("Mail bilgileri eksik. DEKONT_MAIL ve DEKONT_APP_PASSWORD gerekli.");
  }
  const imap = new ImapClient(MAIL_ADDRESS, MAIL_PASSWORD);
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  await imap.connect();
  try {
    await imap.login();
    const targets = await imap.searchReceiptCandidatesSince(since);
    const known = new Set(state.seen);
    const receiptKnown = new Set(state.receipts.map((r) => r.identityKey || r.id));
    const shouldRecheckRecent = mode === "manual";
    const freshTargets = (shouldRecheckRecent ? targets : targets.filter((t) => !known.has(`${t.mailbox}:${t.uid}`))).slice(-MAX_FETCH_PER_SCAN);
    const messages = await imap.fetchMessages(freshTargets);
    const newReceipts = [];
    let processed = 0;
    let skipped = 0;
    for (const message of messages) {
      processed += 1;
      const key = `${message.mailbox}:${message.uid}`;
      const parsed = parseReceipt(message.uid, message.raw, message.mailbox);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      state.seen.push(key);
      if (receiptKnown.has(parsed.identityKey) || receiptKnown.has(parsed.id)) continue;
      receiptKnown.add(parsed.identityKey);
      receiptKnown.add(parsed.id);
      state.receipts.unshift(parsed);
      newReceipts.push(parsed);
    }
    state.seen = unique(state.seen).slice(-MAX_STORED_RECEIPTS * 2);
    state.receipts = sortReceipts(dedupeReceipts(state.receipts)).slice(0, MAX_STORED_RECEIPTS);
    if (newReceipts.length) {
      saveStateNow();
    }
    return { candidates: targets.length, processed, skipped, newReceipts };
  } finally {
    imap.close();
  }
}

class ImapClient {
  constructor(email, password) {
    this.email = email;
    this.password = password;
    this.host = "imap.gmail.com";
    this.port = 993;
    this.seq = 1;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.socket = null;
    this.selectedMailbox = "";
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect({ host: this.host, port: this.port, servername: this.host, rejectUnauthorized: true }, () => {
        this.readUntil((text) => /^\* OK/im.test(text), 15000).then(resolve).catch(reject);
      });
      this.socket.on("data", (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.flushWaiter(); });
      this.socket.on("error", reject);
      this.socket.setTimeout(45000, () => { reject(new Error("IMAP zaman asimi")); this.close(); });
    });
  }
  async login() { await this.command(`LOGIN ${quoteImap(this.email)} ${quoteImap(this.password)}`, 20000); }
  async selectMailbox(mailbox) { await this.command(`SELECT ${quoteImap(mailbox)}`, 20000); this.selectedMailbox = mailbox; }
  async searchSince(date) { return extractSearchUids(await this.command(`UID SEARCH SINCE ${formatImapDate(date)} SUBJECT "Kuveyt"`, 25000)); }
  async searchTextSince(date, phrase) { return extractSearchUids(await this.command(`UID SEARCH SINCE ${formatImapDate(date)} TEXT ${quoteImap(phrase)}`, 25000)); }
  async searchReceiptCandidatesSince(date) {
    const available = [];
    for (const mailbox of RECEIPT_MAILBOXES) {
      try { await this.selectMailbox(mailbox); available.push(mailbox); } catch (_) {}
    }
    if (!available.length) throw new Error("Mail kutusu secilemedi");
    const targets = new Map();
    for (const mailbox of available) {
      await this.selectMailbox(mailbox);
      const runners = [() => this.searchSince(date), ...SEARCH_TERMS.map((term) => () => this.searchTextSince(date, term))];
      for (const runner of runners) {
        try {
          const uids = await runner();
          for (const uid of uids) targets.set(`${mailbox}:${uid}`, { uid: Number(uid), mailbox });
        } catch (_) {}
      }
    }
    return [...targets.values()].sort((a, b) => a.uid - b.uid);
  }
  async fetchMessages(targets) {
    if (!targets.length) return [];
    const grouped = new Map();
    for (const target of targets) {
      if (!grouped.has(target.mailbox)) grouped.set(target.mailbox, []);
      grouped.get(target.mailbox).push(Number(target.uid));
    }
    const out = [];
    for (const [mailbox, uids] of grouped.entries()) {
      await this.selectMailbox(mailbox);
      const response = await this.command(`UID FETCH ${uids.join(",")} (BODY.PEEK[])`, 60000);
      const messages = extractEmailsFromFetch(response);
      if (messages.length) out.push(...messages.map((m) => ({ ...m, mailbox })));
      else {
        for (const uid of uids) out.push({ uid, mailbox, raw: extractEmailFromFetch(await this.command(`UID FETCH ${uid} (BODY.PEEK[])`, 45000)) });
      }
    }
    return out;
  }
  command(text, timeoutMs) {
    const tag = `A${String(this.seq++).padStart(4, "0")}`;
    const done = new RegExp(`(?:^|\\r?\\n)${tag} (OK|NO|BAD)`, "i");
    this.socket.write(`${tag} ${text}\r\n`);
    return this.readUntil((bufferText) => done.test(bufferText), timeoutMs).then((buffer) => {
      const response = buffer.toString("utf8");
      const status = response.match(done);
      if (status && status[1].toUpperCase() !== "OK") throw new Error(`IMAP komutu basarisiz: ${status[1].toUpperCase()}`);
      return buffer;
    });
  }
  readUntil(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new Error("IMAP yaniti zaman asimi")); }, timeoutMs);
      this.waiter = { predicate, resolve: (b) => { clearTimeout(timer); resolve(b); }, reject };
      this.flushWaiter();
    });
  }
  flushWaiter() {
    if (!this.waiter || !this.buffer.length) return;
    const text = this.buffer.toString("utf8");
    if (this.waiter.predicate(text, this.buffer)) {
      const buffer = this.buffer;
      this.buffer = Buffer.alloc(0);
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve(buffer);
    }
  }
  close() { try { if (this.socket) this.socket.destroy(); } catch (_) {} }
}

function parseReceipt(uid, raw, mailbox) {
  const headers = parseHeaders(raw);
  const subject = decodeMimeWords(headers.subject || "");
  const from = decodeMimeWords(headers.from || "");
  const messageId = normalizeMessageId(headers["message-id"] || "");
  const body = cleanText(extractText(raw));
  const searchable = normalizeSearch(`${subject}\n${from}\n${body}`);
  if (!isKuveytReceipt(searchable)) return null;
  const amount = findAmount(body);
  if (!amount) return null;
  const sender = findField(body, [/g[oö]nderen(?:\s+ad[ıi]\s+soyad[ıi])?/i, /g[oö]nderen\s+ad\s+soyad/i, /ad[ıi]\s+soyad[ıi]/i, /g[oö]nderen/i]) || inferSender(body);
  if (!isValidSender(sender)) return null;
  const senderBank = findField(body, [/g[oö]nderen\s+banka(?:s[ıi])?/i, /banka(?:s[ıi])?/i]) || "Banka bilgisi yok";
  const desc = findField(body, [/a[çc][ıi]klama(?:s[ıi])?/i, /i[şs]lem\s+a[çc][ıi]klama(?:s[ıi])?/i]) || inferDescription(body) || "Aciklama yok";
  const transactionTime = findField(body, [/i[şs]lem\s+zaman[ıi]/i, /tarih/i, /saat/i]) || inferDate(body) || parseDate(headers.date) || "";
  const receivedAt = parseDate(headers.date) || new Date().toISOString();
  const identityKey = messageId || `${normalizeSearch(sender)}:${amount.toFixed(2)}:${normalizeSearch(transactionTime || receivedAt)}`;
  const id = crypto.createHash("sha1").update(identityKey + ":" + uid).digest("hex").slice(0, 12).toUpperCase();
  return { id, uid: String(uid), mailbox, messageId, identityKey, sender, senderBank, amount, currency: "TRY", desc, transactionTime, receivedAt, time: shortTime(transactionTime || receivedAt), status: "Yeni geldi", subject };
}

function isKuveytReceipt(text) {
  const compact = compactSearch(text);
  return (text.includes("kuveyt") || text.includes("bilgilendirme")) && (
    text.includes("hesabiniza para geldi") ||
    text.includes("hesabiniza para") ||
    text.includes("hesabiniza fast ile para geldi") ||
    text.includes("hesabiniza eft ile para geldi") ||
    text.includes("hesabiniza havale ile para geldi") ||
    text.includes("para geldi") ||
    text.includes("para girisi") ||
    text.includes("fast ile para geldi") ||
    text.includes("eft ile para geldi") ||
    text.includes("havale ile para geldi") ||
    compact.includes("hesabinizaparageldi") ||
    compact.includes("hesabinizapara") ||
    compact.includes("hesabinizafastileparageldi") ||
    compact.includes("hesabinizaeftileparageldi") ||
    compact.includes("hesabinizahavaleileparageldi") ||
    /hesabiniza.{0,50}(fast|eft|havale)?.{0,50}para/.test(text)
  );
}

function parseHeaders(raw) {
  const head = String(raw || "").split(/\r?\n\r?\n/)[0] || "";
  const lines = head.replace(/\r?\n[\t ]+/g, " ").split(/\r?\n/);
  const headers = {};
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index > 0) headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function extractText(raw) {
  const text = String(raw || "");
  const decoded = decodeQuotedPrintable(decodeMimeWords(text));
  const parts = decoded.split(/\r?\n\r?\n/).slice(1).join("\n");
  return htmlToText(parts || decoded)
    .replace(/^Content-[^\n]+$/gim, " ")
    .replace(/^--[^\n]+$/gim, " ")
    .replace(/^[A-Za-z0-9+/=]{80,}$/gm, " ");
}

function htmlToText(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&ccedil;/gi, "ç").replace(/&Ccedil;/g, "Ç")
    .replace(/&ouml;/gi, "ö").replace(/&Ouml;/g, "Ö")
    .replace(/&uuml;/gi, "ü").replace(/&Uuml;/g, "Ü")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function decodeQuotedPrintable(value) {
  return String(value || "").replace(/=\r?\n/g, "").replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeMimeWords(value) {
  return String(value || "").replace(/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g, (_, charset, enc, data) => {
    try {
      if (enc.toLowerCase() === "b") return Buffer.from(data, "base64").toString("utf8");
      return decodeQuotedPrintable(data.replace(/_/g, " "));
    } catch (_) { return data; }
  });
}

function cleanText(value) { return String(value || "").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(); }
function normalizeSearch(value) { return String(value || "").toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i").replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ş/g, "s").replace(/ö/g, "o").replace(/ç/g, "c"); }
function normalizeMessageId(value) { return String(value || "").trim().replace(/[<>]/g, "").toLowerCase(); }

function compactSearch(value) { return normalizeSearch(value).replace(/[^a-z0-9]+/g, ""); }

function receiptLines(text) {
  let output = cleanText(text);
  for (const label of RECEIPT_FIELD_LABELS) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    output = output.replace(new RegExp(`([\\s\\-|,;]+)(${escaped})\\s*[:：]`, "gi"), "\n$2:");
  }
  return output.split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function findField(text, labels) {
  const lines = receiptLines(text);
  for (let i = 0; i < lines.length; i += 1) {
    for (const label of labels) {
      if (!label.test(lines[i])) continue;
      const after = lines[i].split(/[:：]/).slice(1).join(":").trim();
      const candidate = sanitizeValue(after || lines[i + 1] || "");
      if (isUsableFieldValue(candidate, labels)) return candidate;
    }
  }
  return "";
}

function sanitizeValue(value) { return String(value || "").replace(/^[\s:;\-|]+/, "").replace(/\s+/g, " ").trim(); }

function isUsableFieldValue(value, ownLabels = []) {
  const candidate = sanitizeValue(value);
  if (!candidate || candidate.length > 180) return false;
  if (ownLabels.some((label) => label.test(candidate))) return false;
  const normalized = normalizeSearch(candidate);
  const blocked = ["tutar", "aciklama", "islem zamani", "gonderen banka", "banka", "tarih", "saat"];
  return !blocked.some((label) => normalized === label || normalized.startsWith(`${label}:`));
}

function findAmount(text) {
  const normalized = String(text || "");
  const contextual = normalized.match(/(?:tutar|miktar|gelen tutar|para giri[şs]i|hesaba gelen)[^0-9₺]{0,50}((?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{2})?)\s*(?:TL|TRY|₺)?/i);
  const any = normalized.match(/((?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{2})?)\s*(?:TL|TRY|₺)/i);
  return parseAmount((contextual && contextual[1]) || (any && any[1]) || "");
}

function parseAmount(value) {
  let text = String(value || "").replace(/[^0-9.,]/g, "");
  if (!text) return 0;
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  const decimalIndex = Math.max(lastComma, lastDot);
  if (decimalIndex >= 0 && text.length - decimalIndex <= 3) {
    text = text.slice(0, decimalIndex).replace(/[.,]/g, "") + "." + text.slice(decimalIndex + 1);
  } else {
    text = text.replace(/[.,]/g, "");
  }
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : 0;
}

function inferSender(text) {
  const lines = receiptLines(text);
  const line = lines.find((item) => /adl[ıi]\s+ki[şs]iden|taraf[ıi]ndan|g[oö]nderen/i.test(item));
  if (!line) return "";
  const match =
    line.match(/(?:saatinde\s+)?(.{3,90}?)\s+adl[ıi]\s+ki[şs]iden/i) ||
    line.match(/(.{3,90}?)\s+taraf[ıi]ndan/i) ||
    line.match(/g[oö]nderen(?:\s+ad[ıi]\s+soyad[ıi])?\s*[:：]\s*(.{3,90})/i);
  return match ? sanitizeValue(match[1]) : "";
}

function inferDescription(text) {
  const n = normalizeSearch(text);
  if (n.includes("fast ile para geldi")) return "FAST ile para geldi";
  if (n.includes("eft ile para geldi")) return "EFT ile para geldi";
  if (n.includes("havale ile para geldi")) return "Havale ile para geldi";
  return "Para transferi";
}

function inferDate(text) {
  const match = String(text || "").match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{4}\s+\d{1,2}[:.]\d{2}(?::\d{2})?)\b/);
  return match ? match[1].replace(/\//g, ".") : "";
}

function parseDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function shortTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" }).format(date);
}

function sanitizeReceipts(receipts) {
  return sortReceipts((receipts || []).filter(isDisplayableReceipt));
}

function isDisplayableReceipt(receipt) {
  return Boolean(receipt && Number(receipt.amount || 0) > 0 && isValidSender(receipt.sender));
}

function isValidSender(sender) {
  const value = sanitizeValue(sender);
  const normalized = normalizeSearch(value);
  if (!value || value.length < 3) return false;
  if (["belirtilmedi", "bilinmiyor", "gonderen yok", "sender yok"].includes(normalized)) return false;
  return /[a-zA-ZÇĞİÖŞÜçğıöşü]/.test(value);
}

function maskEmail(value) {
  const text = String(value || "");
  const [name, domain] = text.split("@");
  if (!name || !domain) return "";
  return `${name.slice(0, 3)}***@${domain}`;
}

function sortReceipts(receipts) {
  return [...receipts].sort((a, b) => (Date.parse(b.receivedAt || b.transactionTime || "") || 0) - (Date.parse(a.receivedAt || a.transactionTime || "") || 0));
}

function dedupeReceipts(receipts) {
  const seen = new Set();
  const out = [];
  for (const receipt of sortReceipts(receipts)) {
    const key = receipt.identityKey || receipt.messageId || receipt.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(receipt);
  }
  return out;
}

function quoteImap(value) { return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }
function formatImapDate(date) { const m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return `${date.getUTCDate()}-${m[date.getUTCMonth()]}-${date.getUTCFullYear()}`; }
function extractSearchUids(response) { const text = response.toString("utf8"); const match = text.match(/\* SEARCH\s+([0-9\s]*)/i); return match && match[1].trim() ? match[1].trim().split(/\s+/).map(Number).filter(Boolean) : []; }
function extractEmailFromFetch(response) { const text = response.toString("latin1"); const m = text.match(/\{(\d+)\}\r?\n/); if (!m) return response.toString("utf8"); const size = Number(m[1]); const start = m.index + m[0].length; return response.slice(start, start + size).toString("utf8"); }
function extractEmailsFromFetch(response) { const text = response.toString("latin1"); const out = []; let cursor = 0; const p = /\* \d+ FETCH \([^\r\n{]*UID\s+(\d+)[^\r\n{]*\{(\d+)\}\r?\n/gi; while (cursor < text.length) { p.lastIndex = cursor; const m = p.exec(text); if (!m) break; const uid = Number(m[1]); const size = Number(m[2]); const start = m.index + m[0].length; const end = start + size; out.push({ uid, raw: response.slice(start, end).toString("utf8") }); cursor = end; } return out; }
function sanitizeError(error) { return String(error && error.message ? error.message : error).replace(/[a-z0-9]{16}/gi, "***").replace(/LOGIN .+/gi, "LOGIN ***"); }

server.listen(PORT, () => {
  console.log(`Dekont Kontrol hazir: http://127.0.0.1:${PORT}`);
  startScanLoop();
});
