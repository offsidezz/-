/* ── Constants ──────────────────────────────────────────────────────────────── */
const START_MESSAGE    = "FUNPAY_LISTS_START_V3";
const STOP_MESSAGE     = "FUNPAY_LISTS_STOP_V3";
const RESUME_MESSAGE   = "FUNPAY_LISTS_RESUME_V3";
const FILTER_ARBITRATION_MESSAGE = "FUNPAY_LISTS_FILTER_ARBITRATION_V1";

const STATE_KEY   = "funpayListsState";
const SETTINGS_KEY = "funpayListsSettings";
const MANUAL_KEY  = "funpayListsManual";
const HISTORY_KEY = "funpayListsHistory";
const CACHE_KEY   = "funpayListsOrderCache";

const PAGE_SIZE = 20; // orders per page

/* ── AI Constants ───────────────────────────────────────────────────────────── */
const AI_STORAGE_KEY  = "funpayListsAI";
const AI_EXAMPLES_KEY = "funpayListsAIExamples";
const AI_MAX_EXAMPLES = 20;
const AI_DEFAULT_RULES = `СПИСОК 1 — clean (✅ Проверенные):
Заказ выполнен, покупатель доволен, нет жалоб.
Признаки: "спасибо", "всё получил", "работает", "отлично", "всё ок", положительный отзыв, покупатель подтвердил получение, нет открытых вопросов, покупатель получил код/товар авто выдачей, получил код и тд тп.

СПИСОК 2 — dispute (⚠️ Спорные):
Заказ выполнен, но есть сомнения.
Признаки:
- покупатель не подтвердил получение товара
- покупатель не запросил код/данные от товара
- покупатель задал важный вопрос но не был в сети после ответа
- покупатель написал что-то негативное ("не работает", "не то", "верните", "обман") но арбитраж НЕ открыт
- покупатель долго молчит после выполнения
- есть вложение/скриншот с какой-то ошибкой входа или чего-то подобного
- неоднозначная ситуация, нужно внимание продавца

СПИСОК 3 — excluded (🚫 Арбитраж/Модератор):
Заказ НЕ включается ни в один список.
Признаки:
- в чате есть сообщения от сотрудника FunPay, модератора или арбитра
- слова "арбитраж открыт", "передано на рассмотрение", "модератор"
- сотрудник уже находится в чате
- открыт официальный спор через платформу

ВАЖНО:
- "не работает" без арбитража = dispute, не excluded
- вопрос без ответа от покупателя/продавца = dispute
- если есть фото — опиши что на нём и учти при решении
- язык чата: русский, английский или смешанный`;

/* ── Default Settings ───────────────────────────────────────────────────────── */
const DEFAULT_SETTINGS = {
delayMs: 1800,
adaptiveDelay: true,
pauseEvery: 25,
pauseMs: 15000,
blackWords: "",
whiteWords: "",
reminderDays: 3,
darkTheme: true,
customDisputePatterns: "",
customCleanPatterns: "",
};

/* ── State ──────────────────────────────────────────────────────────────────── */
let lastReport = null;
let manualDecisions = {};
let runHistory = [];
let settings = { ...DEFAULT_SETTINGS };

// Pagination state per list
const pages = { clean: 1, dispute: 1, excluded: 1 };

/* ── DOM Helpers ────────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

function getEl(id) {
return document.getElementById(id);
}

/* ── AI Settings Functions ──────────────────────────────────────────────────── */
async function loadAiSettings() {
const stored = await chrome.storage.local.get([AI_STORAGE_KEY]);
const ai = stored[AI_STORAGE_KEY] || { enabled: false, apiKey: "", rules: AI_DEFAULT_RULES, model: "moonshotai/kimi-k2.6" };
const enabledEl = getEl("aiEnabled");
const keyEl     = getEl("aiApiKey");
const rulesEl   = getEl("aiRules");
const modelEl   = getEl("aiModel");
if (enabledEl) enabledEl.checked  = ai.enabled;
if (keyEl)     keyEl.value        = ai.apiKey || "";
if (rulesEl)   rulesEl.value      = ai.rules  || AI_DEFAULT_RULES;
if (modelEl)   modelEl.value      = ai.model  || "moonshotai/kimi-k2.6";
}

async function saveAiSettings() {
const ai = {
enabled:  getEl("aiEnabled")?.checked          ?? false,
apiKey:   getEl("aiApiKey")?.value?.trim()      ?? "",
rules:    getEl("aiRules")?.value?.trim()       || AI_DEFAULT_RULES,
model:    getEl("aiModel")?.value?.trim()       || "moonshotai/kimi-k2.6",
};
await chrome.storage.local.set({ [AI_STORAGE_KEY]: ai });
}

async function saveAiExample(order, targetKey) {
const chatText = order.reason || order.ocrText || order.title || "";
if (!chatText && !order.game) return;

const listMap = { cleanOrders: "clean", disputeOrders: "dispute", excludedOrders: "excluded" };
const list = listMap[targetKey];
if (!list) return;

const stored  = await chrome.storage.local.get([AI_EXAMPLES_KEY]);
const examples = stored[AI_EXAMPLES_KEY] || [];

const orderKey = order.id || order.url;
const idx = examples.findIndex((ex) => ex.orderKey === orderKey);
if (idx !== -1) {
examples[idx] = { ...examples[idx], list, reason: order.reason || "" };
} else {
examples.push({
  orderKey,
  chatText:    [order.reason, order.ocrText, order.title, order.game].filter(Boolean).join(" | "),
  productText: order.game || "",
  list,
  reason:      order.reason || "",
  savedAt:     Date.now(),
});
}

const trimmed = examples.slice(-AI_MAX_EXAMPLES);
await chrome.storage.local.set({ [AI_EXAMPLES_KEY]: trimmed });
}

async function getAiExamplesCount() {
const stored = await chrome.storage.local.get([AI_EXAMPLES_KEY]);
return (stored[AI_EXAMPLES_KEY] || []).length;
}

/* ── Init ───────────────────────────────────────────────────────────────────── */
async function init() {
const stored = await chrome.storage.local.get([STATE_KEY, MANUAL_KEY, HISTORY_KEY, SETTINGS_KEY]);

manualDecisions = stored[MANUAL_KEY] || {};
runHistory      = stored[HISTORY_KEY] || [];
settings        = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };

applyTheme(settings.darkTheme !== false);
await ensureSettings();

if (stored[STATE_KEY]) {
applyState(stored[STATE_KEY]);
}

renderHistory(runHistory);
setupEventListeners();
setupTabs();
loadSettingsUI();
await loadAiSettings();

// Update AI examples count display
const count    = await getAiExamplesCount();
const countEl  = getEl("aiExamplesCount");
if (countEl) countEl.textContent = `Накоплено примеров: ${count}`;
}

async function ensureSettings() {
const merged = { ...DEFAULT_SETTINGS, ...settings };
await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
settings = merged;
}

/* ── Theme ──────────────────────────────────────────────────────────────────── */
function applyTheme(dark) {
document.body.classList.toggle("light", !dark);
const btn = getEl("themeToggle");
if (btn) btn.textContent = dark ? "☀️" : "🌙";
const cb = getEl("darkTheme");
if (cb) cb.checked = dark;
}

/* ── Tabs ───────────────────────────────────────────────────────────────────── */
function setupTabs() {
const tabs = document.querySelectorAll(".tab");
tabs.forEach(tab => {
tab.addEventListener("click", () => {
  tabs.forEach(t => t.classList.remove("active"));
  tab.classList.add("active");
  const target = tab.dataset.tab;
  document.querySelectorAll(".tab-content").forEach(c => {
    c.hidden = c.id !== `tab-${target}`;
  });
});
});
}

/* ── Settings UI ────────────────────────────────────────────────────────────── */
function loadSettingsUI() {
const fields = [
"reminderDays", "delayMs", "adaptiveDelay", "pauseEvery", "pauseMs",
"blackWords", "whiteWords", "darkTheme", "customDisputePatterns", "customCleanPatterns"
];
fields.forEach(key => {
const el = getEl(key);
if (!el) return;
if (el.type === "checkbox") {
  el.checked = settings[key] !== false && settings[key] !== 0;
} else {
  el.value = settings[key] ?? DEFAULT_SETTINGS[key] ?? "";
}
});
}

async function saveSettingsFromUI() {
const newSettings = {
reminderDays:          parseInt(getEl("reminderDays")?.value ?? "3", 10) || 0,
delayMs:               parseInt(getEl("delayMs")?.value ?? "1800", 10) || 1800,
adaptiveDelay:         getEl("adaptiveDelay")?.checked ?? true,
pauseEvery:            parseInt(getEl("pauseEvery")?.value ?? "25", 10) || 25,
pauseMs:               parseInt(getEl("pauseMs")?.value ?? "15000", 10) || 15000,
blackWords:            getEl("blackWords")?.value?.trim() ?? "",
whiteWords:            getEl("whiteWords")?.value?.trim() ?? "",
darkTheme:             getEl("darkTheme")?.checked ?? true,
customDisputePatterns: getEl("customDisputePatterns")?.value?.trim() ?? "",
customCleanPatterns:   getEl("customCleanPatterns")?.value?.trim() ?? "",
};

settings = newSettings;
await chrome.storage.local.set({ [SETTINGS_KEY]: newSettings });
await saveAiSettings();
applyTheme(newSettings.darkTheme);

const saved = getEl("settingsSaved");
if (saved) {
saved.textContent = "✓ Настройки сохранены";
setTimeout(() => { saved.textContent = ""; }, 2000);
}
}

/* ── Event Listeners ────────────────────────────────────────────────────────── */
function setupEventListeners() {
getEl("startCheck")?.addEventListener("click", async () => {
pages.clean = pages.dispute = pages.excluded = 1;
await chrome.storage.local.remove([STATE_KEY]);
await runCommand(START_MESSAGE, "Запускаю новую проверку...");
});

getEl("resumeCheck")?.addEventListener("click", () => runCommand(RESUME_MESSAGE, "Продолжаю проверку..."));
getEl("stopCheck")?.addEventListener("click",   () => runCommand(STOP_MESSAGE,   "Останавливаю..."));

getEl("copyLists")?.addEventListener("click", async () => {
if (!lastReport) return setStatus("Нет данных для копирования.");
const text    = buildCopyText(lastReport);
const warning = getCopyWarning(lastReport);
showPreview(text);
if (warning) setStatus(warning);
await copyText(text);
});

getEl("openDisputes")?.addEventListener("click", async () => {
if (!lastReport?.excludedOrders?.length) return setStatus("Нет арбитражных заказов.");
const orders = lastReport.excludedOrders.filter(o => o.url);
for (const o of orders.slice(0, 10)) {
  chrome.tabs.create({ url: o.url, active: false });
}
});

getEl("clearMemory")?.addEventListener("click", async () => {
await chrome.storage.local.remove([CACHE_KEY, MANUAL_KEY]);
manualDecisions = {};
setStatus("Память очищена.");
});

getEl("themeToggle")?.addEventListener("click", async () => {
const isDark = !document.body.classList.contains("light");
applyTheme(!isDark);
settings.darkTheme = !isDark;
await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
});

getEl("saveSettings")?.addEventListener("click", saveSettingsFromUI);

getEl("clearAiExamples")?.addEventListener("click", async () => {
await chrome.storage.local.remove(AI_EXAMPLES_KEY);
const countEl = getEl("aiExamplesCount");
if (countEl) countEl.textContent = "Накоплено примеров: 0";
const saved = getEl("settingsSaved");
if (saved) {
  saved.textContent = "✓ Примеры очищены";
  setTimeout(() => { saved.textContent = ""; }, 2000);
}
});

// Filter listeners
["searchFilter", "gameFilter", "minPrice", "onlyAttachments", "onlyRental", "sortMode"].forEach(id => {
getEl(id)?.addEventListener("input",  () => { pages.clean = pages.dispute = pages.excluded = 1; refreshView(); });
getEl(id)?.addEventListener("change", () => { pages.clean = pages.dispute = pages.excluded = 1; refreshView(); });
});

getEl("compactMode")?.addEventListener("change", refreshView);

// Storage changes
chrome.storage.onChanged.addListener((changes, area) => {
if (area !== "local") return;
if (changes[STATE_KEY])   applyState(changes[STATE_KEY].newValue);
if (changes[MANUAL_KEY])  { manualDecisions = changes[MANUAL_KEY].newValue || {}; refreshView(); }
if (changes[HISTORY_KEY]) { runHistory = changes[HISTORY_KEY].newValue || []; renderHistory(runHistory); }
});
}

/* ── Commands ───────────────────────────────────────────────────────────────── */
async function runCommand(type, statusText) {
setStatus(statusText);
updateButtons("running");

try {
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
if (!tab?.id) return setStatus("Нет активной вкладки.");
if (!tab.url?.startsWith("https://funpay.com/")) return setStatus("Откройте страницу FunPay.");
await sendTabMessage(tab.id, type, { settings });
} catch (e) {
setStatus("Ошибка: " + e.message, true);
updateButtons("idle");
}
}

async function sendTabMessage(tabId, type, payload = {}) {
try {
  await chrome.tabs.sendMessage(tabId, { type, ...payload });
} catch (_e) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await new Promise(r => setTimeout(r, 200));
    await chrome.tabs.sendMessage(tabId, { type, ...payload });
  } catch (err) {
    throw new Error("Не удалось подключиться к странице FunPay. Обнови вкладку (F5) и попробуй снова. (" + err.message + ")");
  }
}
}

/* ── State ──────────────────────────────────────────────────────────────────── */
function applyState(state) {
if (!state) return;
lastReport = state;
updateProgress(state);
updateButtons(state.status);
setStatus(getStatusText(state));
if (state.cleanOrders || state.disputeOrders || state.excludedOrders) {
getEl("results").hidden = false;
render(state);
}
if (state.status === "done" || state.status === "stopped") {
const text = buildCopyText(state);
showPreview(text);
}
}

function refreshView() {
document.body.classList.toggle("compact", getEl("compactMode")?.checked);
if (lastReport) render(lastReport);
}

function updateProgress(state) {
const block = getEl("progressBlock");
const fill  = getEl("progressFill");
const text  = getEl("progressText");
if (!block) return;

if (state.status === "running" || state.status === "collecting") {
block.hidden = false;
const total   = state.candidateCount || 0;
const checked = state.checkedChats   || 0;
const pct     = total > 0 ? Math.round((checked / total) * 100) : 0;
if (fill) fill.style.width = pct + "%";
if (text) text.textContent = total > 0
  ? `Проверено ${checked} из ${total} (${pct}%)`
  : "Собираю заказы...";
} else {
block.hidden = true;
}
}

function updateButtons(status) {
const running = status === "running" || status === "collecting";
const el = (id) => getEl(id);
if (el("startCheck"))  el("startCheck").disabled  = running;
if (el("resumeCheck")) el("resumeCheck").disabled = running;
if (el("stopCheck"))   el("stopCheck").disabled   = !running;
}

function getStatusText(state) {
if (!state) return "";
switch (state.status) {
case "collecting": return "Собираю список заказов...";
case "running":    return `Анализирую чаты... (${state.checkedChats || 0}/${state.candidateCount || 0})`;
case "done":       return `Готово. Проверено ${state.checkedChats || 0} заказов.`;
case "stopped":    return "Остановлено.";
case "error":      return "Ошибка: " + (state.errorMessage || "неизвестная");
default:           return state.status || "";
}
}

/* ── Render ─────────────────────────────────────────────────────────────────── */
function render(data) {
const clean    = getVisibleOrders(data.cleanOrders    || []);
const dispute  = getVisibleOrders(data.disputeOrders  || []);
const excluded = getVisibleOrders(data.excludedOrders || []);

if (getEl("cleanCount"))    getEl("cleanCount").textContent    = clean.length;
if (getEl("disputeCount"))  getEl("disputeCount").textContent  = dispute.length;
if (getEl("excludedCount")) getEl("excludedCount").textContent = excluded.length;

renderList("cleanOrdersBlock",  "cleanOrdersList",  clean,    "cleanOrders",    data.currency);
renderList("disputeBlock",      "disputeList",      dispute,  "disputeOrders",  data.currency);
renderList("excludedBlock",     "excludedList",     excluded, "excludedOrders", data.currency);

if (data.log?.length) renderLog(data.log);
}

function renderList(blockId, listId, rows, listKey, currency) {
const block = getEl(blockId);
const list  = getEl(listId);
if (!block || !list) return;

block.hidden = rows.length === 0;
if (rows.length === 0) return;

// Pagination key
const pageKey = listKey === "cleanOrders" ? "clean"
: listKey === "disputeOrders" ? "dispute" : "excluded";

const totalPages  = Math.ceil(rows.length / PAGE_SIZE);
if (pages[pageKey] > totalPages) pages[pageKey] = totalPages;
const currentPage = pages[pageKey] || 1;
const start       = (currentPage - 1) * PAGE_SIZE;
const pageRows    = rows.slice(start, start + PAGE_SIZE);

// Render pagination
const paginationId = pageKey + "Pagination";
const paginationEl = getEl(paginationId);
if (paginationEl) {
paginationEl.innerHTML = "";
if (totalPages > 1) {
  const info = document.createElement("span");
  info.className   = "page-info";
  info.textContent = `${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} из ${rows.length}`;
  paginationEl.appendChild(info);

  for (let p = 1; p <= totalPages; p++) {
    const btn = document.createElement("button");
    btn.className   = "page-btn" + (p === currentPage ? " active" : "");
    btn.textContent = p;
    btn.addEventListener("click", () => { pages[pageKey] = p; render(lastReport); });
    paginationEl.appendChild(btn);
  }
}
}

// Render rows
list.innerHTML = "";
pageRows.forEach(order => {
const li = document.createElement("li");
li.className = "order-row";

const textDiv = document.createElement("div");
textDiv.className = "order-row-text";
textDiv.innerHTML = formatOrderLine(order, currency);

const actions = document.createElement("div");
actions.className = "row-actions";

[
  { label: "?",  title: "Показать причину",      fn: () => toggleReason(li, order) },
  { label: "OK", title: "Переместить в Можно",   fn: () => moveOrder(order, "cleanOrders") },
  { label: "SP", title: "Переместить в Спорные", fn: () => moveOrder(order, "disputeOrders") },
  { label: "AR", title: "Переместить в Арбитраж",fn: () => moveOrder(order, "excludedOrders") },
  { label: "×",  title: "Убрать из списка",      fn: () => moveOrder(order, "removed") },
].forEach(({ label, title, fn }) => {
  const btn = document.createElement("button");
  btn.className   = "row-action";
  btn.textContent = label;
  btn.title       = title;
  btn.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
  actions.appendChild(btn);
});

li.addEventListener("click", () => { if (order.url) chrome.tabs.create({ url: order.url }); });
li.appendChild(textDiv);
li.appendChild(actions);
list.appendChild(li);
});
}

function renderHistory(history) {
const block = getEl("historyBlock");
const list  = getEl("historyList");
if (!block || !list) return;

const recent = (history || []).slice(-5).reverse();
block.hidden = recent.length === 0;
list.innerHTML = "";

recent.forEach(entry => {
const li = document.createElement("li");
li.textContent = `${formatDate(entry.date)} — ✅${entry.clean} ⚠️${entry.dispute} 🚫${entry.excluded}`;
list.appendChild(li);
});
}

function renderLog(log) {
// Log is shown in status for now; can be extended
}

/* ── Filters & Sort ─────────────────────────────────────────────────────────── */
function getVisibleOrders(orders) {
const search   = normalizeFilter(getEl("searchFilter")?.value || "");
const game     = normalizeFilter(getEl("gameFilter")?.value   || "");
const minP     = parseFloat(getEl("minPrice")?.value || "0") || 0;
const onlyAtt  = getEl("onlyAttachments")?.checked;
const onlyRen  = getEl("onlyRental")?.checked;
const sortMode = getEl("sortMode")?.value || "amount";

let result = orders.filter(o => {
if (onlyAtt && !o.hasAttachment) return false;
if (onlyRen && !o.isRental)      return false;
if (minP > 0 && (o.amount || 0) < minP) return false;
if (game) {
  const g = normalizeFilter(getOrderGame(o));
  if (!g.includes(game)) return false;
}
if (search) {
  const haystack = [o.id, o.title, o.game, o.subtitle, o.buyer, getOrderGame(o)]
    .filter(Boolean).map(s => s.toLowerCase()).join(" ");
  if (!haystack.includes(search)) return false;
}
return true;
});

// Sort
if (sortMode === "amount") {
result.sort((a, b) => (b.amount || 0) - (a.amount || 0) || (getOrderGame(a) || "").localeCompare(getOrderGame(b) || ""));
} else if (sortMode === "date") {
result.sort((a, b) => {
  const da = a.dateIso ? new Date(a.dateIso).getTime() : 0;
  const db = b.dateIso ? new Date(b.dateIso).getTime() : 0;
  return db - da;
});
} else if (sortMode === "date_asc") {
result.sort((a, b) => {
  const da = a.dateIso ? new Date(a.dateIso).getTime() : 0;
  const db = b.dateIso ? new Date(b.dateIso).getTime() : 0;
  return da - db;
});
}

return result;
}

function normalizeFilter(v) {
return (v || "").trim().toLowerCase();
}

/* ── Order Moving ───────────────────────────────────────────────────────────── */
async function moveOrder(order, targetKey) {
if (!lastReport) return;

["cleanOrders", "disputeOrders", "excludedOrders"].forEach(key => {
lastReport[key] = removeFrom(lastReport[key] || [], order);
});

if (targetKey !== "removed") {
lastReport[targetKey] = lastReport[targetKey] || [];
lastReport[targetKey].push(order);
}

manualDecisions[getOrderKey(order)] = targetKey;
await chrome.storage.local.set({
[STATE_KEY]:  lastReport,
[MANUAL_KEY]: manualDecisions,
});

// Save as AI training example
await saveAiExample(order, targetKey);

pages.clean = pages.dispute = pages.excluded = 1;
render(lastReport);
}

function removeFrom(orders, order) {
return (orders || []).filter(o => !isSameOrder(o, order));
}

function isSameOrder(a, b) {
if (a.id && b.id) return a.id === b.id;
return a.url === b.url;
}

/* ── Copy & Preview ─────────────────────────────────────────────────────────── */
function buildCopyText(data) {
const cur   = data.currency || "₽";
const lines = (orders) => getVisibleOrders(orders).map(o => formatOrderLine(o, cur, true)).join("
");

const parts = [];
if (data.cleanOrders?.length)    parts.push("✅ МОЖНО:
"    + lines(data.cleanOrders));
if (data.disputeOrders?.length)  parts.push("⚠️ СПОРНЫЕ:
"  + lines(data.disputeOrders));
if (data.excludedOrders?.length) parts.push("🚫 АРБИТРАЖ:
" + lines(data.excludedOrders));
return parts.join("

");
}

function showPreview(text) {
const block = getEl("previewBlock");
const pre   = getEl("copyPreview");
if (!block || !pre) return;
block.hidden = !text;
pre.textContent = text;
}

function getCopyWarning(data) {
const risky = (data.cleanOrders || []).filter(o => o.isManual || o.hasWarning);
if (risky.length) return `⚠️ ${risky.length} заказов в «Можно» помечены вручную или имеют предупреждения.`;
return "";
}

async function copyText(text) {
try {
await navigator.clipboard.writeText(text);
setStatus("Скопировано в буфер обмена.");
} catch (_e) {
const ta = document.createElement("textarea");
ta.value = text;
document.body.appendChild(ta);
ta.select();
document.execCommand("copy");
ta.remove();
setStatus("Скопировано.");
}
}

/* ── Formatting ─────────────────────────────────────────────────────────────── */
function formatOrderLine(order, currency, plain = false) {
const id     = order.id     ? `#${order.id}` : "";
const amount = order.amount != null ? formatMoney(order.amount, currency || "₽") : "";
const game   = getOrderGame(order) || "";
const date   = order.dateIso ? ` · ${formatDate(order.dateIso)}` : "";
const buyer  = order.buyer   ? ` · ${order.buyer}` : "";

if (plain) {
const base = [id, amount, game, date.trim(), buyer.trim()].filter(Boolean).join(" | ");

const extraParts = [];
if (order.daysSinceArbitration !== "" && order.daysSinceArbitration != null) {
  extraParts.push(`арбитраж ${order.daysSinceArbitration} дн. назад`);
}
if (order.lastStaffText) {
  const snippet = order.lastStaffText.slice(0, 200);
  extraParts.push(`последнее сообщение: «${snippet}»`);
}

return extraParts.length ? `${base}
  ↳ ${extraParts.join(" | ")}` : base;
}

const parts = [id, amount, game].filter(Boolean).join(" | ");
const meta  = [date, buyer].filter(s => s.trim()).join("");
return `<strong>${parts}</strong>${meta ? `<br><small class="reason">${meta.trim()}</small>` : ""}`;
}

function formatMoney(value, currency) {
const n = parseFloat(value);
if (isNaN(n)) return String(value);
return n.toLocaleString("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + " " + (currency || "₽");
}

function formatDate(value) {
if (!value) return "";
const d = new Date(value);
if (isNaN(d.getTime())) return value;
return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function getOrderGame(order) {
return order.game || order.subtitle || order.title || "";
}

function getOrderKey(order) {
return order.id || order.url || "";
}

/* ── Danger Reason Toggle ───────────────────────────────────────────────────── */
function toggleReason(rowNode, order) {
const existing = rowNode.querySelector(".danger-reason");
if (existing) { existing.remove(); return; }

const reason = buildDangerReason(order);
if (!reason) return;

const div = document.createElement("div");
div.className   = "danger-reason";
div.textContent = reason;
rowNode.appendChild(div);
}

function buildDangerReason(order) {
const parts = [];
if (order.hasAttachment)  parts.push("📎 Есть вложение");
if (order.ocrText)        parts.push("🔤 OCR: " + order.ocrText.slice(0, 120));
if (order.lastBuyerMsg)   parts.push("💬 Последнее: " + order.lastBuyerMsg.slice(0, 120));
if (order.isManual)       parts.push("✏️ Перемещён вручную");
if (order.isCached)       parts.push("💾 Из кэша");
if (order.hasWarning)     parts.push("⚠️ " + (order.warningText || "Предупреждение"));
if (order.matchedPattern) parts.push("🔍 Паттерн: " + order.matchedPattern);

if (order.daysSinceArbitration !== "" && order.daysSinceArbitration != null) {
parts.push(`⚖️ Арбитраж вступил ${order.daysSinceArbitration} дн. назад`);
}
if (order.lastStaffText) {
parts.push("📋 Последнее сообщение арбитража:
" + order.lastStaffText.slice(0, 300));
}

return parts.join("
");
}

/* ── Status ─────────────────────────────────────────────────────────────────── */
function setStatus(text, isError = false) {
const el = getEl("status");
if (!el) return;
el.textContent = text;
el.className   = "status" + (isError ? " error" : "");
}

/* ── Boot ───────────────────────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", init);
