const loginView = document.getElementById("loginView");
const dashboardView = document.getElementById("dashboardView");
const loginForm = document.getElementById("loginForm");
const usernameInput = document.getElementById("usernameInput");
const passwordInput = document.getElementById("passwordInput");
const togglePassword = document.getElementById("togglePassword");
const loginMessage = document.getElementById("loginMessage");
const panelChoice = document.getElementById("panelChoice");
const forgotPasswordButton = document.getElementById("forgotPasswordButton");
const welcomeTitle = document.getElementById("welcomeTitle");
const clockText = document.getElementById("clockText");
const logoutButton = document.getElementById("logoutButton");
const scanStatus = document.getElementById("scanStatus");
const todayTotal = document.getElementById("todayTotal");
const totalAdjustInput = document.getElementById("totalAdjustInput");
const totalAddButton = document.getElementById("totalAddButton");
const totalSubtractButton = document.getElementById("totalSubtractButton");
const totalSetButton = document.getElementById("totalSetButton");
const totalAdjustMessage = document.getElementById("totalAdjustMessage");
const totalUpdateNotice = document.getElementById("totalUpdateNotice");
const totalCount = document.getElementById("totalCount");
const lastScan = document.getElementById("lastScan");
const searchInput = document.getElementById("searchInput");
const refreshButton = document.getElementById("refreshButton");
const receiptList = document.getElementById("receiptList");
const pagination = document.getElementById("pagination");
const toastWrap = document.getElementById("toastWrap");
const cashboxCard = document.getElementById("cashboxCard");
const cashboxToggle = document.getElementById("cashboxToggle");
const cashboxStatus = document.getElementById("cashboxStatus");
const cashboxInput = document.getElementById("cashboxInput");
const cashboxStart = document.getElementById("cashboxStart");
const cashboxReset = document.getElementById("cashboxReset");
const cashboxManualInput = document.getElementById("cashboxManualInput");
const cashboxManualAdd = document.getElementById("cashboxManualAdd");
const cashboxManualMessage = document.getElementById("cashboxManualMessage");
const cashboxTotal = document.getElementById("cashboxTotal");
const welcomeOverlay = document.getElementById("welcomeOverlay");
const splashName = document.getElementById("splashName");
const splashLogo = document.getElementById("splashLogo");
const panelLogo = document.getElementById("panelLogo");
const sourceLabel = document.getElementById("sourceLabel");
const manualRefreshOverlay = document.getElementById("manualRefreshOverlay");
const sectionSwitcher = document.getElementById("sectionSwitcher");
const adminPresence = document.getElementById("adminPresence");

const state = {
  user: null,
  receipts: [],
  health: {},
  stats: {},
  settings: {},
  sections: [],
  activeSection: "",
  page: 1,
  search: "",
  eventSource: null,
  liveReady: false,
  cashbox: {},
  totalAdjustment: 0,
  presence: null,
  pendingPanels: [],
  lastReceiptRenderKey: "",
  lastStatsRenderKey: ""
};

function money(value) {
  return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", minimumFractionDigits: 2 }).format(Number(value || 0));
}

function shortDate(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("tr-TR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Istanbul" }).format(date);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Islem tamamlanamadi");
  return payload;
}

async function checkSession() {
  const payload = await api("/api/me");
  if (payload.authenticated) enterApp(payload.user);
}

function enterApp(user) {
  state.user = user;
  const theme = user.theme || "limon";
  const logo = user.logo || "/limon.svg";
  state.page = Number(localStorage.getItem(storageKey("page")) || 1);
  state.cashbox = loadCashbox();
  state.totalAdjustment = 0;
  state.receipts = [];
  state.health = {};
  state.stats = {};
  state.settings = {};
  state.sections = [];
  state.presence = null;
  state.activeSection = "";
  state.search = "";
  state.liveReady = false;
  state.lastReceiptRenderKey = "";
  state.lastStatsRenderKey = "";
  if (searchInput) searchInput.value = "";
  if (totalAdjustMessage) totalAdjustMessage.textContent = "";
  if (totalUpdateNotice) totalUpdateNotice.textContent = "";
  document.body.dataset.panelTheme = theme;
  const displayName = user.name || user.username || "Limon Admin";
  welcomeTitle.textContent = `${displayName}`;
  if (splashName) {
    splashName.textContent = `Hoşgeldin, ${displayName}`;
  }
  if (splashLogo) splashLogo.src = logo;
  if (panelLogo) panelLogo.src = logo;
  if (sourceLabel) sourceLabel.textContent = user.sourceLabel || "Veriler kalici database kaydiyla korunur.";
  showWelcomeSplash();
  loginView.classList.add("login-fade-out");
  setTimeout(() => {
    loginView.classList.add("hidden");
    loginView.classList.remove("login-fade-out");
    dashboardView.classList.remove("hidden");
    dashboardView.classList.add("panel-fade-in");
    setTimeout(() => dashboardView.classList.remove("panel-fade-in"), 420);
  }, 260);
  connectEvents();
  renderAll({ receiptsChanged: true });
  fetchReceipts("silent");
  renderCashbox();
}

function leaveApp() {
  state.user = null;
  state.liveReady = false;
  delete document.body.dataset.panelTheme;
  if (state.eventSource) state.eventSource.close();
  dashboardView.classList.add("panel-fade-out");
  setTimeout(() => {
    dashboardView.classList.add("hidden");
    dashboardView.classList.remove("panel-fade-out");
    loginView.classList.remove("hidden");
    loginView.classList.add("login-fade-in");
    setTimeout(() => loginView.classList.remove("login-fade-in"), 420);
  }, 220);
  passwordInput.value = "";
  hidePanelChoice();
}

function showWelcomeSplash() {
  if (!welcomeOverlay) return;
  welcomeOverlay.classList.remove("hidden");
  welcomeOverlay.classList.add("active");
  setTimeout(() => {
    welcomeOverlay.classList.remove("active");
    setTimeout(() => welcomeOverlay.classList.add("hidden"), 420);
  }, 1150);
}

function connectEvents() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = new EventSource("/api/events");
  state.eventSource.addEventListener("ready", (event) => applyPayload(JSON.parse(event.data), "silent"));
  state.eventSource.addEventListener("status", (event) => applyStatusPayload(JSON.parse(event.data)));
  state.eventSource.addEventListener("receipts", (event) => {
    const payload = JSON.parse(event.data);
    const newReceipts = Array.isArray(payload.newReceipts) ? payload.newReceipts : [];
    applyPayload(payload, state.liveReady && newReceipts.length ? "toast" : "silent", newReceipts);
    state.liveReady = true;
  });
  state.eventSource.addEventListener("settings", (event) => applyPayload(JSON.parse(event.data), "settings"));
}

function applyStatusPayload(payload) {
  const nextHealth = payload.health || {};
  if (nextHealth.status === "scanning") {
    return;
  }
  state.health = nextHealth || state.health || {};
  state.stats = payload.stats || state.stats || {};
  state.presence = payload.presence || state.presence || null;
  state.sections = Array.isArray(payload.sections) ? payload.sections : state.sections;
  ensureActiveSection();
  applySettings(payload.settings);
  renderStatusOnly();
}

async function fetchReceipts(mode = "normal") {
  const payload = await api("/api/receipts");
  applyPayload(payload, mode);
  state.liveReady = true;
}

function applyPayload(payload, mode = "normal", newReceipts = []) {
  const previousIds = new Set(state.receipts.map((item) => item.id));
  const previousReceiptKey = receiptCollectionKey(state.receipts);
  const previousSettingsAt = currentSectionSettings().updatedAt || "";
  state.receipts = Array.isArray(payload.receipts) ? payload.receipts : [];
  state.health = payload.health || {};
  state.stats = payload.stats || {};
  state.sections = Array.isArray(payload.sections) ? payload.sections : [];
  state.presence = payload.presence || null;
  ensureActiveSection();
  applySettings(payload.settings);
  const nextSettings = currentSectionSettings();
  if (mode === "settings" && !state.user?.canManageTotals && previousSettingsAt && nextSettings.updatedAt && previousSettingsAt !== nextSettings.updatedAt) {
    showInfoToast("Site yöneticiniz kasayı güncelledi", nextSettings.updatedBy ? `${nextSettings.updatedBy} tarafından güncellendi` : "Toplam tutar anlık yenilendi");
  }
  ensureLimonCashboxBaseline();
  syncCashbox(newReceipts.length ? newReceipts : state.receipts.filter((item) => !previousIds.has(item.id)));
  renderAll({
    receiptsChanged: previousReceiptKey !== receiptCollectionKey(state.receipts)
  });
  if (mode === "toast") {
    newReceipts.slice(0, 3).forEach(showReceiptToast);
  }
}

function receiptCollectionKey(receipts) {
  return (receipts || []).map((item) => `${item.id}:${item.account || ""}:${item.status || ""}:${item.amount || 0}`).join("|");
}

function renderAll({ receiptsChanged = true } = {}) {
  const sectionReceipts = receiptsForActiveSection();
  const sectionTotal = sectionReceipts.reduce((sum, receipt) => sum + Number(receipt.amount || 0), 0);
  todayTotal.textContent = money(sectionTotal + Number(state.totalAdjustment || 0));
  totalCount.textContent = String(sectionReceipts.length || 0);
  renderSectionSwitcher();
  renderAdminControls();
  renderTotalUpdateNotice();
  renderPresence();
  renderStatusOnly();
  if (receiptsChanged || state.lastReceiptRenderKey !== visibleRenderKey()) {
    renderReceipts();
  }
  renderCashbox();
}

function applySettings(settings = {}) {
  state.settings = settings || {};
  const sectionKey = activeSectionKey();
  const hasSections = state.settings.sectionSettings && typeof state.settings.sectionSettings === "object";
  const sectionSettings = hasSections ? (state.settings.sectionSettings[sectionKey] || {}) : state.settings;
  state.totalAdjustment = Number(sectionSettings.totalAdjustment || 0);
}

function currentSectionSettings() {
  const sectionKey = activeSectionKey();
  const hasSections = state.settings && state.settings.sectionSettings && typeof state.settings.sectionSettings === "object";
  return hasSections ? (state.settings.sectionSettings[sectionKey] || {}) : (state.settings || {});
}

function renderAdminControls() {
  const canManage = Boolean(state.user && state.user.canManageTotals);
  [totalAdjustInput, totalAddButton, totalSubtractButton, totalSetButton].forEach((item) => {
    if (item) item.disabled = !canManage;
  });
  const adjust = document.querySelector(".total-adjust");
  if (adjust) adjust.classList.toggle("locked", !canManage);
  if (!canManage && totalAdjustMessage && !totalAdjustMessage.textContent) {
    totalAdjustMessage.textContent = "Sadece site yöneticisi değiştirebilir.";
  }
}

function renderTotalUpdateNotice() {
  if (!totalUpdateNotice) return;
  const sectionSettings = currentSectionSettings();
  if (!sectionSettings.updatedAt) {
    totalUpdateNotice.textContent = "";
    totalUpdateNotice.classList.remove("active");
    return;
  }
  totalUpdateNotice.textContent = `Site yöneticisi kasanızı güncelledi · Son güncelleme ${formatScanMinute(sectionSettings.updatedAt)}`;
  totalUpdateNotice.classList.add("active");
}

function renderPresence() {
  if (!adminPresence) return;
  const presence = state.presence;
  if (!state.user || !state.user.canManageTotals || !presence) {
    adminPresence.classList.add("hidden");
    adminPresence.innerHTML = "";
    return;
  }
  const devices = Array.isArray(presence.devices) ? presence.devices : [];
  adminPresence.classList.remove("hidden");
  adminPresence.innerHTML = `
    <div>
      <span>Yönetici izlemesi</span>
      <strong>${Number(presence.totalDevices || 0)} aktif cihaz · ${Number(presence.totalSessions || 0)} açık oturum</strong>
    </div>
    <div class="presence-list">
      ${devices.length ? devices.map((device) => `
        <article>
          <b>${escapeHtml(device.name || "Bilinmeyen")}</b>
          <small>${escapeHtml(device.account || "-")} · ${escapeHtml(shortDate(device.connectedAt))}</small>
        </article>`).join("") : `<article><b>Aktif cihaz yok</b><small>Panel bağlantısı bekleniyor</small></article>`}
    </div>`;
}

function ensureActiveSection() {
  const sections = normalizedSections();
  const saved = localStorage.getItem(storageKey("section")) || "";
  if (!state.activeSection || !sections.some((section) => section.key === state.activeSection)) {
    state.activeSection = sections.some((section) => section.key === saved) ? saved : sections[0].key;
  }
}

function normalizedSections() {
  if (Array.isArray(state.sections) && state.sections.length) return state.sections;
  const account = state.user && state.user.account ? state.user.account : "limon";
  return [{ key: account, label: account === "limon" ? "Limon" : "Dekontlar" }];
}

function activeSectionKey() {
  ensureActiveSection();
  return state.activeSection || normalizedSections()[0].key;
}

function receiptsForActiveSection() {
  const sectionKey = activeSectionKey();
  return state.receipts.filter((receipt) => (receipt.account || (state.user && state.user.account) || "limon") === sectionKey);
}

function renderSectionSwitcher() {
  if (!sectionSwitcher) return;
  const sections = normalizedSections();
  if (sections.length <= 1) {
    sectionSwitcher.classList.add("hidden");
    sectionSwitcher.innerHTML = "";
    return;
  }
  sectionSwitcher.classList.remove("hidden");
  const active = activeSectionKey();
  sectionSwitcher.innerHTML = sections.map((section) => `<button class="section-button ${section.key === active ? "active" : ""}" type="button" data-section="${escapeHtml(section.key)}">${escapeHtml(section.label)}</button>`).join("");
}

function renderStatusOnly() {
  lastScan.textContent = formatScanMinute(state.stats.lastScanAt);
  scanStatus.className = `live-pill ${state.health.status === "error" ? "error" : state.health.status === "scanning" ? "scanning" : ""}`;
  scanStatus.textContent = state.health.status === "error"
    ? (state.health.message || "Kontrol gerekli")
    : "Canlı izleniyor";
}

function formatScanMinute(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" }).format(date);
}

function getVisibleReceipts() {
  const query = normalize(state.search);
  return receiptsForActiveSection().filter((receipt) => {
    if (!query) return true;
    return normalize(`${receipt.sender} ${receipt.senderBank} ${receipt.amount} ${receipt.desc} ${receipt.id}`).includes(query);
  });
}

function renderReceipts() {
  const visible = getVisibleReceipts();
  const totalPages = Math.max(1, Math.ceil(visible.length / 10));
  state.page = Math.min(Math.max(1, state.page), totalPages);
  localStorage.setItem(storageKey("page"), String(state.page));
  const newestId = visible[0] && visible[0].id;
  const pageItems = visible.slice((state.page - 1) * 10, state.page * 10);
  const nextRenderKey = visibleRenderKey(pageItems, totalPages, newestId);
  if (nextRenderKey === state.lastReceiptRenderKey) {
    return;
  }
  state.lastReceiptRenderKey = nextRenderKey;
  if (!pageItems.length) {
    receiptList.innerHTML = `<div class="empty-state">Dekont bekleniyor. Mail geldigi anda burada gorunecek.</div>`;
  } else {
    receiptList.innerHTML = pageItems.map((receipt) => `
      <article class="receipt-card ${receipt.id === newestId ? "latest" : ""}">
        <div class="receipt-main">
          <div class="receipt-title-row">
            <strong>${escapeHtml(receipt.sender || "Belirtilmedi")}</strong>
            ${receipt.id === newestId ? `<span class="new-badge">Son gelen</span>` : ""}
          </div>
          <p>${escapeHtml(receipt.desc || "Aciklama yok")}</p>
          <small>Gonderen bankasi: ${escapeHtml(receipt.senderBank || "Banka bilgisi yok")}</small>
          <small>Islem zamani: ${escapeHtml(shortDate(receipt.transactionTime || receipt.receivedAt))}</small>
        </div>
        <div class="receipt-side">
          <strong>${money(receipt.amount)}</strong>
          <span>${escapeHtml(receipt.id)}</span>
        </div>
      </article>`).join("");
  }
  pagination.innerHTML = totalPages <= 1 ? "" : Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => `<button class="page-button ${page === state.page ? "active" : ""}" type="button" data-page="${page}">${page}</button>`).join("");
}

function visibleRenderKey(pageItems = null, totalPages = null, newestId = "") {
  const list = pageItems || getVisibleReceipts().slice((state.page - 1) * 10, state.page * 10);
  const pageCount = totalPages || Math.max(1, Math.ceil(getVisibleReceipts().length / 10));
  return [
    state.page,
    pageCount,
    normalize(state.search),
    newestId || (getVisibleReceipts()[0] && getVisibleReceipts()[0].id) || "",
    list.map((receipt) => `${receipt.id}:${receipt.amount}:${receipt.sender}:${receipt.senderBank}:${receipt.transactionTime}:${receipt.desc}`).join("|")
  ].join("::");
}

function showReceiptToast(receipt) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<span>Yeni dekont algilandi</span><strong>${escapeHtml(receipt.sender || "Belirtilmedi")}</strong><b>${money(receipt.amount)}</b>`;
  toastWrap.appendChild(toast);
  setTimeout(() => toast.remove(), 6500);
}

function showInfoToast(title, detail = "") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<span>${escapeHtml(title)}</span>${detail ? `<strong>${escapeHtml(detail)}</strong>` : ""}`;
  toastWrap.appendChild(toast);
  setTimeout(() => toast.remove(), 6500);
}

function loadCashbox() {
  try { return JSON.parse(localStorage.getItem(storageKey("cashbox")) || "{}"); } catch (_) { return {}; }
}
function saveCashbox() { localStorage.setItem(storageKey("cashbox"), JSON.stringify(state.cashbox)); }
function ensureLimonCashboxBaseline() {
  return;
}
function syncCashbox(newReceipts) {
  return;
  const applied = new Set(state.cashbox.applied || []);
  let total = Number(state.cashbox.total || 0);
  for (const receipt of newReceipts) {
    if (!receipt || applied.has(receipt.id)) continue;
    total += Number(receipt.amount || 0);
    applied.add(receipt.id);
  }
  state.cashbox.total = total;
  state.cashbox.applied = [...applied].slice(-2000);
  saveCashbox();
}
function renderCashbox() {
  if (!cashboxStatus || !cashboxTotal) return;
  cashboxStatus.textContent = state.cashbox.active ? "Aktif" : "Kapali";
  cashboxStatus.classList.toggle("active", Boolean(state.cashbox.active));
  cashboxTotal.textContent = money(state.cashbox.total || 0);
}

function storageKey(name) {
  const account = state.user && state.user.account ? state.user.account : "guest";
  return `dk:${account}:${name}`;
}

async function saveTotalAdjustment() {
  return api("/api/account-settings", {
    method: "POST",
    body: JSON.stringify({ section: activeSectionKey(), totalAdjustment: Number(state.totalAdjustment || 0) })
  });
}

async function applyTotalAdjustment(action) {
  if (!state.user?.canManageTotals) {
    totalAdjustMessage.textContent = "Sadece site yöneticisi değiştirebilir.";
    return;
  }
  const amount = parseMoney(totalAdjustInput?.value || "");
  if (!amount) {
    totalAdjustMessage.textContent = "Gecerli bir tutar yaz.";
    totalAdjustInput?.focus();
    return;
  }

  const receiptTotal = receiptsForActiveSection().reduce((sum, receipt) => sum + Number(receipt.amount || 0), 0);
  if (action === "add") {
    state.totalAdjustment = Number(state.totalAdjustment || 0) + amount;
  } else if (action === "subtract") {
    state.totalAdjustment = Number(state.totalAdjustment || 0) - amount;
  } else {
    state.totalAdjustment = amount - receiptTotal;
  }

  const nextAdjustment = state.totalAdjustment;
  totalAdjustMessage.textContent = "Toplam veritabanina kaydediliyor...";
  try {
    const payload = await saveTotalAdjustment();
    applyPayload(payload, "silent");
    totalAdjustInput.value = "";
    totalAdjustMessage.textContent = `Toplam ${money(receiptTotal + Number(nextAdjustment || 0))} olarak kalici kaydedildi.`;
  } catch (error) {
    totalAdjustMessage.textContent = error.message || "Toplam kaydedilemedi.";
    fetchReceipts("silent").catch(() => {});
  }
}
function parseMoney(value) {
  const text = String(value || "").replace(/[^0-9.,]/g, "");
  if (!text) return 0;
  const decimal = Math.max(text.lastIndexOf(","), text.lastIndexOf("."));
  const normalized = decimal >= 0 ? text.slice(0, decimal).replace(/[.,]/g, "") + "." + text.slice(decimal + 1) : text.replace(/[.,]/g, "");
  return Number(normalized) || 0;
}
function normalize(value) {
  return String(value || "").toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i");
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginMessage.textContent = "Giriş kontrol ediliyor...";
  try {
    const payload = await api("/api/login", { method: "POST", body: JSON.stringify({ username: usernameInput.value, password: passwordInput.value }) });
    if (payload.requiresPanelSelection) {
      loginMessage.textContent = "Lütfen girmek istediğiniz paneli seçin.";
      renderPanelChoice(payload.panels || []);
      return;
    }
    loginMessage.textContent = "";
    hidePanelChoice();
    enterApp(payload.user);
  } catch (error) {
    loginMessage.textContent = error.message;
  }
});

function renderPanelChoice(panels) {
  if (!panelChoice) return;
  state.pendingPanels = panels;
  panelChoice.classList.remove("hidden");
  panelChoice.innerHTML = `<strong>Hangi panele girmek istiyorsun?</strong>${panels.map((panel) => `<button type="button" data-panel-account="${escapeHtml(panel.account)}">${escapeHtml(panel.label)}</button>`).join("")}`;
}

function hidePanelChoice() {
  if (!panelChoice) return;
  state.pendingPanels = [];
  panelChoice.classList.add("hidden");
  panelChoice.innerHTML = "";
}

panelChoice?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-panel-account]");
  if (!button) return;
  loginMessage.textContent = "Yönetici paneli açılıyor...";
  try {
    const payload = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: usernameInput.value, password: passwordInput.value, account: button.dataset.panelAccount })
    });
    loginMessage.textContent = "";
    hidePanelChoice();
    enterApp(payload.user);
  } catch (error) {
    loginMessage.textContent = error.message;
  }
});

forgotPasswordButton?.addEventListener("click", () => {
  loginMessage.textContent = "WhatsApp grubunuzdan hangi hesabın şifresini unuttuğunuzu site yöneticisine bildirin.";
});

togglePassword.addEventListener("click", () => {
  passwordInput.type = passwordInput.type === "password" ? "text" : "password";
  togglePassword.classList.toggle("is-visible", passwordInput.type === "text");
  togglePassword.setAttribute("aria-label", passwordInput.type === "text" ? "Şifreyi gizle" : "Şifreyi göster");
});

logoutButton.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
  leaveApp();
});

refreshButton.addEventListener("click", async () => {
  refreshButton.classList.add("loading");
  showManualRefreshOverlay();
  scanStatus.textContent = "Detayli mail taramasi baslatildi";
  try { await api("/api/refresh", { method: "POST", body: "{}" }); } finally { setTimeout(() => refreshButton.classList.remove("loading"), 1200); }
});

function showManualRefreshOverlay() {
  if (!manualRefreshOverlay) return;
  manualRefreshOverlay.classList.remove("hidden");
  manualRefreshOverlay.classList.add("active");
  setTimeout(() => {
    manualRefreshOverlay.classList.remove("active");
    setTimeout(() => manualRefreshOverlay.classList.add("hidden"), 260);
  }, 1000);
}

searchInput.addEventListener("input", () => { state.search = searchInput.value; state.page = 1; renderReceipts(); });
pagination.addEventListener("click", (event) => {
  const button = event.target.closest("[data-page]");
  if (!button) return;
  state.page = Number(button.dataset.page || 1);
  renderReceipts();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

sectionSwitcher?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-section]");
  if (!button) return;
  state.activeSection = button.dataset.section;
  state.page = 1;
  state.lastReceiptRenderKey = "";
  localStorage.setItem(storageKey("section"), state.activeSection);
  applySettings(state.settings);
  renderAll({ receiptsChanged: true });
});

cashboxToggle.addEventListener("click", () => cashboxCard.classList.toggle("collapsed"));
cashboxStart.addEventListener("click", () => {
  const amount = parseMoney(cashboxInput.value);
  if (!amount) return;
  state.cashbox = { active: true, total: amount, applied: state.receipts.map((item) => item.id).filter(Boolean).slice(-2000) };
  saveCashbox(); renderCashbox(); cashboxInput.value = "";
});
cashboxReset.addEventListener("click", () => { state.cashbox = {}; saveCashbox(); renderCashbox(); });
cashboxManualAdd.addEventListener("click", () => {
  const amount = parseMoney(cashboxManualInput.value);
  if (!amount) {
    cashboxManualMessage.textContent = "Kasaya eklenecek gecerli bir tutar yaz.";
    cashboxManualInput.focus();
    return;
  }
  state.cashbox = {
    ...(state.cashbox || {}),
    active: true,
    total: Number(state.cashbox.total || 0) + amount,
    applied: Array.isArray(state.cashbox.applied) ? state.cashbox.applied : []
  };
  saveCashbox();
  renderCashbox();
  cashboxManualInput.value = "";
  cashboxManualMessage.textContent = `${money(amount)} manuel olarak kasaya eklendi.`;
});
cashboxManualInput.addEventListener("input", () => { cashboxManualMessage.textContent = ""; });
totalAddButton.addEventListener("click", () => applyTotalAdjustment("add"));
totalSubtractButton.addEventListener("click", () => applyTotalAdjustment("subtract"));
totalSetButton.addEventListener("click", () => applyTotalAdjustment("set"));
totalAdjustInput.addEventListener("input", () => { totalAdjustMessage.textContent = ""; });

setInterval(() => {
  clockText.textContent = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Europe/Istanbul" }).format(new Date());
}, 1000);

setInterval(() => {
  if (state.user) {
    lastScan.textContent = formatScanMinute(state.stats.lastScanAt);
  }
}, 60000);

checkSession().catch(() => {});
