const http = require("http");
const fs = require("fs");
const path = require("path");
const tls = require("tls");
const crypto = require("crypto");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const LEGACY_DATA_FILE = path.join(DATA_DIR, "receipts.json");
const PERSISTENT_DATA_DIR = process.env.RENDER ? "/var/data" : DATA_DIR;
const DATA_FILE = process.env.DATABASE_FILE || path.join(PERSISTENT_DATA_DIR, "database.json");
const PORT = Number(process.env.PORT || 10000);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const SCAN_INTERVAL_MS = clamp(process.env.SCAN_INTERVAL_MS, 1000, 1000, 10000);
const SCAN_LOOKBACK_DAYS = clamp(process.env.SCAN_LOOKBACK_DAYS, 30, 1, 180);
const MANUAL_SCAN_LOOKBACK_DAYS = clamp(process.env.MANUAL_SCAN_LOOKBACK_DAYS, 120, 1, 365);
const HOT_SCAN_LOOKBACK_HOURS = clamp(process.env.HOT_SCAN_LOOKBACK_HOURS, 6, 1, 24);
const LIVE_FETCH_PER_SCAN = clamp(process.env.LIVE_FETCH_PER_SCAN, 12, 4, 80);
const MAX_STORED_RECEIPTS = clamp(process.env.MAX_STORED_RECEIPTS, 3000, 100, 25000);
const MAX_FETCH_PER_SCAN = clamp(process.env.MAX_FETCH_PER_SCAN, 1000, 20, 2000);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RECEIPT_MAILBOXES = unique((process.env.RECEIPT_MAILBOXES || "[Gmail]/All Mail,[Gmail]/Tüm Postalar,[Google Mail]/All Mail,[Gmail]/Updates,[Gmail]/Guncellemeler,[Gmail]/Categories/Promotions,[Gmail]/Categories/Social,[Gmail]/Kategoriler/Tanıtımlar,[Gmail]/Kategoriler/Sosyal,[Gmail]/Promotions,[Gmail]/Social,[Gmail]/Spam,[Gmail]/Gereksiz,[Gmail]/Junk,INBOX").split(",").map((x) => x.trim()).filter(Boolean));
const LIVE_RECEIPT_MAILBOXES = unique((process.env.LIVE_RECEIPT_MAILBOXES || "INBOX,[Gmail]/Updates,[Gmail]/Guncellemeler,[Gmail]/All Mail,[Gmail]/Tüm Postalar,[Google Mail]/All Mail").split(",").map((x) => x.trim()).filter(Boolean));
const SEARCH_TERMS = ["Kuveyt", "Kuveyt Türk", "Kuveyt Turk", "Hesabınıza", "Hesabiniza", "FAST ile para geldi", "EFT ile para geldi", "Havale ile para geldi", "Para Geldi", "Para Girişi", "Para Girisi", "Bilgilendirme"];
const LIVE_SEARCH_TERMS = unique((process.env.LIVE_SEARCH_TERMS || "Kuveyt,Kuveyt Turk,Para Geldi,FAST").split(",").map((x) => x.trim()).filter(Boolean));
const MUSTI_COMPANY_SUBJECT = "VENÜS DİJİTAL REKLAM MEDYA VE DANIŞMANLIK TİCARET LİMİTED ŞİRKETİ";
const ACCOUNT_SECTIONS = {
  limon: [
    { key: "limon", label: "LİMON", slot: "1" },
    { key: "limon-toplam", label: "LİMON TOPLAM", slot: "3" }
  ],
  musti: [
    { key: "musti", label: "Musti" }
  ]
};
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
const RECEIPT_FIELD_ALIASES = {
  amount: [
    "Tutar",
    "Gelen Tutar",
    "Islem Tutari",
    "Islem Tutar",
    "Hesaba Gelen Tutar",
    "Havale Tutari",
    "EFT Tutari",
    "Transfer Tutari",
    "Odeme Tutari",
    "Para Girisi"
  ],
  sender: [
    "Gonderen",
    "Gonderen Adi",
    "Gonderen Ad Soyad",
    "Gonderen Adi Soyadi",
    "Gonderen Unvani",
    "Gonderen Kisi",
    "Gonderen Musteri",
    "Gonderen Hesap Sahibi",
    "Hesap Sahibi",
    "Islem Sahibi"
  ],
  senderBank: [
    "Gonderen Bankasi",
    "Gonderen Banka",
    "Gonderen Banka Adi",
    "Karsi Banka",
    "Gonderici Banka",
    "Gonderici Bankasi",
    "Banka Adi",
    "Banka"
  ],
  description: [
    "Aciklama",
    "Islem Aciklamasi",
    "Odeme Aciklamasi",
    "Transfer Aciklamasi",
    "EFT Aciklamasi",
    "Havale Aciklamasi",
    "Dekont Aciklamasi"
  ],
  transactionTime: [
    "Islem Zamani",
    "Islem Tarihi",
    "Islem Saati",
    "Tarih Saat",
    "Tarih",
    "Gerceklesme Zamani"
  ]
};
const RECEIPT_FIELD_LOOKUP = buildReceiptFieldLookup();
const PANEL_USERS = buildPanelUsers();
const MAIL_ACCOUNTS = buildMailAccounts();
const BLOCKED_RECEIPT_VALUE_TERMS = [
  "meydana gelebilecek",
  "hatalardan dolayi",
  "eksiklerden dolayi",
  "sorumluluk kabul",
  "bankamiz sorumluluk",
  "kuveyt turk katilim bankasi",
  "bilgilendirme mesaji",
  "bu mesaj",
  "guvenliginiz",
  "kvkk",
  "kisisel veri",
  "detayli bilgi",
  "www.",
  "http",
  "musteri iletisim",
  "444"
];

fs.mkdirSync(DATA_DIR, { recursive: true });
const sessions = new Map();
const clients = new Set();
const scanBusyAccounts = new Set();
const pendingScanRequests = new Map();
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

function buildPanelUsers() {
  const users = [
    {
      username: process.env.PANEL_USERNAME || "limonadmin",
      password: process.env.PANEL_PASSWORD || "admin123",
      name: process.env.PANEL_NAME || "Limon Admin",
      account: "limon",
      theme: "limon",
      logo: "/limon.svg",
      sourceLabel: "Veriler kalici database kaydiyla korunur."
    },
    {
      username: "musti",
      password: "mustigiriş123",
      name: "Musti Admin",
      account: "musti",
      theme: "musti",
      logo: "/musti-logo.jpeg",
      sourceLabel: "Musti paneli bagimsiz veri kaynagiyla calisir."
    }
  ];
  return users.map((user) => ({
    ...user,
    loginKey: normalizeLoginName(user.username)
  }));
}

function publicUser(user) {
  if (!user) return null;
  return {
    name: user.name,
    username: user.username,
    account: user.account || "limon",
    theme: user.theme || "limon",
    logo: user.logo || "/logo.svg",
    sourceLabel: user.sourceLabel || "Veriler kalici database kaydiyla korunur."
  };
}

function buildMailAccounts() {
  return {
    limon: {
      account: "limon",
      label: "Limon",
      routeAccounts: ["limon", "limon-toplam"],
      email: process.env.DEKONT_MAIL || process.env.LIMON_MAIL || "",
      password: normalizeSecret(process.env.DEKONT_APP_PASSWORD || process.env.LIMON_APP_PASSWORD || ""),
      searchTerms: unique([...SEARCH_TERMS, "1 numaralı", "1 numarali", "3 numaralı", "3 numarali"]),
      liveSearchTerms: unique([...LIVE_SEARCH_TERMS, "1 numaralı", "1 numarali", "3 numaralı", "3 numarali"]),
      deepLiveSearch: true
    },
    musti: {
      account: "musti",
      label: "Musti",
      email: process.env.MUSTI_DEKONT_MAIL || process.env.MUSTI_MAIL || "supermedya6@gmail.com",
      password: normalizeSecret(process.env.MUSTI_DEKONT_APP_PASSWORD || process.env.MUSTI_APP_PASSWORD || ""),
      searchTerms: unique([...SEARCH_TERMS, MUSTI_COMPANY_SUBJECT, "VENUS DIJITAL", "VENÜS DİJİTAL", "supermedya6"]),
      liveSearchTerms: unique([...LIVE_SEARCH_TERMS, ...SEARCH_TERMS, MUSTI_COMPANY_SUBJECT, "VENUS DIJITAL", "VENÜS DİJİTAL", "supermedya6"]),
      deepLiveSearch: true
    }
  };
}

function normalizeSecret(value) {
  return String(value || "").replace(/\s+/g, "");
}

function loadState() {
  try {
    const sourceFile = findReadableStateFile();
    const raw = fs.readFileSync(sourceFile, "utf8");
    const parsed = JSON.parse(raw);
    return {
      receipts: Array.isArray(parsed.receipts) ? sanitizeReceipts(parsed.receipts).slice(0, MAX_STORED_RECEIPTS) : [],
      seen: Array.isArray(parsed.seen) ? parsed.seen : [],
      health: parsed.health && typeof parsed.health === "object" ? parsed.health : {},
      accountSettings: parsed.accountSettings && typeof parsed.accountSettings === "object" ? parsed.accountSettings : {}
    };
  } catch (error) {
    return { receipts: [], seen: [], health: {}, accountSettings: {} };
  }
}

function findReadableStateFile() {
  const candidates = unique([DATA_FILE, path.join(DATA_DIR, "database.json"), LEGACY_DATA_FILE]);
  return candidates.find((file) => file && fs.existsSync(file)) || DATA_FILE;
}

function normalizeLoadedState(parsed) {
  return {
    receipts: Array.isArray(parsed && parsed.receipts) ? sanitizeReceipts(parsed.receipts).slice(0, MAX_STORED_RECEIPTS) : [],
    seen: Array.isArray(parsed && parsed.seen) ? parsed.seen : [],
    health: parsed && parsed.health && typeof parsed.health === "object" ? parsed.health : {},
    accountSettings: parsed && parsed.accountSettings && typeof parsed.accountSettings === "object" ? parsed.accountSettings : {}
  };
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
  const snapshot = buildStateSnapshot();
  fs.writeFileSync(DATA_FILE, JSON.stringify(snapshot, null, 2), "utf8");
}

function buildStateSnapshot() {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    receipts: state.receipts,
    seen: unique(state.seen).slice(-MAX_STORED_RECEIPTS * 2),
    health: state.health || {},
    accountSettings: state.accountSettings || {}
  };
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
      const panelUser = PANEL_USERS.find((user) => user.loginKey === enteredUsername);
      if (!panelUser || String(body.password || "") !== panelUser.password) {
        return sendJson(res, 401, { error: "Kullanici adi veya sifre hatali" });
      }
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { token, ...publicUser(panelUser), expiresAt: Date.now() + SESSION_TTL_MS });
      res.setHeader("Set-Cookie", `dk_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
      setImmediate(() => triggerScan(panelUser.account, "manual", MANUAL_SCAN_LOOKBACK_DAYS));
      return sendJson(res, 200, { token, user: publicUser(panelUser) });
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const token = parseCookies(req.headers.cookie).dk_session;
      if (token) sessions.delete(token);
      res.setHeader("Set-Cookie", "dk_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/me") {
      const user = authUser(req);
      if (user) setImmediate(() => triggerScan(user.account, "manual", MANUAL_SCAN_LOOKBACK_DAYS));
      return sendJson(res, 200, { authenticated: Boolean(user), user: publicUser(user) });
    }

    if (url.pathname === "/api/events") {
      const user = requireAuth(req, res);
      if (!user) return;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive"
      });
      res.write(`event: ready\ndata: ${JSON.stringify(buildPayload(user.account))}\n\n`);
      const client = { res, account: user.account };
      clients.add(client);
      req.on("close", () => clients.delete(client));
      return;
    }

    if (url.pathname === "/api/receipts") {
      const user = requireAuth(req, res);
      if (!user) return;
      return sendJson(res, 200, buildPayload(user.account));
    }

    if (req.method === "POST" && url.pathname === "/api/account-settings") {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readJson(req);
      const section = normalizeSectionKey(user.account, body.section);
      const current = getAccountSettings(user.account);
      const sectionSettings = {
        ...(current.sectionSettings || {}),
        [section]: {
          totalAdjustment: Number(body.totalAdjustment || 0),
          updatedAt: new Date().toISOString(),
          updatedBy: user.username || user.name || ""
        }
      };
      const next = {
        ...current,
        totalAdjustment: Number(sectionSettings[sectionsForAccount(user.account)[0].key]?.totalAdjustment || 0),
        updatedAt: new Date().toISOString(),
        updatedBy: user.username || user.name || "",
        sectionSettings
      };
      setAccountSettings(user.account, next);
      saveStateNow();
      broadcast("settings", buildPayload(user.account), user.account);
      return sendJson(res, 200, buildPayload(user.account));
    }

    if (req.method === "POST" && url.pathname === "/api/refresh") {
      const user = requireAuth(req, res);
      if (!user) return;
      triggerScan(user.account, "manual", MANUAL_SCAN_LOOKBACK_DAYS);
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
    "/limon.svg": "limon.svg",
    "/musti-logo.jpeg": "musti-logo.jpeg",
    "/og-card.svg": "og-card.svg"
  };
  const file = fileMap[url.pathname];
  if (!file) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const full = path.join(ROOT, file);
  const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".jpeg": "image/jpeg", ".jpg": "image/jpeg" };
  let body = fs.readFileSync(full);
  if (file === "index.html" && PUBLIC_BASE_URL) {
    body = Buffer.from(String(body).replace(/content="\/og-card\.svg"/g, `content="${PUBLIC_BASE_URL}/og-card.svg"`), "utf8");
  }
  res.writeHead(200, {
    "Content-Type": types[path.extname(file)] || "application/octet-stream",
    "Cache-Control": file === "index.html" || file.endsWith(".js") || file.endsWith(".css") ? "no-store" : "public, max-age=3600"
  });
  res.end(body);
}

function buildPayload(account = "limon") {
  const sections = sectionsForAccount(account);
  const receipts = receiptsForAccount(account);
  const health = getAccountHealth(account);
  const settings = getAccountSettings(account);
  return {
    receipts,
    sections,
    stats: {
      todayTotal: receipts.reduce((sum, r) => sum + Number(r.amount || 0), 0),
      totalCount: receipts.length,
      lastScanAt: health.lastScanAt || ""
    },
    health,
    settings
  };
}

function getAccountSettings(account = "limon") {
  const root = state.accountSettings && typeof state.accountSettings === "object" ? state.accountSettings : {};
  const sectionSettings = root[account] && root[account].sectionSettings && typeof root[account].sectionSettings === "object" ? root[account].sectionSettings : {};
  return {
    totalAdjustment: Number(root[account] && root[account].totalAdjustment ? root[account].totalAdjustment : 0),
    updatedAt: root[account] && root[account].updatedAt ? root[account].updatedAt : "",
    updatedBy: root[account] && root[account].updatedBy ? root[account].updatedBy : "",
    sectionSettings
  };
}

function setAccountSettings(account, settings) {
  state.accountSettings = {
    ...(state.accountSettings || {}),
    [account]: settings
  };
}

function receiptsForAccount(account = "limon") {
  const sectionKeys = sectionsForAccount(account).map((section) => section.key);
  return sanitizeReceipts(state.receipts).filter((receipt) => sectionKeys.includes(receiptAccount(receipt)));
}

function receiptAccount(receipt) {
  return String(receipt && receipt.account ? receipt.account : "limon");
}

function sectionsForAccount(account = "limon") {
  return ACCOUNT_SECTIONS[account] || [{ key: account, label: account }];
}

function normalizeSectionKey(account, section) {
  const sections = sectionsForAccount(account);
  const key = String(section || "");
  return sections.some((item) => item.key === key) ? key : sections[0].key;
}

function getAccountHealth(account = "limon") {
  const healthRoot = state.health && typeof state.health === "object" ? state.health : {};
  if (healthRoot.accounts && healthRoot.accounts[account]) return healthRoot.accounts[account];
  if (account === "limon" && !healthRoot.accounts) return healthRoot;
  return {
    status: "idle",
    message: "Mail kaynagi bekleniyor",
    mailConfigured: Boolean(MAIL_ACCOUNTS[account] && MAIL_ACCOUNTS[account].email && MAIL_ACCOUNTS[account].password)
  };
}

function setAccountHealth(account, health) {
  const previous = state.health && typeof state.health === "object" ? state.health : {};
  const accounts = { ...(previous.accounts || {}) };
  accounts[account] = health;
  state.health = { accounts };
}

function broadcast(type, payload, account = null) {
  for (const client of [...clients]) {
    if (account && client.account !== account) continue;
    const data = `event: ${type}\ndata: ${JSON.stringify(payload || buildPayload(client.account))}\n\n`;
    try { client.res.write(data); } catch (error) { clients.delete(client); }
  }
}

function startScanLoop() {
  let firstRun = true;
  const run = async () => {
    const accounts = Object.keys(MAIL_ACCOUNTS);
    await Promise.all(accounts.map((account) => triggerScan(account, firstRun ? "startup" : "interval", firstRun ? SCAN_LOOKBACK_DAYS : null)));
    firstRun = false;
    scanTimer = setTimeout(run, SCAN_INTERVAL_MS);
  };
  scanTimer = setTimeout(run, 300);
}

async function triggerScan(account = "limon", mode = "interval", lookbackDays = SCAN_LOOKBACK_DAYS) {
  const source = MAIL_ACCOUNTS[account];
  if (!source) return;
  if (!source.email || !source.password) {
    setAccountHealth(account, {
      status: "idle",
      message: "Mail kaynagi bekleniyor",
      lastScanAt: new Date().toISOString(),
      mailAddress: "",
      mailConfigured: false,
      newCount: 0
    });
    broadcast("status", buildPayload(account), account);
    scheduleSave();
    return;
  }
  if (scanBusyAccounts.has(account)) {
    queuePendingScan(account, mode, lookbackDays);
    return;
  }
  scanBusyAccounts.add(account);
  setAccountHealth(account, { ...getAccountHealth(account), status: "scanning", message: "Son dekontlar okunuyor", startedAt: new Date().toISOString() });
  broadcast("status", buildPayload(account), account);
  try {
    const result = await scanMail(source, { mode, lookbackDays });
    setAccountHealth(account, {
      status: "ok",
      message: result.newReceipts.length ? `${result.newReceipts.length} yeni dekont eklendi` : "Dekont okuma tamamlandi",
      lastScanAt: new Date().toISOString(),
      scannedCandidates: result.candidates,
      processedCandidates: result.processed,
      skippedCandidates: result.skipped,
      mailAddress: maskEmail(source.email),
      mailConfigured: true,
      newCount: result.newReceipts.length
    });
    scheduleSave();
    broadcast("receipts", { ...buildPayload(account), newReceipts: result.newReceipts }, account);
  } catch (error) {
    setAccountHealth(account, { status: "error", message: sanitizeError(error), lastScanAt: new Date().toISOString(), mailAddress: maskEmail(source.email), mailConfigured: true });
    broadcast("status", buildPayload(account), account);
    scheduleSave();
  } finally {
    scanBusyAccounts.delete(account);
    const pending = pendingScanRequests.get(account);
    if (pending) {
      pendingScanRequests.delete(account);
      setImmediate(() => triggerScan(account, pending.mode, pending.lookbackDays));
    }
  }
}

function queuePendingScan(account, mode, lookbackDays) {
  const previous = pendingScanRequests.get(account);
  const priority = { interval: 1, startup: 2, manual: 3 };
  const previousPriority = priority[previous && previous.mode] || 0;
  const nextPriority = priority[mode] || 1;
  pendingScanRequests.set(account, {
    mode: nextPriority >= previousPriority ? mode : previous.mode,
    lookbackDays: Math.max(Number(previous && previous.lookbackDays) || 0, Number(lookbackDays) || 0, SCAN_LOOKBACK_DAYS)
  });
}

async function scanMail(source, { mode = "interval", lookbackDays }) {
  if (!source.email || !source.password) {
    throw new Error("Mail bilgileri eksik. DEKONT_MAIL ve DEKONT_APP_PASSWORD gerekli.");
  }
  const imap = new ImapClient(source.email, source.password);
  const hasHistory = receiptsForAccount(source.account).length > 0;
  const fullScan = mode === "manual" || (mode === "startup" && !hasHistory);
  const since = fullScan
    ? new Date(Date.now() - (lookbackDays || SCAN_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000)
    : new Date(Date.now() - HOT_SCAN_LOOKBACK_HOURS * 60 * 60 * 1000);
  const searchOptions = fullScan
    ? { terms: source.searchTerms || SEARCH_TERMS }
    : { mailboxes: LIVE_RECEIPT_MAILBOXES, terms: source.liveSearchTerms || LIVE_SEARCH_TERMS, subjectOnly: !source.deepLiveSearch };
  const fetchLimit = fullScan ? MAX_FETCH_PER_SCAN : LIVE_FETCH_PER_SCAN;
  await imap.connect();
  try {
    await imap.login();
    const targets = await imap.searchReceiptCandidatesSince(since, searchOptions);
    const known = new Set(state.seen);
    const routeAccounts = Array.isArray(source.routeAccounts) && source.routeAccounts.length ? source.routeAccounts : [source.account];
    const receiptKnown = new Set(routeAccounts.flatMap((routeAccount) => receiptsForAccount(routeAccount).map((r) => r.identityKey || r.id)));
    const shouldRecheckRecent = mode === "manual";
    const freshTargets = (shouldRecheckRecent ? targets : targets.filter((t) => !known.has(`${source.account}:${t.mailbox}:${t.uid}`))).slice(-fetchLimit);
    const messages = await imap.fetchMessages(freshTargets);
    const newReceipts = [];
    let processed = 0;
    let skipped = 0;
    for (const message of messages) {
      processed += 1;
      const key = `${source.account}:${message.mailbox}:${message.uid}`;
      const parsed = parseReceipt(message.uid, message.raw, message.mailbox, source.account);
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
  async searchReceiptCandidatesSince(date, options = {}) {
    const configuredMailboxes = Array.isArray(options.mailboxes) && options.mailboxes.length ? options.mailboxes : RECEIPT_MAILBOXES;
    const configuredTerms = Array.isArray(options.terms) && options.terms.length ? options.terms : SEARCH_TERMS;
    const available = [];
    for (const mailbox of configuredMailboxes) {
      try { await this.selectMailbox(mailbox); available.push(mailbox); } catch (_) {}
    }
    if (!available.length) throw new Error("Mail kutusu secilemedi");
    const targets = new Map();
    for (const mailbox of available) {
      await this.selectMailbox(mailbox);
      const runners = [
        () => this.searchSince(date),
        ...(options.subjectOnly ? [] : configuredTerms.map((term) => () => this.searchTextSince(date, term)))
      ];
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

function parseReceipt(uid, raw, mailbox, account = "limon") {
  const root = parseEntity(String(raw || ""));
  const subject = decodeMimeWords(root.headers.subject || "");
  const from = decodeMimeWords(root.headers.from || "");
  const messageId = normalizeMessageId(root.headers["message-id"] || "");
  const text = cleanText(extractMimeText(String(raw || "")));
  const htmlText = cleanText(htmlToText(extractMimeHtml(String(raw || ""))));
  const body = cleanText(`${text}\n${htmlText}` || extractText(raw));
  const searchable = normalizeSearch(`${subject}\n${from}\n${body}`);
  if (!isKuveytReceipt(searchable)) return null;
  const routedAccount = routeReceiptAccount(account, searchable);
  const details = extractReceiptDetails(body);
  const amount = details.amount || findAmount(body);
  if (!amount) return null;
  const sender = details.sender || inferSender(body);
  if (!isValidSender(sender)) return null;
  const senderBank = details.senderBank || inferSenderBank(body) || "Banka bilgisi yok";
  const desc = details.description || inferDescription(body) || "Aciklama yok";
  const transactionTime = parseReceiptDate(details.transactionTime || inferDate(body)) || parseDate(root.headers.date) || "";
  const receivedAt = parseDate(root.headers.date) || new Date().toISOString();
  const identityKey = `${routedAccount}:${messageId || `${normalizeSearch(sender)}:${amount.toFixed(2)}:${normalizeSearch(transactionTime || receivedAt)}`}`;
  const id = crypto.createHash("sha1").update(identityKey + ":" + uid).digest("hex").slice(0, 12).toUpperCase();
  return { id, account: routedAccount, uid: String(uid), mailbox, messageId, identityKey, sender, senderBank, amount, currency: "TRY", desc, transactionTime, receivedAt, time: shortTime(transactionTime || receivedAt), status: "Yeni geldi", subject };
}

function routeReceiptAccount(account, searchable) {
  if (account !== "limon") return account;
  const compact = compactSearch(searchable);
  const hasSlot3 = /(^|[^0-9])3\s*numarali\s*hesabiniza/.test(searchable) || compact.includes("3numaralihesabiniza");
  const hasSlot1 = /(^|[^0-9])1\s*numarali\s*hesabiniza/.test(searchable) || compact.includes("1numaralihesabiniza");
  if (hasSlot3) return "limon-toplam";
  if (hasSlot1) return "limon";
  return "limon";
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

function parseEntity(raw) {
  const text = String(raw || "");
  const match = text.match(/\r?\n\r?\n/);
  const split = match ? match.index : -1;
  const headerText = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? "" : text.slice(split + match[0].length);
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return { headers, body };
}

function extractMimeText(raw) {
  const entity = parseEntity(raw);
  const contentType = String(entity.headers["content-type"] || "text/plain").toLowerCase();
  const boundary = getHeaderParam(entity.headers["content-type"], "boundary");
  if (contentType.includes("multipart/") && boundary) {
    const parts = splitMultipart(entity.body, boundary).map(extractMimeText).filter(Boolean);
    const plain = parts.find((part) => !/<[a-z][\s\S]*>/i.test(part));
    return plain || parts.join("\n");
  }
  const decoded = decodeTransfer(entity.body, entity.headers["content-transfer-encoding"]);
  return contentType.includes("text/html") ? htmlToText(decoded) : decoded;
}

function extractMimeHtml(raw) {
  const entity = parseEntity(raw);
  const contentType = String(entity.headers["content-type"] || "text/plain").toLowerCase();
  const boundary = getHeaderParam(entity.headers["content-type"], "boundary");
  if (contentType.includes("multipart/") && boundary) {
    const parts = splitMultipart(entity.body, boundary).map(extractMimeHtml).filter(Boolean);
    return parts.find((part) => /<html|<body|<table|<div/i.test(part)) || parts[0] || "";
  }
  const decoded = decodeTransfer(entity.body, entity.headers["content-transfer-encoding"]);
  return contentType.includes("text/html") ? decoded : "";
}

function splitMultipart(body, boundary) {
  const marker = `--${boundary}`;
  return String(body || "")
    .split(marker)
    .slice(1)
    .map((part) => part.replace(/^\r?\n/, "").replace(/\r?\n--\s*$/, ""))
    .filter((part) => part.trim() && !part.trim().startsWith("--"));
}

function getHeaderParam(value, param) {
  const match = String(value || "").match(new RegExp(`${param}="?([^";]+)"?`, "i"));
  return match ? match[1] : "";
}

function decodeTransfer(body, encoding = "") {
  const normalized = String(encoding || "").toLowerCase();
  if (normalized.includes("base64")) return Buffer.from(String(body || "").replace(/\s+/g, ""), "base64").toString("utf8");
  if (normalized.includes("quoted-printable")) return decodeQuotedPrintable(body);
  return String(body || "");
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

function buildReceiptFieldLookup() {
  const entries = [];
  for (const [key, aliases] of Object.entries(RECEIPT_FIELD_ALIASES)) {
    for (const raw of aliases) {
      const label = normalizeSearch(raw);
      entries.push({ key, raw, label, compact: compactSearch(label) });
    }
  }
  return entries.sort((a, b) => b.compact.length - a.compact.length);
}

function receiptLines(text) {
  return insertReceiptFieldBreaks(String(text || ""))
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function insertReceiptFieldBreaks(text) {
  let output = String(text || "").replace(/\r/g, "\n");
  for (const label of RECEIPT_FIELD_LOOKUP) {
    const pattern = new RegExp(`([\\s\\-|,;]+)(${labelPattern(label.raw)})\\s*[:\\uFF1A]`, "gi");
    output = output.replace(pattern, "\n$2:");
  }
  return output;
}

function labelPattern(label) {
  return String(label || "").split("").map((char) => {
    const lower = char.toLocaleLowerCase("tr-TR");
    if (/\s/.test(char)) return "\\s+";
    if (lower === "c") return "[cC\\u00e7\\u00c7]";
    if (lower === "g") return "[gG\\u011f\\u011e]";
    if (lower === "i" || lower === "\u0131") return "[iI\\u0131\\u0130]";
    if (lower === "o") return "[oO\\u00f6\\u00d6]";
    if (lower === "s") return "[sS\\u015f\\u015e]";
    if (lower === "u") return "[uU\\u00fc\\u00dc]";
    return escapeRegExp(char);
  }).join("");
}

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

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

function extractReceiptDetails(text) {
  const lines = receiptLines(text);
  const fields = collectReceiptFields(lines);
  const amountText = firstReceiptField(fields, "amount") || findLabelField(lines, RECEIPT_FIELD_ALIASES.amount);
  const senderText = firstReceiptField(fields, "sender") || findLabelField(lines, RECEIPT_FIELD_ALIASES.sender, ["Banka", "IBAN", "Tutar"]);
  const bankText = firstReceiptField(fields, "senderBank") || findLabelField(lines, RECEIPT_FIELD_ALIASES.senderBank);
  const descriptionText = firstReceiptField(fields, "description") || findLabelField(lines, RECEIPT_FIELD_ALIASES.description);
  const timeText = firstReceiptField(fields, "transactionTime") || findLabelField(lines, RECEIPT_FIELD_ALIASES.transactionTime);

  return {
    amount: parseAmount(amountText) || parseContextualAmount(text),
    sender: sanitizeReceiptValue(senderText || inferSenderFromSentence(text), "sender"),
    senderBank: sanitizeReceiptValue(bankText, "senderBank"),
    description: sanitizeReceiptValue(descriptionText || inferDescription(text), "description"),
    transactionTime: sanitizeReceiptValue(timeText || inferDate(text), "transactionTime")
  };
}

function collectReceiptFields(lines) {
  const fields = { amount: [], sender: [], senderBank: [], description: [], transactionTime: [] };
  for (let index = 0; index < lines.length; index += 1) {
    const match = matchReceiptField(lines[index]);
    if (!match) continue;
    let value = sanitizeReceiptValue(match.value, match.key);
    if (!isUsableReceiptValue(value, match.key)) value = findNextReceiptValue(lines, index, match.key);
    if (isUsableReceiptValue(value, match.key)) fields[match.key].push(value);
  }
  return fields;
}

function matchReceiptField(line) {
  const colonIndex = firstColonIndex(line);
  const labelPart = colonIndex === -1 ? line : line.slice(0, colonIndex);
  const normalizedLabel = normalizeSearch(labelPart).replace(/^[^a-z0-9]+/, "").trim();
  const normalizedLine = normalizeSearch(line).replace(/^[^a-z0-9]+/, "").trim();
  const compactLabel = compactSearch(normalizedLabel);
  const compactLine = compactSearch(normalizedLine);
  const matched = RECEIPT_FIELD_LOOKUP.find((field) => compactLabel === field.compact || compactLabel.endsWith(field.compact) || compactLine.startsWith(field.compact));
  if (!matched) return null;
  const value = colonIndex === -1 ? removeReceiptLabel(line, matched.raw) : line.slice(colonIndex + 1);
  return { key: matched.key, value };
}

function firstColonIndex(value) {
  const text = String(value || "");
  const indexes = [text.indexOf(":"), text.indexOf("\uFF1A"), text.indexOf("：")].filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : -1;
}

function removeReceiptLabel(line, label) {
  const pattern = new RegExp(`^\\s*[-*]?\\s*${labelPattern(label)}\\s*[:\\uFF1A\\-]?\\s*`, "i");
  return String(line || "").replace(pattern, "").trim();
}

function findNextReceiptValue(lines, index, key) {
  for (let offset = 1; offset <= 3; offset += 1) {
    const next = lines[index + offset];
    if (!next || matchReceiptField(next) || looksLikeLabel(next)) break;
    const value = sanitizeReceiptValue(next, key);
    if (isUsableReceiptValue(value, key)) return value;
  }
  return "";
}

function firstReceiptField(fields, key) {
  const values = fields[key] || [];
  return values.find((value) => isUsableReceiptValue(value, key)) || "";
}

function sanitizeReceiptValue(value, key) {
  let cleaned = truncateAtNextReceiptLabel(String(value || ""))
    .replace(/^[\s:;\-\|]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (key === "amount") return cleaned;
  return cleaned
    .replace(/^(adi soyadi|adi|soyadi|unvani)\s*[:;\-]?\s*/i, "")
    .replace(/\s+[,;:.-]*$/, "")
    .trim();
}

function isUsableReceiptValue(value, key) {
  const cleaned = String(value || "").trim();
  if (!cleaned) return false;
  const normalized = normalizeSearch(cleaned);
  if (isBlockedReceiptValue(cleaned) || normalized.includes("kuveyt turk bilgilendirme") || normalized.includes("hesabiniza para geldi") || normalized === "belirtilmedi" || looksLikeLabel(cleaned)) return false;
  if (key === "amount") return parseAmount(cleaned) > 0;
  if (key === "sender") return isLikelySenderName(cleaned);
  if (key === "senderBank") return isLikelyBankName(cleaned);
  if (key === "description") return cleaned.length <= 260;
  return cleaned.length <= 120;
}

function isBlockedReceiptValue(value) {
  const normalized = normalizeSearch(value);
  return BLOCKED_RECEIPT_VALUE_TERMS.some((term) => normalized.includes(normalizeSearch(term)));
}

function isLikelySenderName(value) {
  const cleaned = sanitizeValue(value);
  const normalized = normalizeSearch(cleaned);
  if (!cleaned || cleaned.length < 3 || cleaned.length > 120 || isBlockedReceiptValue(cleaned)) return false;
  if (/\d{4,}|@|www\.|http/i.test(cleaned)) return false;
  if (normalized.includes("banka") || normalized.includes("sube") || normalized.includes("iban") || normalized.includes("hesap")) return false;
  return /[a-zA-ZÇĞİÖŞÜçğıöşü]/.test(cleaned);
}

function isLikelyBankName(value) {
  const cleaned = sanitizeValue(value);
  const normalized = normalizeSearch(cleaned);
  if (!cleaned || cleaned.length < 3 || cleaned.length > 140 || isBlockedReceiptValue(cleaned)) return false;
  if (/\d{5,}|@|www\.|http/i.test(cleaned)) return false;
  return /banka|bankasi|katilim|finans|ziraat|garanti|akbank|yapi kredi|is bankasi|denizbank|vakif|halk|teb|qnb|enpara|papara|payfix|turkiye/i.test(normalized) || /[a-zA-ZÇĞİÖŞÜçğıöşü]/.test(cleaned);
}

function truncateAtNextReceiptLabel(value) {
  let end = String(value || "").length;
  for (const field of RECEIPT_FIELD_LOOKUP) {
    const pattern = new RegExp(`\\s+${labelPattern(field.raw)}\\s*[:\\uFF1A]`, "i");
    const match = pattern.exec(value);
    if (match && match.index > 0 && match.index < end) end = match.index;
  }
  return String(value || "").slice(0, end);
}

function looksLikeLabel(value) {
  const compact = compactSearch(value || "");
  return RECEIPT_FIELD_LOOKUP.some((field) => compact.startsWith(field.compact));
}

function findLabelField(lines, labels, excludes = []) {
  const normalizedLabels = labels.map(normalizeSearch);
  const normalizedExcludes = excludes.map(normalizeSearch);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalizedLine = normalizeSearch(line);
    const compactLine = normalizedLine.replace(/\s+/g, "");
    let matchedCompactLabel = "";
    const matchedLabel = normalizedLabels.find((label) => {
      const compactLabel = label.replace(/\s+/g, "");
      const matches = normalizedLine === label || normalizedLine.startsWith(`${label}:`) || normalizedLine.startsWith(`${label} `) || compactLine.startsWith(`${compactLabel}:`) || compactLine.startsWith(compactLabel);
      if (matches) matchedCompactLabel = compactLabel;
      return matches;
    });
    const hasExclude = normalizedExcludes.some((label) => normalizedLine.includes(label) || compactLine.includes(label.replace(/\s+/g, "")));
    if (!matchedLabel || hasExclude || normalizedLine.length > 160) continue;
    const value = line.split(/:|：/).slice(1).join(":").trim();
    if (value) return value;
    const compactRemainder = compactLine.replace(matchedCompactLabel, "").replace(/^[:\s-]+/, "").trim();
    const cleaned = normalizedLine.replace(matchedLabel, "").replace(/^[:\s-]+/, "").trim();
    if (compactRemainder.length && cleaned.length > 2) return removeReceiptLabel(line, matchedLabel);
    const next = lines[index + 1];
    if (next && !looksLikeLabel(next)) return next.trim();
  }
  return "";
}

function parseContextualAmount(text) {
  const lines = receiptLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || "";
    const normalized = normalizeSearch(line);
    if (normalized.includes("tutar") || normalized.includes("gelen tutar") || normalized.includes("para girisi") || normalized.includes("hesaba gelen")) {
      const amount = parseAmount([line, lines[index + 1] || "", lines[index - 1] || ""].join(" "));
      if (amount > 0) return amount;
    }
  }
  return 0;
}

function findAmount(text) {
  return parseAmount(text);
}

function parseAmount(text) {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const hasAmountLabel = /(?:tutar|islem tutari|islem tutar|gelen tutar|havale tutari|eft tutari|transfer tutari|odeme tutari|para girisi|hesaba gelen)/i.test(normalized);
  if (normalized.length > 120 && !hasAmountLabel) return 0;
  const labelMatch = normalized.match(/(?:tutar|islem tutari|islem tutar|gelen tutar|havale tutari|eft tutari|transfer tutari|odeme tutari|para girisi|hesaba gelen)[^0-9]{0,40}([0-9][0-9.,\s]*)\s*(?:tl|try|₺)?/i);
  const fallbackMatch = normalized.match(/([0-9][0-9.,\s]*)\s*(?:tl|try|₺)/i);
  return parseLocalizedAmount((labelMatch && labelMatch[1]) || (fallbackMatch && fallbackMatch[1]) || "0");
}

function parseLocalizedAmount(value) {
  const raw = String(value || "").replace(/[^\d.,]/g, "");
  if (!raw) return 0;
  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");
  const decimalSeparator = lastDot > lastComma ? "." : ",";
  const hasDecimal = /[.,]\d{1,2}$/.test(raw);
  if (raw.includes(".") && raw.includes(",")) {
    return Number(raw.replace(new RegExp(`\\${decimalSeparator === "." ? "," : "."}`, "g"), "").replace(decimalSeparator, ".")) || 0;
  }
  if (hasDecimal) {
    const separator = lastDot !== -1 ? "." : ",";
    return Number(raw.replace(separator, ".")) || 0;
  }
  return Number(raw.replace(/[.,]/g, "")) || 0;
}

function inferSender(text) {
  const lines = receiptLines(text);
  const line = lines.find((item) => !isBlockedReceiptValue(item) && /adl[ıi]\s+ki[şs]iden|taraf[ıi]ndan|g[oö]nderen/i.test(item));
  if (!line) return "";
  const match =
    line.match(/(?:saatinde\s+)?(.{3,90}?)\s+adl[ıi]\s+ki[şs]iden/i) ||
    line.match(/(.{3,90}?)\s+taraf[ıi]ndan/i) ||
    line.match(/g[oö]nderen(?:\s+ad[ıi]\s+soyad[ıi])?\s*[:：]\s*(.{3,90})/i);
  const value = match ? sanitizeReceiptValue(match[1], "sender") : "";
  return isUsableReceiptValue(value, "sender") ? value : "";
}

function inferSenderFromSentence(text) {
  const lines = receiptLines(text);
  for (const line of lines) {
    if (isBlockedReceiptValue(line)) continue;
    const match =
      line.match(/\bsaatinde\s+(.{3,100}?)\s+adl[ıi]\s+ki[şs]iden\b/i) ||
      line.match(/(.{3,100}?)\s+taraf[ıi]ndan\s+(?:hesab[ıi]n[ıi]za|hesabiniza|taraf[ıi]n[ıi]za)/i);
    if (match) {
      const value = sanitizeReceiptValue(match[1], "sender");
      if (isUsableReceiptValue(value, "sender")) return value;
    }
  }
  return "";
}

function inferSenderBank(text) {
  const lines = receiptLines(text);
  const value = findLabelField(lines, RECEIPT_FIELD_ALIASES.senderBank);
  if (isUsableReceiptValue(value, "senderBank")) return sanitizeReceiptValue(value, "senderBank");
  const line = lines.find((item) => !isBlockedReceiptValue(item) && /(?:g[oö]nderen|gonderici|kar[şs][ıi])\s+banka/i.test(item));
  if (!line) return "";
  const match = line.match(/(?:g[oö]nderen|gonderici|kar[şs][ıi])\s+banka(?:s[ıi])?\s*[:：-]?\s*(.{3,120})/i);
  const bank = match ? sanitizeReceiptValue(match[1], "senderBank") : "";
  return isUsableReceiptValue(bank, "senderBank") ? bank : "";
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

function parseReceiptDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const direct = parseDate(text);
  if (direct) return direct;
  const match = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2})[:.](\d{2})(?::(\d{2}))?)?/);
  if (!match) return "";
  const [, day, month, year, hour = "0", minute = "0", second = "0"] = match;
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:${second.padStart(2, "0")}+03:00`;
  return parseDate(iso);
}

function shortTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" }).format(date);
}

function sanitizeReceipts(receipts) {
  return sortReceipts((receipts || []).map(normalizeStoredReceiptRoute).filter(isDisplayableReceipt));
}

function normalizeStoredReceiptRoute(receipt) {
  if (!receipt || receipt.account !== "limon") return receipt;
  const searchable = normalizeSearch(`${receipt.subject || ""}\n${receipt.desc || ""}`);
  const routed = routeReceiptAccount("limon", searchable);
  return routed === receipt.account ? receipt : { ...receipt, account: routed, identityKey: receipt.identityKey ? receipt.identityKey.replace(/^limon:/, `${routed}:`) : receipt.identityKey };
}

function isDisplayableReceipt(receipt) {
  return Boolean(receipt && Number(receipt.amount || 0) > 0 && isValidSender(receipt.sender));
}

function isValidSender(sender) {
  const value = sanitizeValue(sender);
  const normalized = normalizeSearch(value);
  if (!value || value.length < 3) return false;
  if (["belirtilmedi", "bilinmiyor", "gonderen yok", "sender yok"].includes(normalized)) return false;
  return isLikelySenderName(value);
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
    const key = `${receiptAccount(receipt)}:${receipt.identityKey || receipt.messageId || receipt.id}`;
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

async function startServer() {
  server.listen(PORT, () => {
    console.log(`Dekont Kontrol hazir: http://127.0.0.1:${PORT}`);
    console.log("Dosya tabanli kalici kayit aktif");
    startScanLoop();
  });
}

startServer().catch((error) => {
  console.error(`Baslatma hatasi: ${sanitizeError(error)}`);
  process.exitCode = 1;
});
