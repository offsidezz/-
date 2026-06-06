// ── AI Classifier (Single + Batch) ───────────────────────────────────────────
const AI_STORAGE_KEY = "funpayListsAI";
const AI_EXAMPLES_KEY = "funpayListsAIExamples";
const AI_MAX_EXAMPLES = 20;

const AI_SYSTEM_PROMPT_SINGLE = `Ты — ассистент для проверки заказов на платформе FunPay.
Отвечай ТОЛЬКО в формате JSON, без лишнего текста:
{
"list": "clean" | "dispute" | "excluded",
"confidence": 0.0-1.0,
"reason": "объяснение на русском, 1-2 предложения"
}`;

const AI_SYSTEM_PROMPT_BATCH = `Ты — ассистент для проверки заказов на платформе FunPay.
Проанализируй несколько заказов и верни ТОЛЬКО JSON массив.
Формат каждого элемента:
{
"index": number,
"list": "clean" | "dispute" | "excluded",
"confidence": 0.0-1.0,
"reason": "объяснение на русском, 1-2 предложения"
}
Верни ТОЛЬКО массив, без лишнего текста.`;

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

async function getAiSettings() {
const stored = await chrome.storage.local.get([AI_STORAGE_KEY]);
return stored[AI_STORAGE_KEY] || { enabled: false, apiKey: "", rules: AI_DEFAULT_RULES, model: "moonshotai/kimi-k2.6" };
}

async function getAiExamples() {
const stored = await chrome.storage.local.get([AI_EXAMPLES_KEY]);
return stored[AI_EXAMPLES_KEY] || [];
}

async function imageUrlToBase64(url) {
try {
const response = await fetch(url, { mode: "cors" });
if (!response.ok) return null;
const blob = await response.blob();
return new Promise((resolve) => {
  const reader = new FileReader();
  reader.onloadend = () => resolve(reader.result);
  reader.onerror = () => resolve(null);
  reader.readAsDataURL(blob);
});
} catch {
return null;
}
}

async function callAiClassifier(chatData, aiSettings) {
const { apiKey, rules, model } = aiSettings;
if (!apiKey) return null;

const examples = await getAiExamples();
let examplesSection = "";
if (examples.length > 0) {
const recent = examples.slice(-AI_MAX_EXAMPLES);
examplesSection = "

ТВОИ РЕШЕНИЯ (обучающие примеры — учитывай их при классификации):
";
examplesSection += recent.map((ex) =>
  `Чат: "${ex.chatText.slice(0, 200)}"
Товар: "${(ex.productText || "").slice(0, 100)}"
→ ${JSON.stringify({ list: ex.list, reason: ex.reason })}`
).join("

");
}

const userPrompt = buildAiUserPrompt(chatData);
const contentParts = [{ type: "text", text: `${rules}${examplesSection}

---

${userPrompt}` }];

if (chatData.imageUrls && chatData.imageUrls.length > 0) {
const imageLimit = chatData.imageUrls.slice(0, 3);
for (const url of imageLimit) {
  const b64 = await imageUrlToBase64(url);
  if (b64) contentParts.push({ type: "image_url", image_url: { url: b64, detail: "low" } });
}
}

try {
const response = await fetchWithRetry("https://integrate.api.nvidia.com/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
  body: JSON.stringify({
    model: model || "moonshotai/kimi-k2.6",
    messages: [
      { role: "system", content: AI_SYSTEM_PROMPT_SINGLE },
      { role: "user", content: contentParts }
    ],
    temperature: 0.1,
    max_tokens: 256
  })
});

const data = await response.json();
const text = data.choices?.[0]?.message?.content || "";
const jsonMatch = text.match(/\{[\s\S]*\}/);
if (!jsonMatch) return null;

const parsed = JSON.parse(jsonMatch[0]);
if (!["clean", "dispute", "excluded"].includes(parsed.list)) return null;

return { list: parsed.list, confidence: parsed.confidence || 0.8, reason: parsed.reason || "" };
} catch (err) {
console.warn("[FunPay AI] Error:", err);
return null;
}
}

async function callAiClassifierBatch(batchItems, aiSettings) {
const { apiKey, rules, model } = aiSettings;
if (!apiKey || batchItems.length === 0) return null;

const examples = await getAiExamples();
let examplesSection = "";
if (examples.length > 0) {
const recent = examples.slice(-AI_MAX_EXAMPLES);
examplesSection = "

ТВОИ РЕШЕНИЯ (учитывай при классификации):
";
examplesSection += recent.map((ex) =>
  `→ ${JSON.stringify({ list: ex.list, reason: ex.reason })}`
).join("
");
}

const batchPrompt = buildAiBatchPrompt(batchItems, rules, examplesSection);

try {
const response = await fetchWithRetry("https://integrate.api.nvidia.com/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
  body: JSON.stringify({
    model: model || "moonshotai/kimi-k2.6",
    messages: [
      { role: "system", content: AI_SYSTEM_PROMPT_BATCH },
      { role: "user", content: batchPrompt }
    ],
    temperature: 0.1,
    max_tokens: 512 + batchItems.length * 64
  })
});

const data = await response.json();
const text = data.choices?.[0]?.message?.content || "";
const jsonMatch = text.match(/\[[\s\S]*\]/);
if (!jsonMatch) return null;

const parsed = JSON.parse(jsonMatch[0]);
if (!Array.isArray(parsed)) return null;

return parsed.filter(p => p && typeof p.index === "number" && ["clean", "dispute", "excluded"].includes(p.list))
  .map(p => ({ index: p.index, list: p.list, confidence: p.confidence || 0.8, reason: p.reason || "" }));
} catch (err) {
console.warn("[FunPay AI Batch] Error:", err);
return null;
}
}

function buildAiUserPrompt(chatData) {
const lines = [];
lines.push("Проанализируй этот заказ и определи список:");
lines.push("");
if (chatData.productText) {
lines.push(`📦 ТОВАР:
${chatData.productText.slice(0, 300)}`);
lines.push("");
}
if (chatData.messages && chatData.messages.length > 0) {
lines.push("💬 ЧАТ:");
const recent = chatData.messages.slice(-20);
for (const msg of recent) {
  const role = msg.role === "buyer" ? "Покупатель" : msg.role === "seller" ? "Продавец" : "Система";
  const attachment = msg.hasAttachment ? " [📎]" : "";
  if (msg.text || msg.hasAttachment) {
    lines.push(`[${role}]${attachment}: ${(msg.text || "").slice(0, 150)}`);
  }
}
lines.push("");
}
if (chatData.ocrText) {
lines.push(`🔍 OCR:
${chatData.ocrText.slice(0, 300)}`);
lines.push("");
}
if (chatData.imageUrls && chatData.imageUrls.length > 0) {
lines.push(`🖼️ Фото: ${chatData.imageUrls.length} шт.`);
}
return lines.join("
");
}

// ── FIX 8: Reduced batch prompt size ─────────────────────────────────────────
function buildAiBatchPrompt(batchItems, rules, examplesSection) {
const lines = [];
lines.push(`${rules}${examplesSection}`);
lines.push("");
lines.push("Проанализируй каждый заказ и верни JSON массив:");
lines.push("");
batchItems.forEach((item, idx) => {
const cd = item.chatData;
lines.push(`--- ЗАКАЗ [${idx}] ID=${item.orderId} ---`);
if (cd.productText) lines.push(`Товар: ${cd.productText.slice(0, 150)}`);
if (cd.chatText) lines.push(`Чат: ${cd.chatText.slice(0, 150)}`); // reduced from 250 to 150
if (cd.imageUrls?.length) lines.push(`Фото: ${cd.imageUrls.length} шт.`);
lines.push("");
});
lines.push("ВЕРНИ ТОЛЬКО: [{\"index\":0,\"list\":\"clean\",\"confidence\":0.9,\"reason\":\"...\"},...]");
return lines.join("
");
}

// ── FIX 3: Fetch with retry (429 + 5xx) ──────────────────────────────────────
async function fetchWithRetry(url, options, retries = 3) {
for (let i = 0; i < retries; i++) {
try {
  const resp = await fetch(url, options);
  if (resp.status === 429) {
    const delay = Math.pow(2, i) * 2000 + Math.random() * 1000;
    console.warn(`[FunPay] 429 received, retrying in ${(delay/1000).toFixed(1)}s...`);
    await new Promise(r => setTimeout(r, delay));
    continue;
  }
  if (resp.status >= 500) {
    const delay = Math.pow(2, i) * 2000 + Math.random() * 1000;
    console.warn(`[FunPay] HTTP ${resp.status} received, retrying in ${(delay/1000).toFixed(1)}s...`);
    await new Promise(r => setTimeout(r, delay));
    continue;
  }
  if (!resp.ok) return resp; // 4xx other than 429 — return as-is, don't throw
  return resp;
} catch (err) {
  // Network error, timeout, etc. — retry with backoff
  if (i < retries - 1) {
    const delay = Math.pow(2, i) * 2000 + Math.random() * 1000;
    console.warn(`[FunPay] Network error, retrying in ${(delay/1000).toFixed(1)}s:`, err.message);
    await new Promise(r => setTimeout(r, delay));
    continue;
  }
  throw err;
}
}
throw new Error("Max retries exceeded");
}

// ── State ─────────────────────────────────────────────────────────────────────
let isRunning = false;
let shouldStop = false;
let currentSettings = {};

// ── Message name compatibility ────────────────────────────────────────────────
const MSG_START = ["START_CHECK", "FUNPAY_LISTS_START_V3"];
const MSG_RESUME = ["RESUME_CHECK", "FUNPAY_LISTS_RESUME_V3"];
const MSG_STOP = ["STOP_CHECK", "FUNPAY_LISTS_STOP_V3"];
const MSG_PING = ["PING", "FUNPAY_LISTS_PING_V3"];

function isStart(type) { return MSG_START.includes(type); }
function isResume(type) { return MSG_RESUME.includes(type); }
function isStop(type) { return MSG_STOP.includes(type); }
function isPing(type) { return MSG_PING.includes(type); }

// ── Dispute / Clean patterns ──────────────────────────────────────────────────
const DEFAULT_DISPUTE_PATTERNS = [
/арбитраж/i, /модератор/i, /сотрудник funpay/i, /передано на рассмотрение/i,
/открыт спор/i, /открыт арбитраж/i, /жалоба принята/i
];

const DEFAULT_CLEAN_PATTERNS = [
/спасибо/i, /всё получил/i, /все получил/i, /получил/i, /работает/i,
/отлично/i, /всё ок/i, /все ок/i, /ок/i, /ok/i, /хорошо/i,
/благодарю/i, /супер/i, /класс/i, /👍/
];

const DEFAULT_SOFT_DISPUTE_PATTERNS = [
/не работает/i, /не то/i, /верни/i, /обман/i, /мошенник/i,
/не получил/i, /где товар/i, /не пришло/i, /ошибка/i, /не могу войти/i,
/не входит/i, /неверный/i, /неправильный/i
];

function buildPatterns(customRaw, defaults) {
const patterns = [...defaults];
if (customRaw) {
customRaw.split("
").map(s => s.trim()).filter(Boolean).forEach(p => {
  try { patterns.push(new RegExp(p, "i")); } catch {}
});
}
return patterns;
}

function matchesAny(text, patterns) {
return patterns.some(p => p.test(text));
}

// ── FunPay API helpers ────────────────────────────────────────────────────────
async function fetchOrdersPage(page = 1) {
const url = `https://funpay.com/orders/trade?page=${page}&status=paid`;
const resp = await fetchWithRetry(url, { credentials: "include" }, 2);
const html = await resp.text();
return new DOMParser().parseFromString(html, "text/html");
}

function parseOrdersFromDoc(doc) {
const rows = doc.querySelectorAll("table.table tbody tr");
const orders = [];
rows.forEach(row => {
const cells = row.querySelectorAll("td");
if (cells.length < 4) return;
const linkEl = row.querySelector("a[href*='/orders/']");
if (!linkEl) return;
const href = linkEl.getAttribute("href") || "";
const idMatch = href.match(/\/orders\/([^/?#]+)/);
if (!idMatch) return;
const orderId = idMatch[1];
const title = (row.querySelector(".tc-title") || cells[1])?.textContent?.trim() || "";
const buyer = (row.querySelector(".tc-buyer") || cells[2])?.textContent?.trim() || "";
const amountEl = row.querySelector(".tc-price") || cells[3];
const amountText = amountEl?.textContent?.trim() || "0";
const amount = parseFloat(amountText.replace(/[^\d.,]/g, "").replace(",", ".")) || 0;
const game = (row.querySelector(".tc-game") || cells[0])?.textContent?.trim() || "";
const dateEl = row.querySelector(".tc-date-time") || row.querySelector("td:last-child");
const date = dateEl?.textContent?.trim() || "";
orders.push({ orderId, title, buyer, amount, game, date, url: `https://funpay.com${href}` });
});
return orders;
}

function getTotalPages(doc) {
const paginationLinks = doc.querySelectorAll(".pagination a");
let max = 1;
paginationLinks.forEach(a => {
const n = parseInt(a.textContent.trim());
if (!isNaN(n) && n > max) max = n;
});
return max;
}

async function fetchChatForOrder(orderId) {
const url = `https://funpay.com/orders/${orderId}/`;
const resp = await fetchWithRetry(url, { credentials: "include" }, 2);
const html = await resp.text();
const doc = new DOMParser().parseFromString(html, "text/html");
return parseChat(doc, orderId);
}

function parseChat(doc, orderId) {
const messages = [];
const imageUrls = [];
let hasAttachment = false;
let hasModeratorMessage = false;
let productText = "";

const descEl = doc.querySelector(".order-desc, .lot-description, [class*='description']");
if (descEl) productText = descEl.textContent.trim().slice(0, 500);

const chatContainer = doc.querySelector(".chat-messages, .messages-list, [class*='chat']");
const allMsgEls = chatContainer
? chatContainer.querySelectorAll("[class*='message'], [class*='msg-']")
: doc.querySelectorAll("[class*='message-item'], [class*='chat-message']");

allMsgEls.forEach(el => {
const classList = el.className || "";
const text = el.textContent.trim();
let role = "system";
if (classList.includes("buyer") || classList.includes("incoming")) role = "buyer";
else if (classList.includes("seller") || classList.includes("outgoing") || classList.includes("my-")) role = "seller";

const isModerator = classList.includes("moderator") || classList.includes("arbiter") ||
  classList.includes("support") || /модератор|арбитр|сотрудник/i.test(text);
if (isModerator) hasModeratorMessage = true;

const imgs = el.querySelectorAll("img[src]");
imgs.forEach(img => {
  const src = img.getAttribute("src");
  if (src && !src.includes("avatar") && !src.includes("icon")) {
    imageUrls.push(src.startsWith("http") ? src : `https://funpay.com${src}`);
    hasAttachment = true;
  }
});

const attachLinks = el.querySelectorAll("a[href*='upload'], a[download], .attachment");
if (attachLinks.length > 0) hasAttachment = true;

if (text) {
  messages.push({ role, text: text.slice(0, 500), hasAttachment: imgs.length > 0 || attachLinks.length > 0 });
}
});

const pageText = doc.body?.textContent || "";
if (/арбитраж открыт|передано на рассмотрение|модератор подключился|сотрудник funpay/i.test(pageText)) {
hasModeratorMessage = true;
}

const chatText = messages.map(m => m.text).join(" ");
return { messages, imageUrls, hasAttachment, hasModeratorMessage, productText, chatText, orderId };
}

// ── FIX 5: OCR cache with size limit ──────────────────────────────────────────
const OCR_CACHE_MAX = 200;
const ocrCache = new Map();

function getOcrCached(key) { return ocrCache.get(key); }
function setOcrCached(key, value) {
if (ocrCache.size >= OCR_CACHE_MAX) {
const firstKey = ocrCache.keys().next().value;
if (firstKey !== undefined) ocrCache.delete(firstKey);
}
ocrCache.set(key, value);
}

// ── Classification (rule-based) ───────────────────────────────────────────────
function classifyByRules(chatData, settings) {
const { hasModeratorMessage, chatText, hasAttachment } = chatData;
const disputePatterns = buildPatterns(settings.customDisputePatterns, DEFAULT_DISPUTE_PATTERNS);
const cleanPatterns = buildPatterns(settings.customCleanPatterns, DEFAULT_CLEAN_PATTERNS);
const softDisputePatterns = buildPatterns(null, DEFAULT_SOFT_DISPUTE_PATTERNS);
const blackWords = (settings.blackWords || "").split(",").map(s => s.trim()).filter(Boolean);
const whiteWords = (settings.whiteWords || "").split(",").map(s => s.trim()).filter(Boolean);

if (hasModeratorMessage || matchesAny(chatText, disputePatterns)) {
return { list: "excluded", reason: "Арбитраж или модератор обнаружен", byAI: false };
}
if (blackWords.some(w => chatText.toLowerCase().includes(w.toLowerCase()))) {
return { list: "dispute", reason: "Найдено слово из чёрного списка", byAI: false };
}
if (matchesAny(chatText, softDisputePatterns)) {
return { list: "dispute", reason: "Обнаружены признаки проблемы", byAI: false };
}
if (hasAttachment && !matchesAny(chatText, cleanPatterns)) {
return { list: "dispute", reason: "Есть вложение, подтверждение не найдено", byAI: false };
}
if (whiteWords.some(w => chatText.toLowerCase().includes(w.toLowerCase()))) {
return { list: "clean", reason: "Найдено слово из белого списка", byAI: false };
}
if (matchesAny(chatText, cleanPatterns)) {
return { list: "clean", reason: "Покупатель подтвердил получение", byAI: false };
}
return { list: "dispute", reason: "Покупатель не подтвердил получение", byAI: false };
}

// ── FIX 7: Throttled progress sender ──────────────────────────────────────────
const STATE_KEY = "funpayListsState";
const MSG_QUEUE = [];
let msgTimer = null;
let lastStorageWrite = 0;
const STORAGE_THROTTLE_MS = 300;

function sendProgress(msg) {
MSG_QUEUE.push(msg);
if (msgTimer) return;

msgTimer = setTimeout(async () => {
msgTimer = null;
const batch = MSG_QUEUE.splice(0, MSG_QUEUE.length);

// Send runtime messages immediately (popup listens on storage.onChanged too)
for (const m of batch) {
  try { chrome.runtime.sendMessage({ ...m, source: "content" }); } catch {}
}

// ── FIX 1: Write to storage so popup.js sees progress ──────────────────────
// Throttle storage writes to avoid overwhelming the API
const now = Date.now();
if (now - lastStorageWrite >= STORAGE_THROTTLE_MS) {
  lastStorageWrite = now;
  // Extract the latest progress state from the batch
  const latestProgress = batch.find(m => m.type === "progress");
  const latestStatus = batch.find(m => m.type === "status");
  const latestResult = batch.find(m => m.type === "result");
  const latestDone = batch.find(m => m.type === "done");
  const latestError = batch.find(m => m.type === "error");
  const latestTotal = batch.find(m => m.type === "total");
  const latestReview = batch.find(m => m.type === "reviewQueued");

  try {
    const stored = await chrome.storage.local.get([STATE_KEY]);
    const state = stored[STATE_KEY] || {};

    if (latestTotal) state.candidateCount = latestTotal.total;
    if (latestProgress) state.checkedChats = latestProgress.current;
    if (latestStatus) state.statusText = latestStatus.text;
    if (latestResult) {
      state.cleanOrders = state.cleanOrders || [];
      state.disputeOrders = state.disputeOrders || [];
      state.excludedOrders = state.excludedOrders || [];
      if (latestResult.counts) {
        // We don't rebuild full arrays here to keep writes small
        // Full results come on "done"
      }
    }
    if (latestDone) {
      state.status = "done";
      state.checkedChats = latestDone.results ? (latestDone.results.clean.length + latestDone.results.dispute.length + latestDone.results.excluded.length) : 0;
    }
    if (latestError) state.status = "error";
    if (latestReview) state.reviewQueued = latestReview;

    // Always update status
    if (batch.some(m => m.type === "progress" || m.type === "status")) {
      const prog = batch.find(m => m.type === "progress");
      if (prog) {
        state.checkedChats = prog.current;
        state.candidateCount = prog.total;
        state.status = "running";
      }
    }

    await chrome.storage.local.set({ [STATE_KEY]: state });
  } catch {}
}
}, 100); // batch window 100ms
}

// ── Main check loop (parallel + batch AI + review queue) ──────────────────────
async function runCheck(settings, sendProgressFn) {
isRunning = true;
shouldStop = false;
currentSettings = settings;

const results = { clean: [], dispute: [], excluded: [], aiCount: 0, rulesCount: 0 };
const pendingReview = [];
const aiSettings = await getAiSettings();
const useAI = aiSettings.enabled && aiSettings.apiKey;
const aiThreshold = parseFloat(settings.aiThreshold) || 0.65;
const aiReviewLow = parseFloat(settings.aiReviewLow) || 0.4;
const aiReviewHigh = parseFloat(settings.aiReviewHigh) || 0.7;
const concurrency = parseInt(settings.concurrency) || 3;
const aiBatchSize = parseInt(settings.aiBatchSize) || 5;
const useBatchAI = useAI && aiBatchSize > 1;

const delay = ms => new Promise(r => setTimeout(r, ms));
const adaptiveDelay = settings.adaptiveDelay !== false;
const baseDelay = parseInt(settings.delayMs) || 1800;
const pauseEvery = parseInt(settings.pauseEvery) || 25;
const pauseMs = parseInt(settings.pauseMs) || 15000;

try {
sendProgressFn({ type: "status", text: "Собираю список заказов..." });
const firstDoc = await fetchOrdersPage(1);
const totalPages = getTotalPages(firstDoc);
let allOrders = parseOrdersFromDoc(firstDoc);

for (let p = 2; p <= totalPages; p++) {
  if (shouldStop) break;
  sendProgressFn({ type: "status", text: `Загружаю страницу ${p}/${totalPages}...` });
  const doc = await fetchOrdersPage(p);
  allOrders = allOrders.concat(parseOrdersFromDoc(doc));
  await delay(600);
}

const minPrice = parseFloat(settings.minPrice) || 0;
const gameFilter = (settings.gameFilter || "").trim().toLowerCase();
if (minPrice > 0) allOrders = allOrders.filter(o => o.amount >= minPrice);
if (gameFilter) allOrders = allOrders.filter(o => o.game.toLowerCase().includes(gameFilter));

const total = allOrders.length;
sendProgressFn({ type: "total", total });
sendProgressFn({ type: "status", text: `Найдено ${total} заказов. Проверяю ${concurrency} параллельно...` });

// Write initial state to storage so popup can see it
await chrome.storage.local.set({ [STATE_KEY]: { status: "collecting", candidateCount: total, checkedChats: 0 } });

let processed = 0;
let aiBatchQueue = [];
let isFlushing = false; // ── FIX 6: Guard against concurrent batch flush ──

async function processOne(order) {
  if (shouldStop) return;
  processed++;
  sendProgressFn({ type: "progress", current: processed, total });

  if (processed > 1 && processed % pauseEvery === 0) {
    sendProgressFn({ type: "status", text: `Пауза ${pauseMs/1000}с после ${processed} заказов...` });
    await delay(pauseMs);
  }

  let chatData;
  try {
    chatData = await fetchChatForOrder(order.orderId);
  } catch (err) {
    console.warn(`[FunPay] Failed order ${order.orderId}:`, err);
    results.dispute.push({ ...order, reason: "Не удалось загрузить чат", byAI: false });
    return;
  }

  // Rules first (fast)
  const rulesResult = classifyByRules(chatData, settings);

  // If rules say excluded, no need for AI
  if (rulesResult.list === "excluded") {
    results.excluded.push({ ...order, reason: rulesResult.reason, byAI: false });
    results.rulesCount++;
    sendProgressFn({ type: "result", list: "excluded", entry: { ...order, reason: rulesResult.reason, byAI: false }, counts: { clean: results.clean.length, dispute: results.dispute.length, excluded: results.excluded.length } });
    return;
  }

  // If AI enabled, queue for batch or classify immediately
  if (useAI) {
    if (useBatchAI) {
      aiBatchQueue.push({ order, chatData, rulesResult });
      if (aiBatchQueue.length >= aiBatchSize && !isFlushing) {
        await flushAiBatch();
      }
      return;
    } else {
      // Single AI
      try {
        const aiResult = await callAiClassifier(chatData, aiSettings);
        if (aiResult) {
          if (aiResult.confidence >= aiThreshold) {
            if (aiResult.confidence >= aiReviewLow && aiResult.confidence < aiReviewHigh) {
              // Needs review
              pendingReview.push({ ...order, aiResult, chatData, rulesResult });
              sendProgressFn({ type: "reviewQueued", orderId: order.orderId, reason: aiResult.reason, confidence: aiResult.confidence });
            } else {
              results[aiResult.list].push({ ...order, reason: aiResult.reason, byAI: true, confidence: aiResult.confidence });
              results.aiCount++;
              sendProgressFn({ type: "result", list: aiResult.list, entry: { ...order, reason: aiResult.reason, byAI: true, confidence: aiResult.confidence }, counts: { clean: results.clean.length, dispute: results.dispute.length, excluded: results.excluded.length } });
            }
            return;
          }
        }
      } catch (err) {
        console.warn("[FunPay AI] single error:", err);
      }
    }
  }

  // Fallback to rules
  results[rulesResult.list].push({ ...order, reason: rulesResult.reason, byAI: false });
  results.rulesCount++;
  sendProgressFn({ type: "result", list: rulesResult.list, entry: { ...order, reason: rulesResult.reason, byAI: false }, counts: { clean: results.clean.length, dispute: results.dispute.length, excluded: results.excluded.length } });
}

// ── FIX 6: Race-condition-safe batch flush ─────────────────────────────────
async function flushAiBatch() {
  if (isFlushing || aiBatchQueue.length === 0) return;
  isFlushing = true;
  try {
    const batch = aiBatchQueue.splice(0, aiBatchQueue.length);
    const batchItems = batch.map((item, idx) => ({ index: idx, orderId: item.order.orderId, chatData: item.chatData }));

    try {
      const batchResults = await callAiClassifierBatch(batchItems, aiSettings);
      if (batchResults && batchResults.length > 0) {
        const resultMap = new Map(batchResults.map(r => [r.index, r]));
        for (let i = 0; i < batch.length; i++) {
          const item = batch[i];
          const aiResult = resultMap.get(i);
          if (aiResult && aiResult.confidence >= aiThreshold) {
            if (aiResult.confidence >= aiReviewLow && aiResult.confidence < aiReviewHigh) {
              pendingReview.push({ ...item.order, aiResult, chatData: item.chatData, rulesResult: item.rulesResult });
              sendProgressFn({ type: "reviewQueued", orderId: item.order.orderId, reason: aiResult.reason, confidence: aiResult.confidence });
            } else {
              results[aiResult.list].push({ ...item.order, reason: aiResult.reason, byAI: true, confidence: aiResult.confidence });
              results.aiCount++;
              sendProgressFn({ type: "result", list: aiResult.list, entry: { ...item.order, reason: aiResult.reason, byAI: true, confidence: aiResult.confidence }, counts: { clean: results.clean.length, dispute: results.dispute.length, excluded: results.excluded.length } });
            }
          } else {
            // AI failed or low confidence → rules
            results[item.rulesResult.list].push({ ...item.order, reason: item.rulesResult.reason, byAI: false });
            results.rulesCount++;
            sendProgressFn({ type: "result", list: item.rulesResult.list, entry: { ...item.order, reason: item.rulesResult.reason, byAI: false }, counts: { clean: results.clean.length, dispute: results.dispute.length, excluded: results.excluded.length } });
          }
        }
      } else {
        // Batch failed → rules for all
        for (const item of batch) {
          results[item.rulesResult.list].push({ ...item.order, reason: item.rulesResult.reason, byAI: false });
          results.rulesCount++;
          sendProgressFn({ type: "result", list: item.rulesResult.list, entry: { ...item.order, reason: item.rulesResult.reason, byAI: false }, counts: { clean: results.clean.length, dispute: results.dispute.length, excluded: results.excluded.length } });
        }
      }
    } catch (err) {
      console.warn("[FunPay AI Batch] failed:", err);
      for (const item of batch) {
        results[item.rulesResult.list].push({ ...item.order, reason: item.rulesResult.reason, byAI: false });
        results.rulesCount++;
        sendProgressFn({ type: "result", list: item.rulesResult.list, entry: { ...item.order, reason: item.rulesResult.reason, byAI: false }, counts: { clean: results.clean.length, dispute: results.dispute.length, excluded: results.excluded.length } });
      }
    }
  } finally {
    isFlushing = false;
  }
}

// Run workers in parallel
const queue = [...allOrders];
const workers = [];
for (let w = 0; w < concurrency; w++) {
  workers.push((async () => {
    while (queue.length > 0 && !shouldStop) {
      const order = queue.shift();
      await processOne(order);
      const d = adaptiveDelay ? baseDelay + Math.random() * 400 : baseDelay;
      await delay(d);
    }
  })());
}
await Promise.all(workers);

// Flush remaining batch
if (useBatchAI && aiBatchQueue.length > 0) {
  await flushAiBatch();
}

} catch (err) {
sendProgressFn({ type: "error", text: `Ошибка: ${err.message}` });
}

isRunning = false;

// Save full results + pending review to storage
const state = {
status: shouldStop ? "stopped" : "done",
cleanOrders: results.clean,
disputeOrders: results.dispute,
excludedOrders: results.excluded,
checkedChats: results.clean.length + results.dispute.length + results.excluded.length,
candidateCount: results.clean.length + results.dispute.length + results.excluded.length,
aiClassifiedCount: results.aiCount,
rulesClassifiedCount: results.rulesCount
};

await chrome.storage.local.set({ [STATE_KEY]: state });

if (pendingReview.length > 0) {
await chrome.storage.local.set({ "funpayListsPendingReview": pendingReview });
}

sendProgressFn({
type: "done",
results,
aiCount: results.aiCount,
rulesCount: results.rulesCount,
pendingReviewCount: pendingReview.length
});
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
const { type } = message;

if (isPing(type)) {
sendResponse({ ok: true });
return false;
}

if (isStop(type)) {
shouldStop = true;
isRunning = false;
sendResponse({ ok: true });
return false;
}

if (type === "GET_STATUS") {
sendResponse({ isRunning, shouldStop });
return false;
}

if (isStart(type) || isResume(type)) {
if (isRunning) {
  sendResponse({ ok: false, error: "Уже запущено" });
  return false;
}
const settings = message.settings || {};
runCheck(settings, sendProgress);
sendResponse({ ok: true, started: true });
return false;
}

if (type === "SAVE_AI_EXAMPLE") {
const { example } = message;
chrome.storage.local.get([AI_EXAMPLES_KEY], (stored) => {
  const examples = stored[AI_EXAMPLES_KEY] || [];
  examples.push(example);
  const trimmed = examples.slice(-AI_MAX_EXAMPLES);
  chrome.storage.local.set({ [AI_EXAMPLES_KEY]: trimmed }, () => {
    sendResponse({ ok: true, count: trimmed.length });
  });
});
return true;
}

if (type === "RESOLVE_REVIEW") {
const { orderId, list, reason } = message;
chrome.storage.local.get(["funpayListsPendingReview"], (stored) => {
  const pending = stored["funpayListsPendingReview"] || [];
  const idx = pending.findIndex(p => p.orderId === orderId);
  if (idx >= 0) {
    const item = pending[idx];
    pending.splice(idx, 1);
    chrome.storage.local.set({ "funpayListsPendingReview": pending }, () => {
      // Also save as AI example for learning
      const example = {
        chatText: item.chatData?.chatText || "",
        productText: item.chatData?.productText || "",
        list,
        reason: reason || item.aiResult?.reason || ""
      };
      chrome.storage.local.get([AI_EXAMPLES_KEY], (s2) => {
        const examples = s2[AI_EXAMPLES_KEY] || [];
        examples.push(example);
        chrome.storage.local.set({ [AI_EXAMPLES_KEY]: examples.slice(-AI_MAX_EXAMPLES) });
      });
      sendResponse({ ok: true, remaining: pending.length });
    });
  } else {
    sendResponse({ ok: false, error: "Not found" });
  }
});
return true;
}

return false;
});

// ── Ready signal ──────────────────────────────────────────────────────────────
console.log("[FunPay Lists] content.js v3.2.0 — parallel, batch AI, 429+5xx retry, throttled storage, OCR cache limit");