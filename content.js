// ── Injection guard (prevent double-run when manifest + executeScript overlap)
if (window.__funpayListsInjected) {
  // already loaded — skip
} else {

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
Также clean: системное уведомление FunPay "подтвердил успешное выполнение заказа" — значит покупатель нажал кнопку подтверждения.

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
      `Чат: "${ex.chatText.slice(0, 200)}"
Товар: "${(ex.productText || "").slice(0, 100)}"
→ ${JSON.stringify({ list: ex.list, reason: ex.reason })}`
    ).join("\n\n");
  }

  const userPrompt = buildAiUserPrompt(chatData);
  const contentParts = [{ type: "text", text: `${rules}${examplesSection}\n\n---\n\n${userPrompt}` }];

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
    examplesSection = "\n\nТВОИ РЕШЕНИЯ (учитывай при классификации):\n";
    examplesSection += recent.map((ex) =>
      `→ ${JSON.stringify({ list: ex.list, reason: ex.reason })}`
    ).join("\n");
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
        max_tokens: 512 + batchItems.length * 80
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
    lines.push(`📦 ТОВАР:\n${chatData.productText.slice(0, 400)}`);
    lines.push("");
  }
  if (chatData.buyerConfirmed) {
    lines.push("✅ ПОКУПАТЕЛЬ НАЖАЛ КНОПКУ «ПОДТВЕРДИТЬ ВЫПОЛНЕНИЕ ЗАКАЗА»");
    lines.push("");
  }
  if (chatData.hasReview) {
    lines.push("⭐ ПОКУПАТЕЛЬ НАПИСАЛ ОТЗЫВ");
    lines.push("");
  }
  if (chatData.messages && chatData.messages.length > 0) {
    lines.push("💬 ЧАТ (сообщения относящиеся к данному заказу):");
    const recent = chatData.messages.slice(-25);
    for (const msg of recent) {
      const role = msg.role === "buyer" ? "Покупатель"
        : msg.role === "seller" ? "Продавец"
        : msg.role === "auto" ? "Авто-ответ"
        : msg.role === "moderator" ? "⚠️Модератор/Арбитраж"
        : "Система";
      const attachment = msg.hasAttachment ? " [📎 фото]" : "";
      if (msg.text || msg.hasAttachment) {
        lines.push(`[${role}]${attachment}: ${(msg.text || "(изображение)").slice(0, 200)}`);
      }
    }
    lines.push("");
  }
  if (chatData.imageUrls && chatData.imageUrls.length > 0) {
    lines.push(`🖼️ Фото: ${chatData.imageUrls.length} шт.`);
  }
  return lines.join("\n");
}

function buildAiBatchPrompt(batchItems, rules, examplesSection) {
  const lines = [];
  lines.push(`${rules}${examplesSection}`);
  lines.push("");
  lines.push("Проанализируй каждый заказ и верни JSON массив:");
  lines.push("");
  batchItems.forEach((item, idx) => {
    const cd = item.chatData;
    lines.push(`--- ЗАКАЗ [${idx}] ID=${item.orderId} ---`);
    if (cd.productText) lines.push(`Товар: ${cd.productText.slice(0, 200)}`);
    if (cd.buyerConfirmed) lines.push("✅ Покупатель подтвердил выполнение");
    if (cd.hasReview) lines.push("⭐ Есть отзыв");
    if (cd.chatText) lines.push(`Чат: ${cd.chatText.slice(0, 250)}`);
    if (cd.imageUrls?.length) lines.push(`Фото: ${cd.imageUrls.length} шт.`);
    lines.push("");
  });
  lines.push("ВЕРНИ ТОЛЬКО: [{\"index\":0,\"list\":\"clean\",\"confidence\":0.9,\"reason\":\"...\"},...]");
  return lines.join("\n");
}

// ── Fetch with retry (429 + 5xx) ──────────────────────────────────────────────
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
      if (!resp.ok) return resp;
      return resp;
    } catch (err) {
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
// v4: Using word boundaries (\b) to prevent false positives
const DEFAULT_DISPUTE_PATTERNS = [
  /\bарбитраж\b/i, /\bмодератор\b/i, /сотрудник funpay/i, /передано на рассмотрение/i,
  /открыт спор/i, /открыт арбитраж/i, /жалоба принята/i
];

const DEFAULT_CLEAN_PATTERNS = [
  /\bспасибо\b/i, /всё получил/i, /все получил/i, /всё пришло/i, /всё работает/i,
  /\bработает\b/i, /\bотлично\b/i, /всё ок\b/i, /все ок\b/i,
  /\bхорошо\b/i, /\bблагодарю\b/i, /\bсупер\b/i, /\bкласс\b/i,
  /\bкруто\b/i, /\bтоп\b/i, /👍/
];

const DEFAULT_SOFT_DISPUTE_PATTERNS = [
  /не работает/i, /не то\b/i, /\bверни\b/i, /\bобман\b/i, /\bмошенник/i,
  /не получил/i, /где товар/i, /не пришло/i, /\bошибка\b/i, /не могу войти/i,
  /не входит/i, /\bневерный\b/i, /\bнеправильный\b/i, /не скачивается/i,
  /не запускается/i, /не подходит/i, /что за фигня/i, /не робит/i,
  /хелп\b/i, /помогите/i
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

// ── Seller username detection ─────────────────────────────────────────────────
let cachedSellerUsername = null;

function detectSellerUsername(doc) {
  // Try .user-link-name in navbar (present on all FunPay pages when logged in)
  const userLink = doc.querySelector(".user-link-name");
  if (userLink) {
    cachedSellerUsername = userLink.textContent.trim();
    return cachedSellerUsername;
  }
  return cachedSellerUsername;
}

// ── FunPay date parsing ───────────────────────────────────────────────────────
const RU_MONTHS = {
  "января": 0, "февраля": 1, "марта": 2, "апреля": 3, "мая": 4, "июня": 5,
  "июля": 6, "августа": 7, "сентября": 8, "октября": 9, "ноября": 10, "декабря": 11
};

function parseFunPayDate(dateText) {
  if (!dateText) return null;
  const text = dateText.trim().toLowerCase();

  // Format: "сегодня, 19:29" or "вчера, 15:00"
  const todayMatch = text.match(/сегодня,?\s*(\d{1,2}):(\d{2})/);
  if (todayMatch) {
    const d = new Date();
    d.setHours(parseInt(todayMatch[1]), parseInt(todayMatch[2]), 0, 0);
    return d.toISOString();
  }
  const yesterdayMatch = text.match(/вчера,?\s*(\d{1,2}):(\d{2})/);
  if (yesterdayMatch) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(parseInt(yesterdayMatch[1]), parseInt(yesterdayMatch[2]), 0, 0);
    return d.toISOString();
  }

  // Format: "6 июня в 17:38" or "6 июня, 17:38"
  const fullMatch = text.match(/(\d{1,2})\s+(январ[яь]|феврал[яь]|март[а]?|апрел[яь]|ма[яй]|июн[яь]|июл[яь]|август[а]?|сентябр[яь]|октябр[яь]|ноябр[яь]|декабр[яь])\s*[в,]?\s*(\d{1,2}):(\d{2})/);
  if (fullMatch) {
    const day = parseInt(fullMatch[1]);
    const monthStr = fullMatch[2].replace(/ь$/, 'я').replace(/й$/, 'я');
    const monthKey = Object.keys(RU_MONTHS).find(k => monthStr.startsWith(k.slice(0, 3)));
    const month = monthKey ? RU_MONTHS[monthKey] : 0;
    const hour = parseInt(fullMatch[3]);
    const min = parseInt(fullMatch[4]);
    const year = new Date().getFullYear();
    const d = new Date(year, month, day, hour, min);
    // If date is in the future, it's probably last year
    if (d > new Date()) d.setFullYear(year - 1);
    return d.toISOString();
  }

  // Format from chat: "02.03.26" or "06.06.26"
  const shortMatch = text.match(/(\d{2})\.(\d{2})\.(\d{2,4})/);
  if (shortMatch) {
    let year = parseInt(shortMatch[3]);
    if (year < 100) year += 2000;
    return new Date(year, parseInt(shortMatch[2]) - 1, parseInt(shortMatch[1])).toISOString();
  }

  return null;
}

// ── FunPay API helpers (v4 — real DOM selectors) ──────────────────────────────

// Fetch first page of orders
async function fetchOrdersFirstPage() {
  const url = "https://funpay.com/orders/trade";
  const resp = await fetchWithRetry(url, { credentials: "include" }, 2);
  const html = await resp.text();
  return new DOMParser().parseFromString(html, "text/html");
}

// Fetch more orders using cursor-based pagination
async function fetchOrdersMore(cursor) {
  const url = "https://funpay.com/orders/trade";
  const body = new URLSearchParams();
  body.append("continue", cursor);
  const resp = await fetchWithRetry(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  }, 2);
  const html = await resp.text();
  return new DOMParser().parseFromString(html, "text/html");
}

// Get continuation cursor from page
function getContinueCursor(doc) {
  const input = doc.querySelector("form.dyn-table-form input[name='continue']");
  return input ? input.value : null;
}

// Parse orders from real FunPay DOM (a.tc-item elements)
function parseOrdersFromDoc(doc) {
  // Detect seller username from this page
  detectSellerUsername(doc);

  const items = doc.querySelectorAll("a.tc-item");
  const orders = [];

  items.forEach(el => {
    const href = el.getAttribute("href") || "";
    const idMatch = href.match(/\/orders\/([A-Z0-9]+)\/?/);
    if (!idMatch) return;

    const orderId = idMatch[1];

    // Status: "Оплачен", "Закрыт", "Возврат"
    const statusEl = el.querySelector(".tc-status");
    const statusText = statusEl ? statusEl.textContent.trim() : "";
    const statusClass = statusEl ? statusEl.className : "";

    // Order ID display
    const orderEl = el.querySelector(".tc-order");
    const orderDisplay = orderEl ? orderEl.textContent.trim() : `#${orderId}`;

    // Description: first div = title, .text-muted = game/category
    const descEl = el.querySelector(".order-desc");
    let title = "";
    let game = "";
    if (descEl) {
      const titleDiv = descEl.querySelector("div:first-child");
      if (titleDiv) title = titleDiv.textContent.trim();
      const gameDiv = descEl.querySelector(".text-muted");
      if (gameDiv) game = gameDiv.textContent.trim();
    }

    // Buyer name
    const buyerEl = el.querySelector(".tc-user .media-user-name span.pseudo-a")
      || el.querySelector(".tc-user .media-user-name");
    const buyer = buyerEl ? buyerEl.textContent.trim() : "";

    // Price
    const priceEl = el.querySelector(".tc-price.tc-seller-sum") || el.querySelector(".tc-price");
    let amount = 0;
    let currency = "₽";
    if (priceEl) {
      const unitEl = priceEl.querySelector(".unit");
      if (unitEl) currency = unitEl.textContent.trim();
      const priceText = priceEl.textContent.replace(currency, "").trim();
      amount = parseFloat(priceText.replace(/[^\d.,]/g, "").replace(",", ".")) || 0;
    }

    // Date
    const dateTimeEl = el.querySelector(".tc-date .tc-date-time") || el.querySelector(".tc-date-time");
    const dateLeftEl = el.querySelector(".tc-date .tc-date-left") || el.querySelector(".tc-date-left");
    const dateText = dateTimeEl ? dateTimeEl.textContent.trim() : "";
    const dateAgo = dateLeftEl ? dateLeftEl.textContent.trim() : "";

    // Parse dateIso
    const dateIso = parseFunPayDate(dateText);

    // Detect rental from title
    const isRental = /аренда/i.test(title) || /аренда/i.test(game);

    // tc-item class for status: info = Оплачен, warning = Возврат, plain = Закрыт
    const itemClass = el.className || "";
    const isPaid = itemClass.includes("info") || /оплачен/i.test(statusText);
    const isRefund = itemClass.includes("warning") || /возврат/i.test(statusText);
    const isClosed = !isPaid && !isRefund;

    orders.push({
      orderId,
      id: orderId,
      title,
      game,
      buyer,
      amount,
      currency,
      date: dateText,
      dateAgo,
      dateIso,
      status: statusText,
      isPaid,
      isClosed,
      isRefund,
      isRental,
      url: `https://funpay.com/orders/${orderId}/`
    });
  });

  return orders;
}

// Fetch and parse chat for a specific order
async function fetchChatForOrder(orderId) {
  const url = `https://funpay.com/orders/${orderId}/`;
  const resp = await fetchWithRetry(url, { credentials: "include" }, 2);
  const html = await resp.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  return parseChatFromOrderPage(doc, orderId);
}

// Parse chat messages from real FunPay order page DOM
function parseChatFromOrderPage(doc, orderId) {
  // Detect seller username
  const sellerName = detectSellerUsername(doc) || "";

  // Product info from param-list
  let productText = "";
  let gameText = "";
  const paramItems = doc.querySelectorAll(".param-item");
  paramItems.forEach(pi => {
    const text = pi.textContent.trim();
    if (/^Краткое описание/i.test(text)) {
      productText = text.replace(/^Краткое описание\s*/i, "").trim();
    }
    if (/^Игра\s/i.test(text)) {
      gameText = text.replace(/^Игра\s*/i, "").trim();
    }
  });

  // Order header for title
  const headerEl = doc.querySelector(".page-header h1");
  const headerText = headerEl ? headerEl.textContent.trim() : "";

  // Review
  const reviewEl = doc.querySelector(".order-review");
  const reviewText = reviewEl ? reviewEl.textContent.trim() : "";
  const hasReview = reviewEl && !/отсутствует/i.test(reviewText);

  // Parse chat messages
  const chatList = doc.querySelector(".chat-message-list");
  if (!chatList) {
    return {
      messages: [], imageUrls: [], hasAttachment: false,
      hasModeratorMessage: false, productText, gameText,
      chatText: "", orderId, buyerConfirmed: false, hasReview,
      sellerName
    };
  }

  const msgElements = chatList.querySelectorAll(".chat-msg-item");
  const allMessages = [];
  const imageUrls = [];
  let hasAttachment = false;
  let hasModeratorMessage = false;
  let buyerConfirmed = false;
  let lastAuthor = null;
  let lastRole = "system";
  let buyerName = null;

  msgElements.forEach(el => {
    const hasHead = el.classList.contains("chat-msg-with-head");

    let author = null;
    let role = "system";
    let label = "";

    if (hasHead) {
      // Author detection
      const authorLink = el.querySelector(".chat-msg-author-link");
      const mediaName = el.querySelector(".media-user-name");

      if (authorLink) {
        author = authorLink.textContent.trim();
      } else if (mediaName) {
        // System message (FunPay) — no author link
        const rawName = mediaName.childNodes[0]?.textContent?.trim() || mediaName.textContent.trim();
        author = rawName.replace(/\s+/g, " ").split("\n")[0].trim();
      }

      // Label detection
      const labelEl = el.querySelector(".chat-msg-author-label");
      if (labelEl) {
        label = labelEl.textContent.trim().toLowerCase();
      }

      // Role determination
      if (!authorLink && (/funpay/i.test(author) || label === "оповещение")) {
        role = "system";
      } else if (label === "оповещение") {
        role = "system";
      } else if (author === sellerName) {
        role = label === "автоответ" ? "auto" : "seller";
      } else if (authorLink && author !== sellerName) {
        role = "buyer";
        if (!buyerName) buyerName = author;
      }

      // Moderator/staff detection
      const isPrimary = labelEl && labelEl.classList.contains("label-primary");
      if (isPrimary && label !== "оповещение") {
        hasModeratorMessage = true;
        role = "moderator";
      }

      lastAuthor = author;
      lastRole = role;
    } else {
      // Continuation message — inherit author/role from previous HEAD message
      author = lastAuthor;
      role = lastRole;
    }

    // Message text
    const textEl = el.querySelector(".chat-msg-text");
    const text = textEl ? textEl.textContent.trim() : "";

    // Images
    const imgLinks = el.querySelectorAll(".chat-img-link");
    imgLinks.forEach(link => {
      const href = link.getAttribute("href");
      if (href) {
        imageUrls.push(href.startsWith("http") ? href : `https://funpay.com${href}`);
        hasAttachment = true;
      }
    });

    // Also check for inline images
    const imgs = el.querySelectorAll(".chat-img");
    if (imgs.length > 0) hasAttachment = true;

    // Date
    const dateEl = el.querySelector(".chat-msg-date");
    const dateTitle = dateEl ? (dateEl.getAttribute("title") || dateEl.textContent.trim()) : "";

    // Detect buyer confirmation from system notifications
    if (role === "system" && text) {
      const confirmMatch = text.match(/подтвердил.*?успешное выполнение.*?заказа?\s*#?(\w+)/i);
      if (confirmMatch) {
        const confirmedId = confirmMatch[1];
        if (confirmedId === orderId) {
          buyerConfirmed = true;
        }
      }
      // Detect moderator/arbitrage from system messages
      if (/арбитраж|модератор подключился|администратор подключился|сотрудник.*?подключился/i.test(text)) {
        hasModeratorMessage = true;
      }
      // Detect "Администратор" confirming (staff, not buyer)
      if (/администратор.*?подтвердил.*?выполнение.*?#?(\w+)/i.test(text)) {
        const adminConfirmId = text.match(/#?([A-Z0-9]+)/);
        if (adminConfirmId && adminConfirmId[1] === orderId) {
          buyerConfirmed = true; // Admin confirmed = also good
        }
      }
    }

    // Detect moderator messages from actual chat participants
    if (role !== "system" && role !== "seller" && role !== "buyer" && role !== "auto") {
      if (/модератор|арбитр|сотрудник|support/i.test(label) || /модератор|арбитр/i.test(author || "")) {
        hasModeratorMessage = true;
        role = "moderator";
      }
    }

    if (text || hasAttachment) {
      allMessages.push({
        role,
        author: author || "unknown",
        label,
        text: text.slice(0, 500),
        hasAttachment: imgLinks.length > 0 || imgs.length > 0,
        date: dateTitle,
        isForCurrentOrder: true // Will be refined below
      });
    }
  });

  // === MULTI-ORDER CHAT HANDLING ===
  // FunPay shows all messages between buyer and seller in the same chat.
  // We need to identify which messages are relevant to THIS order.
  // Strategy: Find the payment notification for this order, take messages from there.
  const orderPaymentIdx = allMessages.findIndex(m =>
    m.role === "system" && m.text && m.text.includes(`#${orderId}`) && /оплатил/i.test(m.text)
  );

  let relevantMessages;
  if (orderPaymentIdx >= 0) {
    // Find the NEXT order's payment notification (if any) to bound our range
    let nextOrderIdx = allMessages.length;
    for (let i = orderPaymentIdx + 1; i < allMessages.length; i++) {
      if (allMessages[i].role === "system" && /оплатил.*?заказ.*?#(?!.*?#)/i.test(allMessages[i].text)) {
        // Check it's a DIFFERENT order
        const otherOrderMatch = allMessages[i].text.match(/#([A-Z0-9]+)/);
        if (otherOrderMatch && otherOrderMatch[1] !== orderId) {
          nextOrderIdx = i;
          break;
        }
      }
    }
    relevantMessages = allMessages.slice(orderPaymentIdx, nextOrderIdx);
  } else {
    // Can't find payment notification — use all messages (fallback)
    relevantMessages = allMessages;
  }

  // Build chat text from relevant messages only
  const chatText = relevantMessages
    .filter(m => m.role !== "system" || m.text.includes(`#${orderId}`))
    .map(m => m.text)
    .join(" ");

  // Get last buyer message from relevant messages
  const buyerMessages = relevantMessages.filter(m => m.role === "buyer");
  const lastBuyerMsg = buyerMessages.length > 0 ? buyerMessages[buyerMessages.length - 1].text : "";

  return {
    messages: relevantMessages,
    imageUrls,
    hasAttachment,
    hasModeratorMessage,
    productText: productText || gameText,
    gameText,
    chatText,
    orderId,
    buyerConfirmed,
    hasReview,
    lastBuyerMsg,
    buyerName,
    sellerName,
    buyerMessages
  };
}

// ── OCR cache ─────────────────────────────────────────────────────────────────
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

// ── Classification (rule-based) v4 ────────────────────────────────────────────
function classifyByRules(chatData, settings) {
  const {
    hasModeratorMessage, chatText, hasAttachment,
    buyerConfirmed, hasReview, lastBuyerMsg, buyerMessages, messages
  } = chatData;

  const disputePatterns = buildPatterns(settings.customDisputePatterns, DEFAULT_DISPUTE_PATTERNS);
  const cleanPatterns = buildPatterns(settings.customCleanPatterns, DEFAULT_CLEAN_PATTERNS);
  const softDisputePatterns = buildPatterns(null, DEFAULT_SOFT_DISPUTE_PATTERNS);
  const blackWords = (settings.blackWords || "").split(",").map(s => s.trim()).filter(Boolean);
  const whiteWords = (settings.whiteWords || "").split(",").map(s => s.trim()).filter(Boolean);

  // Get only buyer text (excluding system/seller/auto messages)
  const buyerTexts = (buyerMessages || []).map(m => m.text || "");
  const allBuyerText = buyerTexts.join(" ");
  const lastBuyer = lastBuyerMsg || "";

  // ── 1. Excluded: moderator/arbitrage present ──
  if (hasModeratorMessage) {
    return { list: "excluded", reason: "Арбитраж или модератор обнаружен в чате", byAI: false };
  }
  // Check for arbitrage keywords in system messages
  const systemTexts = (messages || []).filter(m => m.role === "system").map(m => m.text).join(" ");
  if (matchesAny(systemTexts, disputePatterns)) {
    return { list: "excluded", reason: "Арбитраж обнаружен в системных сообщениях", byAI: false };
  }

  // ── 2. Black words → dispute ──
  if (blackWords.some(w => allBuyerText.toLowerCase().includes(w.toLowerCase()))) {
    return { list: "dispute", reason: "Найдено слово из чёрного списка в сообщениях покупателя", byAI: false };
  }

  // ── 3. Buyer confirmed via FunPay button → clean ──
  if (buyerConfirmed) {
    // Even if buyer complained before, if they pressed "confirm" button it's clean
    // Unless there's a complaint AFTER confirmation (check last buyer message)
    if (lastBuyer && matchesAny(lastBuyer, softDisputePatterns)) {
      return { list: "dispute", reason: "Покупатель подтвердил, но последнее сообщение содержит жалобу", byAI: false };
    }
    return { list: "clean", reason: "Покупатель нажал «Подтвердить выполнение заказа»", byAI: false };
  }

  // ── 4. Has review → clean ──
  if (hasReview) {
    return { list: "clean", reason: "Покупатель оставил отзыв", byAI: false };
  }

  // ── 5. White words in last buyer message → clean ──
  if (whiteWords.some(w => lastBuyer.toLowerCase().includes(w.toLowerCase()))) {
    return { list: "clean", reason: "Найдено слово из белого списка (последнее сообщение)", byAI: false };
  }

  // ── 6. Clean patterns in last buyer message → clean ──
  if (lastBuyer && matchesAny(lastBuyer, cleanPatterns)) {
    // But not if it also matches soft dispute
    if (!matchesAny(lastBuyer, softDisputePatterns)) {
      return { list: "clean", reason: "Покупатель подтвердил получение", byAI: false };
    }
  }

  // ── 7. Soft dispute patterns in buyer messages → dispute ──
  if (matchesAny(allBuyerText, softDisputePatterns)) {
    return { list: "dispute", reason: "Обнаружены признаки проблемы в сообщениях покупателя", byAI: false };
  }

  // ── 8. Attachment from buyer without clean confirmation → dispute ──
  const buyerHasAttachment = (buyerMessages || []).some(m => m.hasAttachment);
  if (buyerHasAttachment && !matchesAny(allBuyerText, cleanPatterns)) {
    return { list: "dispute", reason: "Покупатель отправил фото, подтверждение не найдено", byAI: false };
  }

  // ── 9. Clean patterns anywhere in buyer text → clean ──
  if (matchesAny(allBuyerText, cleanPatterns)) {
    return { list: "clean", reason: "Покупатель подтвердил получение", byAI: false };
  }

  // ── 10. No buyer messages at all (auto-delivery, buyer never wrote) ──
  if (buyerTexts.length === 0) {
    // Auto-delivery without any buyer interaction
    // Check if buyer at least used a command like !cd
    const hasCommand = (messages || []).some(m =>
      m.role === "buyer" && /^!/.test((m.text || "").trim())
    );
    if (hasCommand) {
      return { list: "clean", reason: "Автовыдача: покупатель использовал команду", byAI: false };
    }
    return { list: "dispute", reason: "Покупатель не писал в чат и не подтвердил получение", byAI: false };
  }

  // ── 11. Default: buyer didn't confirm ──
  return { list: "dispute", reason: "Покупатель не подтвердил получение", byAI: false };
}

// ── Throttled progress sender ─────────────────────────────────────────────────
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

    for (const m of batch) {
      try { chrome.runtime.sendMessage({ ...m, source: "content" }); } catch {}
    }

    const now = Date.now();
    if (now - lastStorageWrite >= STORAGE_THROTTLE_MS) {
      lastStorageWrite = now;

      const latestProgress = batch.find(m => m.type === "progress");
      const latestStatus = batch.find(m => m.type === "status");
      const latestDone = batch.find(m => m.type === "done");
      const latestError = batch.find(m => m.type === "error");
      const latestTotal = batch.find(m => m.type === "total");
      const latestReview = batch.find(m => m.type === "reviewQueued");

      try {
        const stored = await chrome.storage.local.get([STATE_KEY]);
        const state = stored[STATE_KEY] || {};

        if (latestTotal) state.candidateCount = latestTotal.total;
        if (latestProgress) {
          state.checkedChats = latestProgress.current;
          state.candidateCount = latestProgress.total;
          state.status = "running";
        }
        if (latestStatus) state.statusText = latestStatus.text;
        if (latestDone) {
          state.status = "done";
          state.checkedChats = latestDone.results
            ? (latestDone.results.clean.length + latestDone.results.dispute.length + latestDone.results.excluded.length)
            : 0;
        }
        if (latestError) state.status = "error";
        if (latestReview) state.reviewQueued = latestReview;

        await chrome.storage.local.set({ [STATE_KEY]: state });
      } catch {}
    }
  }, 100);
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

    // Cursor-based pagination
    let allOrders = [];
    let cursor = null;
    let pageNum = 0;
    const MAX_PAGES = 20; // Safety limit

    // First page
    const firstDoc = await fetchOrdersFirstPage();
    allOrders = parseOrdersFromDoc(firstDoc);
    cursor = getContinueCursor(firstDoc);
    pageNum = 1;

    sendProgressFn({ type: "status", text: `Страница ${pageNum}: ${allOrders.length} заказов...` });

    // Load more pages
    while (cursor && !shouldStop && pageNum < MAX_PAGES) {
      pageNum++;
      sendProgressFn({ type: "status", text: `Загружаю страницу ${pageNum}...` });
      await delay(600);
      const doc = await fetchOrdersMore(cursor);
      const moreOrders = parseOrdersFromDoc(doc);
      if (moreOrders.length === 0) break;
      allOrders = allOrders.concat(moreOrders);
      cursor = getContinueCursor(doc);
      sendProgressFn({ type: "status", text: `Страница ${pageNum}: всего ${allOrders.length} заказов...` });
    }

    // Filter: only paid orders (not closed/refunded)
    let candidates = allOrders.filter(o => o.isPaid);

    // Apply user filters
    const minPrice = parseFloat(settings.minPrice) || 0;
    const gameFilter = (settings.gameFilter || "").trim().toLowerCase();
    if (minPrice > 0) candidates = candidates.filter(o => o.amount >= minPrice);
    if (gameFilter) candidates = candidates.filter(o =>
      o.game.toLowerCase().includes(gameFilter) || o.title.toLowerCase().includes(gameFilter)
    );

    const total = candidates.length;
    sendProgressFn({ type: "total", total });
    sendProgressFn({ type: "status", text: `Найдено ${total} оплаченных заказов (из ${allOrders.length} всего). Проверяю...` });

    await chrome.storage.local.set({ [STATE_KEY]: { status: "collecting", candidateCount: total, checkedChats: 0 } });

    let processed = 0;
    let aiBatchQueue = [];
    let isFlushing = false;

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

      // If rules say excluded (arbitrage/support) — silently skip, don't add to any list
      if (rulesResult.list === "excluded") {
        console.log(`[FunPay] Skipping #${order.orderId}: ${rulesResult.reason}`);
        return;
      }

      // If AI enabled, queue for batch or classify
      if (useAI) {
        if (useBatchAI) {
          aiBatchQueue.push({ order, chatData, rulesResult });
          if (aiBatchQueue.length >= aiBatchSize && !isFlushing) {
            await flushAiBatch();
          }
          return;
        } else {
          try {
            const aiResult = await callAiClassifier(chatData, aiSettings);
            if (aiResult) {
              if (aiResult.confidence >= aiReviewLow && aiResult.confidence < aiReviewHigh) {
                pendingReview.push({ ...order, aiResult, chatData, rulesResult });
                sendProgressFn({ type: "reviewQueued", orderId: order.orderId, reason: aiResult.reason, confidence: aiResult.confidence });
                return;
              }
              if (aiResult.confidence >= aiThreshold) {
                // AI says excluded → silently skip
                if (aiResult.list === "excluded") {
                  console.log(`[FunPay AI] Skipping #${order.orderId}: ${aiResult.reason}`);
                  return;
                }
                results[aiResult.list].push({ ...order, reason: aiResult.reason, byAI: true, confidence: aiResult.confidence });
                results.aiCount++;
                sendProgressFn({
                  type: "result", list: aiResult.list,
                  entry: { ...order, reason: aiResult.reason, byAI: true, confidence: aiResult.confidence },
                  counts: { clean: results.clean.length, dispute: results.dispute.length, excluded: results.excluded.length }
                });
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
      sendProgressFn({
        type: "result", list: rulesResult.list,
        entry: { ...order, reason: rulesResult.reason, byAI: false },
        counts: { clean: results.clean.length, dispute: results.dispute.length, excluded: results.excluded.length }
      });
    }

    async function flushAiBatch() {
      if (isFlushing || aiBatchQueue.length === 0) return;
      isFlushing = true;
      try {
        const batch = aiBatchQueue.splice(0, aiBatchQueue.length);
        const batchItems = batch.map((item, idx) => ({
          index: idx, orderId: item.order.orderId, chatData: item.chatData
        }));

        try {
          const batchResults = await callAiClassifierBatch(batchItems, aiSettings);
          if (batchResults && batchResults.length > 0) {
            const resultMap = new Map(batchResults.map(r => [r.index, r]));
            for (let i = 0; i < batch.length; i++) {
              const item = batch[i];
              const aiResult = resultMap.get(i);
              if (aiResult && aiResult.confidence >= aiThreshold) {
                // AI says excluded → silently skip
                if (aiResult.list === "excluded") {
                  console.log(`[FunPay AI Batch] Skipping #${item.order.orderId}: ${aiResult.reason}`);
                } else if (aiResult.confidence >= aiReviewLow && aiResult.confidence < aiReviewHigh) {
                  pendingReview.push({ ...item.order, aiResult, chatData: item.chatData, rulesResult: item.rulesResult });
                  sendProgressFn({ type: "reviewQueued", orderId: item.order.orderId, reason: aiResult.reason, confidence: aiResult.confidence });
                } else {
                  results[aiResult.list].push({ ...item.order, reason: aiResult.reason, byAI: true, confidence: aiResult.confidence });
                  results.aiCount++;
                  sendProgressFn({
                    type: "result", list: aiResult.list,
                    entry: { ...item.order, reason: aiResult.reason, byAI: true, confidence: aiResult.confidence },
                    counts: { clean: results.clean.length, dispute: results.dispute.length, excluded: results.excluded.length }
                  });
                }
              } else {
                results[item.rulesResult.list].push({ ...item.order, reason: item.rulesResult.reason, byAI: false });
                results.rulesCount++;
                sendProgressFn({
                  type: "result", list: item.rulesResult.list,
                  entry: { ...item.order, reason: item.rulesResult.reason, byAI: false },
                  counts: { clean: results.clean.length, dispute: results.dispute.length, excluded: results.excluded.length }
                });
              }
            }
          } else {
            for (const item of batch) {
              results[item.rulesResult.list].push({ ...item.order, reason: item.rulesResult.reason, byAI: false });
              results.rulesCount++;
              sendProgressFn({
                type: "result", list: item.rulesResult.list,
                entry: { ...item.order, reason: item.rulesResult.reason, byAI: false },
                counts: { clean: results.clean.length, dispute: results.dispute.length, excluded: results.excluded.length }
              });
            }
          }
        } catch (err) {
          console.warn("[FunPay AI Batch] failed:", err);
          for (const item of batch) {
            results[item.rulesResult.list].push({ ...item.order, reason: item.rulesResult.reason, byAI: false });
            results.rulesCount++;
            sendProgressFn({
              type: "result", list: item.rulesResult.list,
              entry: { ...item.order, reason: item.rulesResult.reason, byAI: false },
              counts: { clean: results.clean.length, dispute: results.dispute.length, excluded: results.excluded.length }
            });
          }
        }
      } finally {
        isFlushing = false;
      }
    }

    // Run workers in parallel
    const queue = [...candidates];
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

    if (useBatchAI && aiBatchQueue.length > 0) {
      await flushAiBatch();
    }

  } catch (err) {
    sendProgressFn({ type: "error", text: `Ошибка: ${err.message}` });
  }

  isRunning = false;
  await new Promise(r => setTimeout(r, 400));

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
window.__funpayListsInjected = true;
console.log("[FunPay Lists] content.js v4.0.0 — real DOM parsers, cursor pagination, multi-order chat, word boundaries, buyer confirmation detection");

} // end injection guard
