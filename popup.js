
// ============================================================
// AI Storage Constants
// ============================================================
const AI_STORAGE_KEY = "funpayListsAI";
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

// ============================================================
// Existing constants (preserved)
// ============================================================
const SETTINGS_KEY = "funpayListsSettings";
const STATE_KEY = "funpayListsState";
const MANUAL_KEY = "funpayListsManual";

// ============================================================
// Helpers
// ============================================================
function getEl(id) {
  return document.getElementById(id);
}

// ============================================================
// AI Settings Functions
// ============================================================
async function loadAiSettings() {
  const stored = await chrome.storage.local.get([AI_STORAGE_KEY]);
  const ai = stored[AI_STORAGE_KEY] || { enabled: false, apiKey: "", rules: AI_DEFAULT_RULES, model: "moonshotai/kimi-k2.6" };
  const enabledEl = getEl("aiEnabled");
  const keyEl = getEl("aiApiKey");
  const rulesEl = getEl("aiRules");
  const modelEl = getEl("aiModel");
  if (enabledEl) enabledEl.checked = ai.enabled;
  if (keyEl) keyEl.value = ai.apiKey || "";
  if (rulesEl) rulesEl.value = ai.rules || AI_DEFAULT_RULES;
  if (modelEl) modelEl.value = ai.model || "moonshotai/kimi-k2.6";
}

async function saveAiSettings() {
  const ai = {
    enabled: getEl("aiEnabled")?.checked ?? false,
    apiKey: getEl("aiApiKey")?.value?.trim() ?? "",
    rules: getEl("aiRules")?.value?.trim() || AI_DEFAULT_RULES,
    model: getEl("aiModel")?.value?.trim() || "moonshotai/kimi-k2.6"
  };
  await chrome.storage.local.set({ [AI_STORAGE_KEY]: ai });
}

async function saveAiExample(order, targetList) {
  // Only save if order has meaningful chat text
  const chatText = order.reason || order.ocrText || order.title || "";
  if (!chatText && !order.game) return;

  const listMap = { cleanOrders: "clean", disputeOrders: "dispute", excludedOrders: "excluded" };
  const list = listMap[targetList];
  if (!list) return;

  const stored = await chrome.storage.local.get([AI_EXAMPLES_KEY]);
  const examples = stored[AI_EXAMPLES_KEY] || [];

  // Don't duplicate same order
  const orderKey = order.id || order.url;
  const exists = examples.some((ex) => ex.orderKey === orderKey);
  if (exists) {
    // Update existing
    const idx = examples.findIndex((ex) => ex.orderKey === orderKey);
    examples[idx] = { ...examples[idx], list, reason: order.reason || "" };
  } else {
    examples.push({
      orderKey,
      chatText: [order.reason, order.ocrText, order.title, order.game].filter(Boolean).join(" | "),
      productText: order.game || "",
      list,
      reason: order.reason || "",
      savedAt: Date.now()
    });
  }

  // Keep only last AI_MAX_EXAMPLES
  const trimmed = examples.slice(-AI_MAX_EXAMPLES);
  await chrome.storage.local.set({ [AI_EXAMPLES_KEY]: trimmed });
}

async function getAiExamplesCount() {
  const stored = await chrome.storage.local.get([AI_EXAMPLES_KEY]);
  return (stored[AI_EXAMPLES_KEY] || []).length;
}

// ============================================================
// Settings load/save
// ============================================================
async function loadSettingsUI() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  const settings = stored[SETTINGS_KEY] || {};
  // Populate settings fields if they exist in the DOM
  Object.keys(settings).forEach((key) => {
    const el = getEl(key);
    if (!el) return;
    if (el.type === "checkbox") el.checked = !!settings[key];
    else el.value = settings[key];
  });
}

async function saveSettingsFromUI() {
  const settings = {};
  document.querySelectorAll("[data-setting]").forEach((el) => {
    const key = el.dataset.setting;
    if (el.type === "checkbox") settings[key] = el.checked;
    else settings[key] = el.value;
  });
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  await saveAiSettings();
  const savedEl = getEl("settingsSaved");
  if (savedEl) {
    savedEl.textContent = "✓ Настройки сохранены";
    setTimeout(() => { savedEl.textContent = ""; }, 2000);
  }
}

// ============================================================
// Move order
// ============================================================
async function moveOrder(order, targetKey) {
  const stored = await chrome.storage.local.get([STATE_KEY, MANUAL_KEY]);
  const state = stored[STATE_KEY] || { cleanOrders: [], disputeOrders: [], excludedOrders: [] };
  const manual = stored[MANUAL_KEY] || {};

  // Remove from all lists
  ["cleanOrders", "disputeOrders", "excludedOrders"].forEach((key) => {
    state[key] = (state[key] || []).filter((o) => (o.id || o.url) !== (order.id || order.url));
  });

  // Add to target list
  if (!state[targetKey]) state[targetKey] = [];
  state[targetKey].push(order);

  // Mark as manually assigned
  manual[order.id || order.url] = targetKey;

  await chrome.storage.local.set({ [STATE_KEY]: state, [MANUAL_KEY]: manual });

  // Save as AI training example
  await saveAiExample(order, targetKey);
}

// ============================================================
// Init
// ============================================================
async function init() {
  await loadSettingsUI();
  await loadAiSettings();

  // Update AI examples count display
  const count = await getAiExamplesCount();
  const countEl = getEl("aiExamplesCount");
  if (countEl) countEl.textContent = `Накоплено примеров: ${count}`;

  // Render state
  const stored = await chrome.storage.local.get([STATE_KEY]);
  const state = stored[STATE_KEY] || { cleanOrders: [], disputeOrders: [], excludedOrders: [] };
  renderLists(state);
}

// ============================================================
// Render
// ============================================================
function renderLists(state) {
  renderList("cleanList", state.cleanOrders || [], "cleanOrders");
  renderList("disputeList", state.disputeOrders || [], "disputeOrders");
  renderList("excludedList", state.excludedOrders || [], "excludedOrders");
}

function renderList(containerId, orders, currentKey) {
  const container = getEl(containerId);
  if (!container) return;
  container.innerHTML = "";
  if (!orders.length) {
    container.innerHTML = "<div class='empty'>Пусто</div>";
    return;
  }
  orders.forEach((order) => {
    const div = document.createElement("div");
    div.className = "order-item";
    div.innerHTML = `<span class="order-title">${order.title || order.game || order.id || "—"}</span>`;

    const keys = ["cleanOrders", "disputeOrders", "excludedOrders"];
    const labels = ["✅", "⚠️", "🚫"];
    keys.forEach((key, i) => {
      if (key === currentKey) return;
      const btn = document.createElement("button");
      btn.textContent = labels[i];
      btn.title = key;
      btn.addEventListener("click", async () => {
        await moveOrder(order, key);
        const s = await chrome.storage.local.get([STATE_KEY]);
        renderLists(s[STATE_KEY] || {});
      });
      div.appendChild(btn);
    });

    container.appendChild(div);
  });
}

// ============================================================
// Event Listeners
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  init();

  getEl("saveSettings")?.addEventListener("click", saveSettingsFromUI);

  getEl("clearAiExamples")?.addEventListener("click", async () => {
    await chrome.storage.local.remove(AI_EXAMPLES_KEY);
    const countEl = getEl("aiExamplesCount");
    if (countEl) countEl.textContent = "Накоплено примеров: 0";
    const savedEl = getEl("settingsSaved");
    if (savedEl) {
      savedEl.textContent = "✓ Примеры очищены";
      setTimeout(() => { savedEl.textContent = ""; }, 2000);
    }
  });

  getEl("refreshBtn")?.addEventListener("click", async () => {
    const stored = await chrome.storage.local.get([STATE_KEY]);
    renderLists(stored[STATE_KEY] || {});
  });
});
