const startCheck = document.getElementById("startCheck");
const resumeCheck = document.getElementById("resumeCheck");
const stopCheck = document.getElementById("stopCheck");
const copyLists = document.getElementById("copyLists");
const openDisputes = document.getElementById("openDisputes");
const clearMemory = document.getElementById("clearMemory");
const searchFilter = document.getElementById("searchFilter");
const gameFilter = document.getElementById("gameFilter");
const minPrice = document.getElementById("minPrice");
const onlyAttachments = document.getElementById("onlyAttachments");
const onlyRental = document.getElementById("onlyRental");
const compactMode = document.getElementById("compactMode");
const statusBox = document.getElementById("status");
const results = document.getElementById("results");
const progressBlock = document.getElementById("progressBlock");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");
const previewBlock = document.getElementById("previewBlock");
const copyPreview = document.getElementById("copyPreview");

const START_MESSAGE = "FUNPAY_LISTS_START_V3";
const STOP_MESSAGE = "FUNPAY_LISTS_STOP_V3";
const RESUME_MESSAGE = "FUNPAY_LISTS_RESUME_V3";
const FILTER_ARBITRATION_MESSAGE = "FUNPAY_LISTS_FILTER_ARBITRATION_V1";
const STATE_KEY = "funpayListsState";
const SETTINGS_KEY = "funpayListsSettings";
const MANUAL_KEY = "funpayListsManual";
const HISTORY_KEY = "funpayListsHistory";
const CACHE_KEY = "funpayListsOrderCache";

let lastReport = null;
let manualDecisions = {};

document.addEventListener("DOMContentLoaded", init);
if (new URLSearchParams(location.search).get("embedded") === "1") {
  document.body.classList.add("embedded");
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STATE_KEY]) applyState(changes[STATE_KEY].newValue);
  if (changes[MANUAL_KEY]) manualDecisions = changes[MANUAL_KEY].newValue || {};
  if (changes[HISTORY_KEY]) renderHistory(changes[HISTORY_KEY].newValue || []);
});

for (const input of [searchFilter, gameFilter, minPrice, onlyAttachments, onlyRental, compactMode]) {
  input.addEventListener("input", refreshView);
  input.addEventListener("change", refreshView);
}

startCheck.addEventListener("click", async () => {
  await runCommand(START_MESSAGE, "Запускаю новую проверку...");
});

resumeCheck.addEventListener("click", async () => {
  await runCommand(RESUME_MESSAGE, "Продолжаю проверку...");
});

stopCheck.addEventListener("click", async () => {
  await runCommand(STOP_MESSAGE, "Останавливаю...");
});

copyLists.addEventListener("click", async () => {
  if (!lastReport) return;

  const text = buildCopyText(lastReport);
  showPreview(text);

  const warning = getCopyWarning(lastReport);
  if (warning && !confirm(warning)) return;

  try {
    await copyText(text);
    setStatus("Текст скопирован.");
  } catch (error) {
    setStatus(error.message || "Не удалось скопировать.", true);
  }
});

openDisputes.addEventListener("click", async () => {
  if (!lastReport) return;

  const excluded = (lastReport.excludedOrders || []).filter((order) => order?.url);
  if (!excluded.length) {
    setStatus("В списке арбитража нет заказов с ссылками на чат.");
    return;
  }

  setStatus(`Проверяю чаты на передачу в арбитраж: ${excluded.length}...`);

  let arbitrationOrders = excluded.filter((order) =>
    order.exclusionKind === "arbitration" || order.hasArbitrationParticipant === true
  );

  try {
    const checked = await runMessageOnActiveFunPayTab(FILTER_ARBITRATION_MESSAGE, { orders: excluded });
    if (checked?.ok && Array.isArray(checked.orders)) {
      arbitrationOrders = checked.orders;
    }
  } catch (error) {
    if (!arbitrationOrders.length) throw error;
  }

  if (!arbitrationOrders.length) {
    setStatus("Чатов с сообщением о передаче в арбитраж не найдено.");
    return;
  }

  if (arbitrationOrders.length > 20 && !confirm(`Открыть все чаты, где заказ передан в арбитраж? Количество: ${arbitrationOrders.length}.`)) {
    return;
  }

  for (const order of arbitrationOrders) {
    await chrome.tabs.create({ url: order.url, active: false });
  }
  setStatus(`Открыто чатов с передачей в арбитраж: ${arbitrationOrders.length}.`);
});

clearMemory.addEventListener("click", async () => {
  if (!confirm("Очистить кэш проверок и все ручные решения? Текущие списки останутся на экране.")) return;
  manualDecisions = {};
  await chrome.storage.local.remove([CACHE_KEY, MANUAL_KEY]);
  setStatus("Кэш и ручные решения очищены.");
});

async function init() {
  const data = await chrome.storage.local.get({
    [STATE_KEY]: null,
    [MANUAL_KEY]: {},
    [HISTORY_KEY]: []
  });

  await ensureInternalSettings();
  manualDecisions = data[MANUAL_KEY] || {};
  applyState(data[STATE_KEY]);
  renderHistory(data[HISTORY_KEY] || []);
}

async function ensureInternalSettings() {
  const defaults = {
    delayMs: 1800,
    adaptiveDelay: true,
    pauseEvery: 25,
    pauseMs: 15000,
    blackWords: "",
    whiteWords: ""
  };
  const data = await chrome.storage.local.get({ [SETTINGS_KEY]: defaults });
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...defaults, ...(data[SETTINGS_KEY] || {}) } });
}

async function runCommand(type, text) {
  setStatus(text);

  if (type === START_MESSAGE) {
    await chrome.storage.local.set({
      [STATE_KEY]: {
        status: "starting",
        message: "Запускаю новую проверку...",
        currency: "₽",
        checkedChats: 0,
        candidateCount: 0,
        cleanOrders: [],
        disputeOrders: [],
        excludedOrders: [],
        excludedCount: 0,
        nextIndex: 0,
        orders: [],
        log: [],
        updatedAt: new Date().toISOString()
      }
    });
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("https://funpay.com/")) {
      throw new Error("Откройте страницу FunPay с продажами.");
    }

    const response = await sendTabMessage(tab.id, type);
    if (!response?.ok) throw new Error(response?.error || "Команда не выполнена.");

    if (response.alreadyRunning) setStatus("Проверка уже идет.");
    else if (type === START_MESSAGE) setStatus("Проверка запущена. Панель можно закрыть.");
    else if (type === RESUME_MESSAGE) setStatus("Проверка продолжена.");
    else setStatus("Остановка запрошена.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function runMessageOnActiveFunPayTab(type, payload = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://funpay.com/")) {
    throw new Error("Откройте страницу FunPay.");
  }
  return sendTabMessage(tab.id, type, payload);
}

async function sendTabMessage(tabId, type, payload = {}) {
  const message = { type, ...payload };

  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const messageText = String(error.message || "");
    const canInject = messageText.includes("Receiving end does not exist") ||
      messageText.includes("message port closed") ||
      messageText.includes("Could not establish connection");

    if (!canInject) throw error;

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["ocr.js", "content.js"]
    });

    return chrome.tabs.sendMessage(tabId, message);
  }
}

function applyState(state) {
  if (!state) {
    lastReport = null;
    progressBlock.hidden = true;
    results.hidden = true;
    previewBlock.hidden = true;
    updateButtons("");
    return;
  }

  lastReport = state;
  updateProgress(state);
  render(state);
  updateButtons(state.status);
  setStatus(state.message || getStatusText(state), state.status === "error");
  showPreview(buildCopyText(state));
}

function refreshView() {
  document.body.classList.toggle("compact", Boolean(compactMode.checked));
  if (!lastReport) return;
  render(lastReport);
  showPreview(buildCopyText(lastReport));
}

function updateProgress(state) {
  const total = Number(state.candidateCount || state.orders?.length || 0);
  const checked = Number(state.checkedChats || 0);
  const percent = total > 0 ? Math.min(100, Math.round((checked / total) * 100)) : 0;

  progressBlock.hidden = false;
  progressFill.style.width = `${percent}%`;
  progressText.textContent = total > 0
    ? `Проверено ${checked} из ${total} (${percent}%)`
    : state.status === "running" || state.status === "starting"
      ? "Собираю заказы..."
      : "Нет заказов для проверки";
}

function updateButtons(status) {
  const running = status === "running" || status === "starting" || status === "stopping";
  startCheck.disabled = running;
  resumeCheck.disabled = running;
  stopCheck.disabled = !running;
  copyLists.disabled = !lastReport;
  openDisputes.disabled = !lastReport || running;
  clearMemory.disabled = running;
}

function getStatusText(state) {
  if (state.status === "done") {
    return `Готово. Можно: ${state.cleanOrders?.length || 0}, спорные: ${state.disputeOrders?.length || 0}, арбитраж: ${state.excludedOrders?.length || 0}.`;
  }
  if (state.status === "stopped") return "Проверка остановлена. Можно продолжить.";
  if (state.status === "running") return "Проверка идет. Панель можно закрыть.";
  return "";
}

function render(data) {
  const cleanOrders = getVisibleOrders(data.cleanOrders || []);
  const disputeOrders = getVisibleOrders(data.disputeOrders || []);
  const excludedOrders = getVisibleOrders(data.excludedOrders || []);

  document.getElementById("cleanCount").textContent = String(cleanOrders.length);
  document.getElementById("disputeCount").textContent = String(disputeOrders.length);
  document.getElementById("excludedCount").textContent = String(excludedOrders.length);

  renderList("cleanOrdersBlock", "cleanOrdersList", cleanOrders, "cleanOrders", data.currency);
  renderList("disputeBlock", "disputeList", disputeOrders, "disputeOrders", data.currency);
  renderList("excludedBlock", "excludedList", excludedOrders, "excludedOrders", data.currency);
  renderLog(data.log || []);

  results.hidden = false;
}

function renderHistory(history) {
  const block = document.getElementById("historyBlock");
  const list = document.getElementById("historyList");
  if (!block || !list) return;

  const rows = Array.isArray(history) ? history.slice(0, 5) : [];
  list.textContent = "";
  block.hidden = !rows.length;

  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "history-row";
    li.textContent = `${formatDate(row.at)} | проверено ${row.checkedChats || 0}/${row.candidateCount || 0} | можно ${row.cleanCount || 0}, спорные ${row.disputeCount || 0}, арбитраж ${row.excludedCount || 0}`;
    list.append(li);
  }
}

function renderLog(log) {
  const block = document.getElementById("logBlock");
  const list = document.getElementById("logList");
  if (!block || !list) return;

  const rows = Array.isArray(log) ? log.slice(-20).reverse() : [];
  list.textContent = "";
  block.hidden = !rows.length;

  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "history-row";
    li.textContent = typeof row === "string" ? row : `${formatDate(row.at)} | ${row.text || ""}`;
    list.append(li);
  }
}

function buildCopyText(data) {
  const cleanOrders = getVisibleOrders(data.cleanOrders || []);
  const disputeOrders = getVisibleOrders(data.disputeOrders || []);
  const excludedOrders = getVisibleOrders(data.excludedOrders || []);
  return [
    "Можно просить подтверждение:",
    cleanOrders.length ? cleanOrders.map((order) => formatOrderLine(order, data.currency)).join("\n") : "Нет заказов.",
    "",
    "Спорные, проверить вручную:",
    disputeOrders.length ? disputeOrders.map((order) => formatOrderLine(order, data.currency)).join("\n") : "Нет заказов.",
    "",
    "Исключено арбитражем:",
    excludedOrders.length ? excludedOrders.map((order) => formatOrderLine(order, data.currency)).join("\n") : "Нет заказов."
  ].join("\n");
}

function showPreview(text) {
  copyPreview.textContent = text;
  previewBlock.hidden = false;
}

function formatOrderLine(order, currency) {
  return `#${order.id} | ${formatMoney(order.amount, currency)} | ${getOrderGame(order)}`;
}

function renderList(blockId, listId, rows, listKey, currency) {
  const block = document.getElementById(blockId);
  const list = document.getElementById(listId);
  list.textContent = "";
  block.hidden = !rows.length;

  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "order-row";
    li.title = row.url ? "Открыть заказ в новой вкладке" : "";
    li.addEventListener("click", () => {
      if (row.url) chrome.tabs.create({ url: row.url, active: true });
    });

    const textNode = document.createElement("span");
    textNode.className = "order-row-text";
    textNode.textContent = formatOrderLine(row, currency);

    const actions = document.createElement("span");
    actions.className = "row-actions";
    actions.append(
      makeActionButton("?", "Показать опасные причины", () => toggleReason(li, row)),
      makeActionButton("OK", "В чистые", () => moveOrder(row, "cleanOrders")),
      makeActionButton("SP", "В спорные", () => moveOrder(row, "disputeOrders")),
      makeActionButton("AR", "В арбитраж", () => moveOrder(row, "excludedOrders")),
      makeActionButton("x", "Убрать из списков", () => moveOrder(row, "removed"))
    );

    li.append(textNode, actions);
    list.append(li);
  }
}

function makeActionButton(text, title, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "row-action";
  button.title = title;
  button.textContent = text;
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await handler();
  });
  return button;
}

function toggleReason(rowNode, order) {
  const existing = rowNode.querySelector(".danger-reason");
  if (existing) {
    existing.remove();
    return;
  }

  const reason = document.createElement("div");
  reason.className = "danger-reason";
  reason.textContent = buildDangerReason(order);
  rowNode.append(reason);
}

function buildDangerReason(order) {
  const reasons = [];
  if (order.reason) reasons.push(order.reason);
  if (order.hasAttachment) reasons.push("есть вложение или скриншот");
  if (order.ocrText) reasons.push(`OCR: ${order.ocrText}`);
  if (order.lastRole === "buyer") reasons.push("последнее сообщение от покупателя");
  if (order.manual) reasons.push("ручное решение");
  if (order.cached) reasons.push("взято из кэша");
  if (order.hasWarning) reasons.push("есть сомнительный признак");
  return reasons.length ? reasons.join("; ") : "Опасных причин не сохранено.";
}

function getVisibleOrders(orders) {
  const search = normalizeFilter(searchFilter.value);
  const game = normalizeFilter(gameFilter.value);
  const min = Number(minPrice.value || 0);

  return [...(orders || [])]
    .filter((order) => {
      if (game && !normalizeFilter(getOrderGame(order)).includes(game)) return false;
      if (min > 0 && Number(order.amount || 0) < min) return false;
      if (onlyAttachments.checked && !order.hasAttachment) return false;
      if (onlyRental.checked && !order.isRental) return false;
      if (!search) return true;

      return normalizeFilter([
        order.id,
        order.buyer,
        order.title,
        order.subtitle,
        getOrderGame(order),
        order.amount
      ].filter(Boolean).join(" ")).includes(search);
    })
    .sort((a, b) =>
      (Number(b.amount) || 0) - (Number(a.amount) || 0) ||
      String(getOrderGame(a)).localeCompare(String(getOrderGame(b)), "ru") ||
      String(a.id || "").localeCompare(String(b.id || ""), "ru")
    );
}

async function moveOrder(order, targetKey) {
  if (!lastReport) return;

  const nextState = {
    ...lastReport,
    cleanOrders: removeFrom(lastReport.cleanOrders, order),
    disputeOrders: removeFrom(lastReport.disputeOrders, order),
    excludedOrders: removeFrom(lastReport.excludedOrders, order),
    updatedAt: new Date().toISOString()
  };

  if (targetKey !== "removed") {
    nextState[targetKey] = sortOrders([...(nextState[targetKey] || []), { ...order, manual: true }]);
  }

  nextState.excludedCount = nextState.excludedOrders.length;
  lastReport = nextState;

  const manualKey = getOrderKey(order);
  if (manualKey) {
    manualDecisions = { ...manualDecisions, [manualKey]: targetKey };
    await chrome.storage.local.set({ [MANUAL_KEY]: manualDecisions });
  }

  await chrome.storage.local.set({ [STATE_KEY]: nextState });
  render(nextState);
  showPreview(buildCopyText(nextState));
}

function removeFrom(orders, order) {
  return (orders || []).filter((item) => !isSameOrder(item, order));
}

function isSameOrder(a, b) {
  return Boolean(a && b) && (
    (a.id && b.id && a.id === b.id) ||
    (a.url && b.url && a.url === b.url)
  );
}

function getCopyWarning(data) {
  const cleanOrders = getVisibleOrders(data.cleanOrders || []);
  const risky = cleanOrders.filter((order) =>
    order.hasWarning || order.hasAttachment || order.manual || order.lastRole === "buyer"
  );

  if (!risky.length) return "";
  return `В первом списке есть ${risky.length} заказ(ов) с ручной меткой, вложением или сомнительным признаком. Все равно скопировать?`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  if (!ok) throw new Error("Браузер заблокировал копирование.");
}

function setStatus(text, isError = false) {
  statusBox.textContent = text || "";
  statusBox.classList.toggle("error", Boolean(isError));
}

function getOrderGame(order) {
  return order.game || order.subtitle?.split(",")[0]?.trim() || order.title || "Без названия";
}

function getOrderKey(order) {
  return order?.id || order?.url || "";
}

function normalizeFilter(value) {
  return String(value || "").trim().toLowerCase();
}

function formatMoney(value, currency) {
  const rounded = Math.round((Number(value) || 0) * 100) / 100;
  return `${rounded.toLocaleString("ru-RU")} ${currency || "₽"}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "без даты";
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function sortOrders(orders) {
  return [...(orders || [])].sort((a, b) =>
    (Number(b.amount) || 0) - (Number(a.amount) || 0) ||
    String(b.dateIso || "").localeCompare(String(a.dateIso || ""))
  );
}
