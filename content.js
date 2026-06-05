// ── AI Classifier ────────────────────────────────────────────────────────────
const AI_STORAGE_KEY = "funpayListsAI";
const AI_EXAMPLES_KEY = "funpayListsAIExamples";
const AI_MAX_EXAMPLES = 20;

const AI_SYSTEM_PROMPT = `Ты — ассистент для проверки заказов на платформе FunPay.
Отвечай ТОЛЬКО в формате JSON, без лишнего текста:
{
"list": "clean" | "dispute" | "excluded",
"confidence": 0.0-1.0,
"reason": "объяснение на русском, 1-2 предложения"
}`;

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
  examplesSection = "\n\nТВОИ РЕШЕНИЯ (обучающие примеры — учитывай их при классификации):\n";
  examplesSection += recent.map((ex) =>
    `Чат: "${ex.chatText.slice(0, 200)}"\nТовар: "${(ex.productText || "").slice(0, 100)}"\n→ ${JSON.stringify({ list: ex.list, reason: ex.reason })}`
  ).join("\n\n");
}

const userPrompt = buildAiUserPrompt(chatData);
const contentParts = [{ type: "text", text: `${rules}${examplesSection}\n\n---\n\n${userPrompt}` }];

if (chatData.imageUrls && chatData.imageUrls.length > 0) {
  const imageLimit = chatData.imageUrls.slice(0, 3);
  for (const url of imageLimit) {
    const b64 = await imageUrlToBase64(url);
    if (b64) {
      contentParts.push({ type: "image_url", image_url: { url: b64, detail: "low" } });
    }
  }
}

try {
  const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || "moonshotai/kimi-k2.6",
      messages: [
        { role: "system", content: AI_SYSTEM_PROMPT },
        { role: "user", content: contentParts }
      ],
      temperature: 0.1,
      max_tokens: 256
    })
  });

  if (!response.ok) {
    console.warn("[FunPay AI] API error:", response.status, await response.text());
    return null;
  }

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

function buildAiUserPrompt(chatData) {
const lines = [];
lines.push("Проанализируй этот заказ и определи список:");
lines.push("");
if (chatData.productText) {
  lines.push(`📦 ОПИСАНИЕ ТОВАРА:\n${chatData.productText.slice(0, 300)}`);
  lines.push("");
}
if (chatData.messages && chatData.messages.length > 0) {
  lines.push("💬 ЧАТ (последние сообщения):");
  const recent = chatData.messages.slice(-30);
  for (const msg of recent) {
    const role = msg.role === "buyer" ? "Покупатель" : msg.role === "seller" ? "Продавец" : "Система";
    const attachment = msg.hasAttachment ? " [📎 вложение]" : "";
    if (msg.text || msg.hasAttachment) {
      lines.push(`[${role}]${attachment}: ${(msg.text || "").slice(0, 200)}`);
    }
  }
  lines.push("");
}
if (chatData.ocrText) {
  lines.push(`🔍 OCR С ФОТО:\n${chatData.ocrText.slice(0, 400)}`);
  lines.push("");
}
if (chatData.imageUrls && chatData.imageUrls.length > 0) {
  lines.push(`🖼️ Фото в чате: ${chatData.imageUrls.length} шт. (прикреплены выше)`);
}
return lines.join("\n");
}

// ── State ─────────────────────────────────────────────────────────────────────
let isRunning = false;
let shouldStop = false;
let currentSettings = {};

// ── Message name compatibility (popup.js uses old names) ──────────────────────
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
/благодарю/i, /супер/i, /отлично/i, /класс/i, /👍/
];

const DEFAULT_SOFT_DISPUTE_PATTERNS = [
/не работает/i, /не то/i, /верни/i, /обман/i, /мошенник/i,
/не получил/i, /где товар/i, /не пришло/i, /ошибка/i, /не могу войти/i,
/не входит/i, /неверный/i, /неправильный/i
];

function buildPatterns(customRaw, defaults) {
const patterns = [...defaults];
if (customRaw) {
  customRaw.split("\n").map(s => s.trim()).filter(Boolean).forEach(p => {
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
const resp = await fetch(url, { credentials: "include" });
if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
const html = await resp.text();
const doc = new DOMParser().parseFromString(html, "text/html");
return doc;
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
const resp = await fetch(url, { credentials: "include" });
if (!resp.ok) throw new Error(`HTTP ${resp.status} for order ${orderId}`);
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

// ── Classification (rule-based) ───────────────────────────────────────────────
function classifyByRules(chatData, settings) {
const { hasModeratorMessage, chatText, hasAttachment } = chatData;

const disputePatterns = buildPatterns(settings.customDisputePatterns, DEFAULT_DISPUTE_PATTERNS);
const cleanPatterns = buildPatterns(settings.customCleanPatterns, DEFAULT_CLEAN_PATTERNS);
const softDisputePatterns = buildPatterns(null, DEFAULT_SOFT_DISPUTE_PATTERNS);

const blackWords = (settings.blackWords || "").split(",").map(s => s.trim()).filter(Boolean);
const whiteWords = (settings.whiteWords || "").split(",").map(s => s.trim()).filter(Boolean);

if (hasModeratorMessage || matchesAny(chatText, disputePatterns)) {
  return { list: "excluded", reason: "Арбитраж или модератор обнаружен в чате", byAI: false };
}

if (blackWords.some(w => chatText.toLowerCase().includes(w.toLowerCase()))) {
  return { list: "dispute", reason: "Найдено слово из чёрного списка", byAI: false };
}

if (matchesAny(chatText, softDisputePatterns)) {
  return { list: "dispute", reason: "Обнаружены признаки проблемы в чате", byAI: false };
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

return { list: "dispute", reason: "Покупатель не подтвердил получение товара", byAI: false };
}

// ── Main check loop ───────────────────────────────────────────────────────────
async function runCheck(settings, sendProgress) {
isRunning = true;
shouldStop = false;
currentSettings = settings;

const results = { clean: [], dispute: [], excluded: [], aiCount: 0, rulesCount: 0 };
const aiSettings = await getAiSettings();
const useAI = aiSettings.enabled && aiSettings.apiKey;
const aiThreshold = 0.65;

const delay = ms => new Promise(r => setTimeout(r, ms));
const adaptiveDelay = settings.adaptiveDelay !== false;
const baseDelay = parseInt(settings.delayMs) || 1800;
const pauseEvery = parseInt(settings.pauseEvery) || 25;
const pauseMs = parseInt(settings.pauseMs) || 15000;

try {
  sendProgress({ type: "status", text: "Собираю список заказов..." });
  const firstDoc = await fetchOrdersPage(1);
  const totalPages = getTotalPages(firstDoc);
  let allOrders = parseOrdersFromDoc(firstDoc);

  for (let p = 2; p <= totalPages; p++) {
    if (shouldStop) break;
    sendProgress({ type: "status", text: `Загружаю страницу ${p}/${totalPages}...` });
    const doc = await fetchOrdersPage(p);
    allOrders = allOrders.concat(parseOrdersFromDoc(doc));
    await delay(600);
  }

  const minPrice = parseFloat(settings.minPrice) || 0;
  const gameFilter = (settings.gameFilter || "").trim().toLowerCase();
  if (minPrice > 0) allOrders = allOrders.filter(o => o.amount >= minPrice);
  if (gameFilter) allOrders = allOrders.filter(o => o.game.toLowerCase().includes(gameFilter));

  const total = allOrders.length;
  sendProgress({ type: "total", total });
  sendProgress({ type: "status", text: `Найдено ${total} заказов. Проверяю чаты...` });

  for (let i = 0; i < allOrders.length; i++) {
    if (shouldStop) break;

    const order = allOrders[i];
    sendProgress({ type: "progress", current: i + 1, total });

    if (i > 0 && i % pauseEvery === 0) {
      sendProgress({ type: "status", text: `Пауза ${pauseMs / 1000}с после ${i} заказов...` });
      await delay(pauseMs);
    }

    let chatData;
    try {
      chatData = await fetchChatForOrder(order.orderId);
    } catch (err) {
      console.warn(`[FunPay] Failed to fetch order ${order.orderId}:`, err);
      results.dispute.push({ ...order, reason: "Не удалось загрузить чат", byAI: false });
      continue;
    }

    let classification;

    if (useAI) {
      try {
        const aiResult = await callAiClassifier(chatData, aiSettings);
        if (aiResult && aiResult.confidence >= aiThreshold) {
          classification = { list: aiResult.list, reason: aiResult.reason, byAI: true, confidence: aiResult.confidence };
          results.aiCount++;
        }
      } catch (err) {
        console.warn("[FunPay AI] classifier error:", err);
      }
    }

    if (!classification) {
      classification = classifyByRules(chatData, settings);
      results.rulesCount++;
    }

    const entry = {
      ...order,
      reason: classification.reason,
      byAI: classification.byAI,
      confidence: classification.confidence,
      hasAttachment: chatData.hasAttachment,
      chatText: chatData.chatText.slice(0, 300),
      productText: chatData.productText.slice(0, 200)
    };

    results[classification.list].push(entry);

    sendProgress({
      type: "result",
      list: classification.list,
      entry,
      counts: { clean: results.clean.length, dispute: results.dispute.length, excluded: results.excluded.length }
    });

    const d = adaptiveDelay ? baseDelay + Math.random() * 400 : baseDelay;
    await delay(d);
  }
} catch (err) {
  sendProgress({ type: "error", text: `Ошибка: ${err.message}` });
}

isRunning = false;
sendProgress({
  type: "done",
  results,
  aiCount: results.aiCount,
  rulesCount: results.rulesCount
});
}

// ── Message listener (supports both old and new message names) ──────────────────
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
  runCheck(settings, (progressMsg) => {
    try {
      chrome.runtime.sendMessage({ ...progressMsg, source: "content" });
    } catch {}
  });
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

return false;
});

// ── Ready signal ──────────────────────────────────────────────────────────────
console.log("[FunPay Lists] content.js v3.1.0 ready");