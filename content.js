(function () {
const CONTENT_VERSION = "2.6.4";
const START_MESSAGE = "FUNPAY_LISTS_START_V3";
const STOP_MESSAGE = "FUNPAY_LISTS_STOP_V3";
const RESUME_MESSAGE = "FUNPAY_LISTS_RESUME_V3";
const OPEN_PANEL_MESSAGE = "FUNPAY_LISTS_OPEN_PANEL_V1";
const FILTER_ARBITRATION_MESSAGE = "FUNPAY_LISTS_FILTER_ARBITRATION_V1";
const STATE_KEY = "funpayListsState";
const SETTINGS_KEY = "funpayListsSettings";
const CACHE_KEY = "funpayListsOrderCache";
const MANUAL_KEY = "funpayListsManual";
const HISTORY_KEY = "funpayListsHistory";
const MAX_PAGES = 100;
const CACHE_LIMIT = 350;
const STORAGE_CACHE_LIMIT = 700;
const STORAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [2500, 6000, 12000, 20000];

if (window.__funpayConfirmationListsVersion === CONTENT_VERSION) return;
window.__funpayConfirmationListsVersion = CONTENT_VERSION;

const documentCache = new Map();
let currentRun = null;
let lastFetchAt = 0;
let resumeTimer = 0;

const ARBITRATION_PATTERNS = [
  /арбитраж/i,
  /поддержка/i,
  /заказ\s+передан\s+на\s+рассмотрение/i,
  /поступил\s+запрос\s+на\s+отмену\s+заказа/i,
  /ответственный\s+сотрудник\s+присоедин/i,
  /возникла\s+спорная\s+ситуация/i,
  /назначили\s+ответственной\s+за\s+(?:её|ее)\s+разрешение/i,
  /общение\s+по\s+спору/i,
  /сотрудник\s+(?:funpay|поддержки|арбитража)\s+присоедини/i,
  /модератор\s+присоедини|администратор\s+присоедини/i
];

const ARBITRATION_ONLY_PATTERNS = [
  /арбитраж/i,
  /arbitration/i,
  /ответственн(?:ый|ая)\s+сотрудник\s+присоедини/i,
  /возникла\s+спорная\s+ситуация/i,
  /назначили\s+ответственной\s+за\s+(?:ее|её)\s+разрешение/i,
  /общение\s+по\s+спору/i,
  /решение\s+споров/i
];

const STAFF_ROLE_PATTERNS = [
  /(?:^|\s)(?:поддержка|арбитраж)(?:\s|$)/i,
  /funpay\s*(?:support|arbitration)/i,
  /support|arbitration/i
];

const DISPUTE_PATTERNS = [
  { re: /жалоб[ауы]|пожалуюсь|жаловаться/i, reason: "претензия покупателя" },
  { re: /спор|поддержк[аеуи]|модератор|администратор/i, reason: "покупатель упоминал спор или поддержку" },
  { re: /не\s+(?:получил|получила|получили|пришел|пришла|пришло|приходит|выдали|выдал|дали|дошло|выдан|выдано)|товар\s+не\s+выдан|ничего\s+не\s+(?:пришло|дали|получил)/i, reason: "товар не получен или не выдан" },
  { re: /товар\s+не\s+(?:тот|подходит|работает)|не\s+тот\s+(?:товар|аккаунт|код|логин)|неверн(?:ый|ая|ое)|ошибочн(?:ый|ая|ое)/i, reason: "покупатель недоволен товаром" },
  { re: /не\s+работа(?:ет|ют)|ошибк[аиу]|баг|проблем[аыу]?|не\s+запуска(?:ется|ются)|не\s+получается|не\s+активен|заблокирован|blocked|inactive|e111/i, reason: "проблема с использованием товара" },
  { re: /как\s+(?:использовать|зайти|войти|активировать|установить|получить|делать)|что\s+делать|нужна\s+помощь|и\s+как\s+это\s+делать|куда\s+(?:ее|это|его)\s+вводить/i, reason: "важный вопрос по использованию" },
  { re: /нужен\s+[^.!?\n]{0,80}(?:сет|сетик|товар|код|аккаунт|доступ|помощ)|сдела(?:й|йте)\s+[^.!?\n]{0,80}(?:сет|заказ|товар)/i, reason: "покупатель просил выдать или собрать товар" },
  { re: /(?:где|почему|какой|куда)\s+(?:ответ|товар|данные|код|аккаунт|пароль|команд[ау])|пароль\s+какой|код\s+какой|ответьте|жду\s+ответ|вы\s+не\s+отвеча(?:ете|ешь)|уже\s+целый\s+день/i, reason: "покупатель ждет важный ответ" },
  { re: /не\s+соглас(?:ен|на|ны)|меня\s+не\s+устраива(?:ет|ют)|я\s+недовол(?:ен|ьна|ьны)|ты\s+ч[ео]|это\s+что|не\s+понимаю|непонятно|неверный/i, reason: "покупатель не согласен или недоволен" },
  { re: /верн(?:ите|и)\s+деньги|возврат|вернул\s+деньги|ожидайте\s+возврата|рефанд|refund|money\s+back/i, reason: "возврат или запрос возврата" },
  { re: /обман|скам|scam|fraud|cheat/i, reason: "обвинение в обмане" },
  { re: /!помощь|!ак|!cd|\?\?\?/i, reason: "покупатель запрашивал помощь или код" },
  { re: /order\s+(?:dispute|complaint)|not\s+(?:received|working)|does\s+not\s+work|no\s+answer/i, reason: "английская претензия в чате" }
];

const SERVICE_RENDERED_PATTERNS = [
  /товар\s+(?:выдан|получен|передан)/i,
  /заказ\s+выполнен/i,
  /услуг[аи]\s+оказан[аы]?/i,
  /данные\s+(?:выданы|отправлены|переданы)/i,
  /логин|пароль|аккаунт|почта|email|e-mail/i,
  /код\s+(?:подтверждения|выдан|отправлен)|\b\d{4,8}\b/i,
  /спасибо|спс|благодарю|получил|получила|все\s+(?:работает|ок|хорошо|нормально)|зашел|зашла/i,
  /автовыдач[ауы]|авто-?код/i
];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === START_MESSAGE) {
    startFreshRun().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === RESUME_MESSAGE) {
    resumeRun().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === STOP_MESSAGE) {
    stopRun().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === OPEN_PANEL_MESSAGE) {
    openPanel();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === FILTER_ARBITRATION_MESSAGE) {
    filterArbitrationChats(message.orders || []).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STATE_KEY]) return;
  highlightOrders(changes[STATE_KEY].newValue || createState());
});

installHighlightObserver();
installPanelButton();
installGameSelectSearch();
recoverInterruptedRun();

function openPanel() {
  let host = document.getElementById("funpay-lists-panel-host");
  if (host) {
    host.hidden = false;
    host.querySelector("iframe")?.focus();
    return;
  }

  host = document.createElement("div");
  host.id = "funpay-lists-panel-host";
  host.innerHTML = `
    <div class="funpay-lists-panel-backdrop"></div>
    <section class="funpay-lists-panel" role="dialog" aria-label="FunPay Lists">
      <header class="funpay-lists-panel-head">
        <strong>FunPay Lists</strong>
        <button type="button" class="funpay-lists-panel-close" aria-label="Закрыть">x</button>
      </header>
      <iframe title="FunPay Lists" src="${chrome.runtime.getURL("popup.html?embedded=1")}"></iframe>
    </section>
  `;

  ensurePanelStyle();
  document.documentElement.append(host);
  host.querySelector(".funpay-lists-panel-close").addEventListener("click", () => {
    host.hidden = true;
  });
  host.querySelector(".funpay-lists-panel-backdrop").addEventListener("click", () => {
    host.hidden = true;
  });
}

function installPanelButton() {
  if (document.getElementById("funpay-lists-open-button")) return;

  const button = document.createElement("button");
  button.id = "funpay-lists-open-button";
  button.type = "button";
  button.textContent = "Lists";
  button.title = "Открыть FunPay Lists";
  button.addEventListener("click", openPanel);

  ensurePanelStyle();
  document.documentElement.append(button);
}

function ensurePanelStyle() {
  if (document.getElementById("funpay-lists-panel-style")) return;

  const style = document.createElement("style");
  style.id = "funpay-lists-panel-style";
  style.textContent = `
    #funpay-lists-open-button {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483645;
      height: 42px;
      min-width: 72px;
      border: 0;
      border-radius: 10px;
      color: #06101d;
      background: linear-gradient(135deg, #58d7ff, #b985ff);
      font: 800 14px Arial, sans-serif;
      box-shadow: 0 12px 34px rgba(0, 0, 0, .35);
      cursor: pointer;
    }
    #funpay-lists-panel-host {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
    }
    #funpay-lists-panel-host[hidden] {
      display: none !important;
    }
    .funpay-lists-panel-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, .48);
    }
    .funpay-lists-panel {
      position: absolute;
      left: 50%;
      top: 50%;
      width: min(920px, calc(100vw - 32px));
      height: min(760px, calc(100vh - 32px));
      transform: translate(-50%, -50%);
      overflow: hidden;
      border: 1px solid rgba(117, 214, 255, .18);
      border-radius: 10px;
      background: #080d17;
      box-shadow: 0 28px 90px rgba(0, 0, 0, .55);
    }
    .funpay-lists-panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 58px;
      padding: 0 18px 0 24px;
      color: #fff;
      background: #101421;
      border-bottom: 1px solid rgba(255, 255, 255, .08);
      font: 800 22px Arial, sans-serif;
    }
    .funpay-lists-panel-close {
      width: 38px;
      height: 38px;
      border: 0;
      border-radius: 999px;
      color: #cbd5e1;
      background: rgba(255, 255, 255, .08);
      font: 700 20px Arial, sans-serif;
      cursor: pointer;
    }
    .funpay-lists-panel iframe {
      display: block;
      width: 100%;
      height: calc(100% - 58px);
      border: 0;
      background: #080d17;
    }
  `;
  document.documentElement.append(style);
}

function installGameSelectSearch() {
  let timer = 0;
  const enhance = () => {
    const select = findSalesGameSelect();
    if (!select || select.dataset.funpayGameSearch === "1") return;
    enhanceSalesGameSelect(select);
  };

  enhance();
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(enhance, 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function findSalesGameSelect() {
  if (!/\/orders\/trade/.test(location.pathname)) return null;

  const selects = Array.from(document.querySelectorAll("select")).filter((select) =>
    !select.closest("#funpay-lists-panel-host") && select.options.length >= 8
  );

  let best = null;
  let bestScore = 0;

  for (const select of selects) {
    const optionText = Array.from(select.options).map((option) => option.textContent || "").join(" ");
    const firstOption = select.options[0]?.textContent || "";
    const attrs = `${select.name || ""} ${select.id || ""} ${select.className || ""}`;
    const source = normalize(`${attrs} ${firstOption} ${optionText}`).toLowerCase();
    let score = 0;

    if (/игра|game/.test(source)) score += 4;
    if (/minecraft|netflix|steam|gta|roblox/i.test(optionText)) score += 3;
    if (select.offsetParent) score += 1;
    if (select.closest("form")) score += 1;

    if (score > bestScore) {
      best = select;
      bestScore = score;
    }
  }

  return bestScore >= 4 ? best : null;
}

function enhanceSalesGameSelect(select) {
  select.dataset.funpayGameSearch = "1";
  ensureGameSelectSearchStyle();

  const wrapper = document.createElement("div");
  wrapper.className = "funpay-game-search";
  wrapper.style.width = select.offsetWidth ? `${select.offsetWidth}px` : "";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "funpay-game-search-button";

  const label = document.createElement("span");
  label.className = "funpay-game-search-label";

  const arrow = document.createElement("span");
  arrow.className = "funpay-game-search-arrow";
  arrow.textContent = "▾";

  button.append(label, arrow);

  const dropdown = document.createElement("div");
  dropdown.className = "funpay-game-search-dropdown";
  dropdown.hidden = true;

  const search = document.createElement("input");
  search.type = "search";
  search.className = "funpay-game-search-input";
  search.placeholder = "Поиск игры";
  search.autocomplete = "off";

  const list = document.createElement("div");
  list.className = "funpay-game-search-list";

  dropdown.append(search, list);
  wrapper.append(button, dropdown);
  select.insertAdjacentElement("afterend", wrapper);
  select.classList.add("funpay-game-search-native");

  const updateLabel = () => {
    label.textContent = select.options[select.selectedIndex]?.textContent?.trim() || "Игра";
  };

  const close = () => {
    dropdown.hidden = true;
    wrapper.classList.remove("is-open");
  };

  const choose = (option) => {
    if (!option) return;
    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    updateLabel();
    close();
    button.focus();
  };

  const render = () => {
    const query = normalize(search.value).toLowerCase();
    const options = Array.from(select.options).filter((option) =>
      !query || normalize(option.textContent || "").toLowerCase().includes(query)
    );

    list.replaceChildren();

    if (!options.length) {
      const empty = document.createElement("div");
      empty.className = "funpay-game-search-empty";
      empty.textContent = "Ничего не найдено";
      list.append(empty);
      return;
    }

    for (const option of options) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "funpay-game-search-option";
      item.textContent = option.textContent || "";
      item.dataset.value = option.value;
      if (option.value === select.value) item.classList.add("is-selected");
      item.addEventListener("click", () => choose(option));
      list.append(item);
    }
  };

  const open = () => {
    wrapper.style.width = select.offsetWidth ? `${select.offsetWidth}px` : wrapper.style.width;
    dropdown.hidden = false;
    wrapper.classList.add("is-open");
    search.value = "";
    render();
    requestAnimationFrame(() => search.focus());
  };

  button.addEventListener("click", () => {
    if (dropdown.hidden) open();
    else close();
  });

  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });

  search.addEventListener("input", render);
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const first = list.querySelector(".funpay-game-search-option");
      if (first) {
        const option = Array.from(select.options).find((item) => item.value === first.dataset.value);
        choose(option);
      }
    }
  });

  document.addEventListener("click", (event) => {
    if (!wrapper.contains(event.target)) close();
  });

  select.addEventListener("change", updateLabel);
  updateLabel();
}

function ensureGameSelectSearchStyle() {
  if (document.getElementById("funpay-game-search-style")) return;

  const style = document.createElement("style");
  style.id = "funpay-game-search-style";
  style.textContent = `
    .funpay-game-search-native {
      position: absolute !important;
      width: 1px !important;
      height: 1px !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }
    .funpay-game-search {
      position: relative;
      display: inline-block;
      min-width: 220px;
      vertical-align: top;
      z-index: 20;
    }
    .funpay-game-search-button {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      min-height: 38px;
      padding: 0 12px;
      border: 0;
      border-radius: 8px;
      color: #f8fafc;
      background: #030507;
      font: 700 14px Arial, sans-serif;
      text-align: left;
      cursor: pointer;
    }
    .funpay-game-search-label {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .funpay-game-search-arrow {
      flex: 0 0 auto;
      margin-left: 10px;
      color: #cbd5e1;
      font-size: 12px;
    }
    .funpay-game-search-dropdown {
      position: absolute;
      left: 0;
      right: 0;
      top: calc(100% + 4px);
      z-index: 2147483644;
      overflow: hidden;
      border: 1px solid rgba(125, 211, 252, .32);
      border-radius: 8px;
      background: #02060c;
      box-shadow: 0 18px 45px rgba(0, 0, 0, .5);
    }
    .funpay-game-search-input {
      display: block;
      width: calc(100% - 16px);
      margin: 8px;
      height: 34px;
      padding: 0 10px;
      border: 1px solid rgba(125, 211, 252, .35);
      border-radius: 7px;
      color: #f8fafc;
      background: #07111d;
      outline: none;
      font: 700 14px Arial, sans-serif;
    }
    .funpay-game-search-input:focus {
      border-color: #67e8f9;
      box-shadow: 0 0 0 2px rgba(103, 232, 249, .16);
    }
    .funpay-game-search-list {
      max-height: 360px;
      overflow-y: auto;
      padding: 2px 0 6px;
    }
    .funpay-game-search-option,
    .funpay-game-search-empty {
      display: block;
      width: 100%;
      min-height: 28px;
      padding: 5px 14px;
      border: 0;
      color: #f8fafc;
      background: transparent;
      font: 400 14px Arial, sans-serif;
      text-align: left;
    }
    .funpay-game-search-option {
      cursor: pointer;
    }
    .funpay-game-search-option:hover,
    .funpay-game-search-option.is-selected {
      background: rgba(96, 165, 250, .24);
    }
    .funpay-game-search-empty {
      color: #94a3b8;
    }
  `;
  document.documentElement.append(style);
}

function recoverInterruptedRun() {
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(async () => {
    const state = await getState();
    if (!state || currentRun?.status === "running") return;

    if (state.status === "stopping") {
      await saveState({
        ...state,
        status: "stopped",
        message: "Проверка остановлена после перезагрузки страницы.",
        updatedAt: nowIso()
      });
      return;
    }

    if ((state.status === "running" || state.status === "starting") && location.href.includes("/orders")) {
      await resumeRun();
    }
  }, 4500);
}

async function startFreshRun() {
  if (currentRun?.status === "running") return { ok: true, alreadyRunning: true };

  const runId = makeRunId();
  currentRun = { id: runId, status: "running", stopRequested: false };
  documentCache.clear();

  await saveState(createState({
    runId,
    status: "running",
    message: "Собираю заказы..."
  }));

  runFromScratch(runId).catch((error) => failRun(error));
  return { ok: true };
}

async function resumeRun() {
  if (currentRun?.status === "running") return { ok: true, alreadyRunning: true };

  const state = await getState();
  if (!state?.orders?.length) return startFreshRun();

  const runId = state.runId || makeRunId();
  currentRun = { id: runId, status: "running", stopRequested: false };

  await saveState({
    ...state,
    runId,
    status: "running",
    message: `Продолжаю с ${Number(state.nextIndex || 0) + 1} заказа...`,
    updatedAt: nowIso()
  });

  runExisting(state, runId).catch((error) => failRun(error));
  return { ok: true };
}

async function stopRun() {
  if (currentRun) currentRun.stopRequested = true;
  const state = await getState();
  if (state) {
    await saveState({
      ...state,
      status: "stopping",
      message: "Останавливаю после текущего заказа...",
      updatedAt: nowIso()
    });
  }
  return { ok: true };
}

async function runFromScratch(runId) {
  const pages = await loadOrderPages();
  const allOrders = dedupeOrders(pages.flatMap((page) => parseOrders(page.doc, page.url)));
  const orders = allOrders.filter(isListCandidate);
  const currency = orders.find((order) => order.currency)?.currency || "₽";
  const state = createState({
    runId,
    status: "running",
    message: orders.length ? "Проверяю чаты..." : "Неподтвержденные оплаченные заказы не найдены.",
    totalOrdersFound: allOrders.length,
    candidateCount: orders.length,
    currency,
    orders,
    nextIndex: 0
  });

  await saveState(state);
  await runExisting(state, runId);
}

async function runExisting(initialState, runId) {
  const state = normalizeState(initialState, runId);
  const orders = state.orders || [];

  for (let i = Number(state.nextIndex || 0); i < orders.length; i += 1) {
    const settings = await getSettings();
    if (currentRun?.stopRequested) {
      await saveState({
        ...state,
        status: "stopped",
        message: `Остановлено. Проверено ${state.checkedChats || 0} из ${orders.length}.`,
        nextIndex: i,
        updatedAt: nowIso()
      });
      currentRun = null;
      return;
    }

    const order = orders[i];
    const updated = await classifyOne(order, state);
    Object.assign(state, updated, {
      checkedChats: Number(state.checkedChats || 0) + 1,
      nextIndex: i + 1,
      effectiveDelayMs: settings.delayMs,
      message: `Проверено ${Number(state.checkedChats || 0) + 1} из ${orders.length}`,
      updatedAt: nowIso()
    });

    state.cleanOrders = sortOrders(state.cleanOrders);
    state.disputeOrders = sortOrders(state.disputeOrders);
    state.excludedOrders = sortOrders(state.excludedOrders);
    state.excludedCount = state.excludedOrders.length;

    await updateOrderCacheFromState(state);
    await saveState(state);
    highlightOrders(state);

    if (settings.pauseEvery > 0 && state.checkedChats > 0 && state.checkedChats % settings.pauseEvery === 0 && i < orders.length - 1) {
      await saveState({
        ...state,
        message: `Пауза ${Math.round(settings.pauseMs / 1000)} сек. Проверено ${state.checkedChats} из ${orders.length}.`,
        updatedAt: nowIso()
      });
      await sleep(settings.pauseMs);
    }
  }

  await saveHistory(state);
  await saveState({
    ...state,
    status: "done",
    message: `Готово. Проверено ${state.checkedChats || 0} из ${orders.length}.`,
    updatedAt: nowIso()
  });
  highlightOrders(state);
  currentRun = null;
}

async function filterArbitrationChats(orders) {
  const settings = await getSettings();
  const result = [];
  for (const order of orders || []) {
    if (!order?.url) continue;
    try {
      const doc = await fetchDocument(order.url, true, true, settings.delayMs);
      const chat = await analyzeChat(doc, order, settings);
      if (chat.arbitrationOnly) {
        result.push({ ...order, exclusionKind: "arbitration", hasArbitrationParticipant: true });
      }
    } catch (_error) {
      if (order.exclusionKind === "arbitration" || order.hasArbitrationParticipant === true) {
        result.push(order);
      }
    }
  }
  return { ok: true, orders: result };
}

async function classifyOne(order, state) {
  try {
    const manualDecision = await getManualDecision(order);
    if (manualDecision) {
      return applyDecision(order, state, manualDecision, { manual: true });
    }

    const cachedDecision = await getCachedDecision(order);
    if (cachedDecision) {
      return applyDecision(order, state, cachedDecision.listKey, { ...cachedDecision.order, cached: true });
    }

    const settings = await getSettings();
    const doc = await fetchDocument(order.url, true, true, settings.delayMs);
    const chat = await analyzeChat(doc, order, settings);
    const serialized = {
      ...serializeOrder(order),
      hasAttachment: chat.buyerAttachment || chat.sellerAttachment,
      hasWarning: Boolean(chat.disputeReason || (chat.buyerAttachment && !chat.sellerAttachment) || chat.lastRole === "buyer"),
      isRental: Boolean(chat.rental?.isRental),
      exclusionKind: chat.arbitrationOnly ? "arbitration" : (chat.hasArbitration ? "staff" : ""),
      hasArbitrationParticipant: Boolean(chat.arbitrationOnly),
      lastRole: chat.lastRole,
      ocrText: chat.ocrText
    };

    if (chat.hasArbitration) {
      // Calculate days since arbitration joined the chat
      const arbitrationJoinedAt = chat.lastStaffDate ? new Date(chat.lastStaffDate) : null;
      const daysSinceArbitration = arbitrationJoinedAt
        ? Math.floor((Date.now() - arbitrationJoinedAt.getTime()) / (1000 * 60 * 60 * 24))
        : null;

      return {
        excludedOrders: [...state.excludedOrders, {
          ...serialized,
          reason: chat.arbitrationOnly ? "в чате участвовал арбитраж" : "в чате участвовала поддержка или модерация",
          lastStaffText: chat.lastStaffText || "",
          lastStaffDate: chat.lastStaffDate ? chat.lastStaffDate.toISOString() : "",
          daysSinceArbitration: daysSinceArbitration !== null ? daysSinceArbitration : ""
        }]
      };
    }

    if (chat.rental.isRental) {
      if (!chat.rental.codeReceivedAt) {
        return {
          disputeOrders: [...state.disputeOrders, { ...serialized, reason: "аренда: покупатель не получил код для входа" }]
        };
      }

      if (!chat.rental.durationMs) {
        return {
          disputeOrders: [...state.disputeOrders, { ...serialized, reason: "аренда: не удалось определить срок аренды" }]
        };
      }

      if (chat.rental.isActive) {
        return {};
      }

      return {
        cleanOrders: [...state.cleanOrders, { ...serialized, rentalExpiredAt: chat.rental.expiresAt }]
      };
    }

    if (chat.disputeReason) {
      return {
        disputeOrders: [...state.disputeOrders, { ...serialized, reason: chat.disputeReason }]
      };
    }

    if (chat.buyerAttachment && !chat.sellerAttachment) {
      return {
        disputeOrders: [...state.disputeOrders, { ...serialized, reason: "покупатель отправил скриншот/вложение, нужна ручная проверка" }]
      };
    }

    if (chat.lastRole === "buyer") {
      return {
        disputeOrders: [...state.disputeOrders, { ...serialized, reason: "последнее сообщение от покупателя" }]
      };
    }

    if (!chat.serviceRendered) {
      return {
        disputeOrders: [...state.disputeOrders, { ...serialized, reason: "нет однозначного подтверждения оказания услуги" }]
      };
    }

    return {
      cleanOrders: [...state.cleanOrders, serialized]
    };
  } catch (error) {
    return {
      disputeOrders: [
        ...state.disputeOrders,
        { ...serializeOrder(order), reason: `чат не удалось проверить: ${error.message || "ошибка загрузки"}` }
      ]
    };
  }
}

function applyDecision(order, state, listKey, extra = {}) {
  if (listKey === "removed" || listKey === "skipped") return {};

  const serialized = { ...serializeOrder(order), ...extra };
  if (listKey === "cleanOrders") {
    return { cleanOrders: [...state.cleanOrders, serialized] };
  }
  if (listKey === "disputeOrders") {
    return { disputeOrders: [...state.disputeOrders, serialized] };
  }
  if (listKey === "excludedOrders") {
    return { excludedOrders: [...state.excludedOrders, serialized] };
  }
  return {};
}

async function getManualDecision(order) {
  const key = getOrderKey(order);
  if (!key) return "";
  const data = await chrome.storage.local.get({ [MANUAL_KEY]: {} });
  return data[MANUAL_KEY]?.[key] || "";
}

async function getCachedDecision(order) {
  const key = getOrderKey(order);
  if (!key) return null;
  const data = await chrome.storage.local.get({ [CACHE_KEY]: {} });
  const cached = data[CACHE_KEY]?.[key];
  if (!cached || Date.now() - Number(cached.updatedAt || 0) > STORAGE_CACHE_TTL_MS) return null;
  return cached;
}

async function updateOrderCacheFromState(state) {
  const data = await chrome.storage.local.get({ [CACHE_KEY]: {} });
  const cache = data[CACHE_KEY] || {};
  const now = Date.now();

  for (const listKey of ["cleanOrders", "disputeOrders", "excludedOrders"]) {
    for (const order of state[listKey] || []) {
      const key = getOrderKey(order);
      if (!key || order.manual || order.cached) continue;
      cache[key] = {
        listKey,
        order,
        updatedAt: now
      };
    }
  }

  const entries = Object.entries(cache)
    .filter(([, value]) => now - Number(value.updatedAt || 0) <= STORAGE_CACHE_TTL_MS)
    .sort((a, b) => Number(b[1].updatedAt || 0) - Number(a[1].updatedAt || 0))
    .slice(0, STORAGE_CACHE_LIMIT);

  await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(entries) });
}

async function saveHistory(state) {
  const data = await chrome.storage.local.get({ [HISTORY_KEY]: [] });
  const history = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
  history.unshift({
    at: nowIso(),
    checkedChats: state.checkedChats || 0,
    candidateCount: state.candidateCount || 0,
    cleanCount: state.cleanOrders?.length || 0,
    disputeCount: state.disputeOrders?.length || 0,
    excludedCount: state.excludedOrders?.length || 0
  });
  await chrome.storage.local.set({ [HISTORY_KEY]: history.slice(0, 20) });
}

async function analyzeChat(doc, order, settings = {}) {
  const messages = extractMessages(doc);
  await enrichMessagesWithOcr(messages);
  const fullText = normalize(doc.body?.textContent || "");
  const productText = getProductDescriptionText(doc);
  const buyerText = normalize(messages.filter((message) => message.role === "buyer").map((message) => message.text).join(" "));
  const sellerText = normalize(messages.filter((message) => message.role === "seller").map((message) => message.text).join(" "));
  const systemText = normalize(messages.filter((message) => message.role === "system").map((message) => message.text).join(" "));
  const buyerOrFallback = buyerText || fullText;
  const serviceText = normalize(`${sellerText} ${systemText} ${productText} ${fullText}`);
  const sellerAttachment = messages.some((message) => message.role === "seller" && message.hasAttachment);
  const buyerAttachment = messages.some((message) => message.role === "buyer" && message.hasAttachment);
  const lastMeaningful = [...messages].reverse().find((message) => message.role !== "system" && (message.text || message.hasAttachment));
  const ocrText = normalize(messages.map((message) => message.ocrText || "").join(" "));

  const customDisputeReason = matchWordList(buyerOrFallback, settings.blackWords) ? "custom blacklist" : "";
  const customCleanSignal = matchWordList(serviceText, settings.whiteWords);

  const arbitrationOnly = hasArbitrationParticipant(messages, fullText);

  // Find last staff/arbitration/moderator message and its date
  const lastStaffMsg = [...messages].reverse().find((m) => m.role === "system");
  const lastStaffText = lastStaffMsg ? lastStaffMsg.text : "";
  const lastStaffDate = lastStaffMsg ? lastStaffMsg.date : null;

  return {
    arbitrationOnly,
    hasArbitration: arbitrationOnly || hasStaffMessage(messages) || ARBITRATION_PATTERNS.some((pattern) => pattern.test(fullText)),
    disputeReason: customDisputeReason || DISPUTE_PATTERNS.find((pattern) => pattern.re.test(buyerOrFallback))?.reason || "",
    serviceRendered: customCleanSignal || sellerAttachment || SERVICE_RENDERED_PATTERNS.some((pattern) => pattern.test(serviceText)),
    sellerAttachment,
    buyerAttachment,
    lastRole: lastMeaningful?.role || "",
    ocrText,
    rental: analyzeRental(`${fullText} ${productText}`, messages, order),
    lastStaffText,
    lastStaffDate
  };
}

function getProductDescriptionText(doc) {
  const labels = Array.from(doc.querySelectorAll("body *")).filter((node) =>
    /краткое\s+описание|подробное\s+описание|тип\s+предложения|тип\s+подписки|оплаченный\s+товар/i.test(node.textContent || "")
  );
  const chunks = labels.map((node) => {
    const parent = node.parentElement;
    return normalize(`${node.textContent || ""} ${parent?.textContent || ""}`);
  });
  return normalize(chunks.join(" "));
}

function matchWordList(textValue, wordsValue) {
  const source = normalize(textValue).toLowerCase();
  return parseWords(wordsValue).some((word) => source.includes(word));
}

function parseWords(value) {
  return String(value || "")
    .split(/[,\n;]/)
    .map((word) => normalize(word).toLowerCase())
    .filter(Boolean);
}

function analyzeRental(fullText, messages, order) {
  const isRental = /тип\s+предложения\s+аренда|аренда/i.test(fullText);
  if (!isRental) return { isRental: false };

  const durationMs = parseRentalDuration(fullText);
  const codeMessage = [...messages].reverse().find((message) => isCodeMessage(message.text));
  const codeReceivedAt = codeMessage?.date || order.date || null;

  if (!codeReceivedAt || !durationMs) {
    return {
      isRental: true,
      durationMs,
      codeReceivedAt: codeReceivedAt ? codeReceivedAt.toISOString() : "",
      expiresAt: "",
      isActive: false
    };
  }

  const expiresAt = new Date(codeReceivedAt.getTime() + durationMs);
  return {
    isRental: true,
    durationMs,
    codeReceivedAt: codeReceivedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    isActive: Date.now() < expiresAt.getTime()
  };
}

function isCodeMessage(value) {
  return /ищу\s+код|проверяю\s+почт|[\w.+-]+@[\w.-]+\.\w+\s*:\s*\d{4,8}/i.test(value);
}

function parseRentalDuration(value) {
  const textValue = normalize(value).toLowerCase();
  const month = textValue.match(/(\d+)\s*(?:месяц|месяца|месяцев|мес\.?)/i);
  if (month) return Number(month[1]) * 30 * 24 * 60 * 60 * 1000;

  const day = textValue.match(/(\d+)\s*(?:день|дня|дней|д\.|сутки|суток)/i);
  if (day) return Number(day[1]) * 24 * 60 * 60 * 1000;

  const hour = textValue.match(/(\d+)\s*(?:час|часа|часов|ч\b|h\b)/i);
  if (hour) return Number(hour[1]) * 60 * 60 * 1000;

  return 0;
}

function extractMessages(doc) {
  const nodes = Array.from(doc.querySelectorAll(
    ".chat-msg, .chat-message, .message, [class*='chat-msg'], [class*='message-item'], [class*='chat-message']"
  ));

  if (!nodes.length) {
    return [{ role: "system", text: normalize(doc.body?.textContent || "") }];
  }

  return nodes.map((node) => {
    const textValue = normalize(`${node.textContent || ""} ${getAttachmentText(node)}`);
    const className = String(node.className || "").toLowerCase();
    const lower = textValue.toLowerCase();
    const date = extractMessageDate(node, textValue);
    const hasAttachment = hasMessageAttachment(node);
    const attachmentUrls = getAttachmentUrls(node);

    if (isStaffMessage(node, textValue) || /funpay|оповещение|уведомление|арбитраж|поддержка|модератор|администратор/.test(lower)) {
      return { role: "system", text: textValue, date, hasAttachment, attachmentUrls };
    }

    if (/автоответ|offsidez|продавец|seller/.test(lower) || /own|self|my|out|from-me|right/.test(className)) {
      return { role: "seller", text: textValue, date, hasAttachment, attachmentUrls };
    }

    if (/buyer|from-them|left|incoming/.test(className)) {
      return { role: "buyer", text: textValue, date, hasAttachment, attachmentUrls };
    }

    return { role: "buyer", text: textValue, date, hasAttachment, attachmentUrls };
  }).filter((message) => message.text || message.hasAttachment);
}

function hasStaffMessage(messages) {
  return messages.some((message) => message.role === "system" && STAFF_ROLE_PATTERNS.some((pattern) => pattern.test(message.text)));
}

function hasArbitrationParticipant(messages, fullText) {
  const systemText = messages.filter((message) => message.role === "system").map((message) => message.text).join(" ");
  const source = normalize(`${systemText} ${fullText}`);
  return /ваш\s+заказ\s+передан\s+в\s+службу\s+арбитража/i.test(source) ||
    /очень\s+важно[\s\S]{0,500}подробно\s+изложить\s+свою\s+позицию/i.test(source);
}

async function enrichMessagesWithOcr(messages) {
  if (!window.funpayLocalOcr?.recognizeUrls) return;

  for (const message of messages) {
    if (!message.attachmentUrls?.length) continue;
    const ocrText = await window.funpayLocalOcr.recognizeUrls(message.attachmentUrls);
    if (ocrText) {
      message.text = normalize(`${message.text} ${ocrText}`);
      message.ocrText = ocrText;
    }
  }
}

function isStaffMessage(node, textValue) {
  const roleText = normalize([
    textValue,
    node.getAttribute?.("data-role"),
    node.getAttribute?.("data-user-type"),
    node.getAttribute?.("title"),
    node.querySelector?.(".chat-msg-author-label")?.textContent,
    node.querySelector?.(".chat-msg-role")?.textContent,
    node.querySelector?.(".badge")?.textContent,
    node.querySelector?.(".label")?.textContent,
    node.querySelector?.("[class*='role']")?.textContent,
    node.querySelector?.("[class*='badge']")?.textContent,
    node.querySelector?.("[class*='label']")?.textContent
  ].filter(Boolean).join(" "));

  return STAFF_ROLE_PATTERNS.some((pattern) => pattern.test(roleText));
}

function hasMessageAttachment(node) {
  if (node.querySelector?.("img, video, canvas")) return true;
  const links = Array.from(node.querySelectorAll?.("a[href]") || []);
  return links.some((link) => /\.(?:png|jpe?g|webp|gif|bmp|heic)(?:[?#].*)?$/i.test(link.getAttribute("href") || "")) ||
    /скрин|screenshot|изображение|вложени|прикреп/i.test(node.textContent || "") ||
    /attach|image|photo|file/i.test(String(node.className || ""));
}

function getAttachmentText(node) {
  const items = Array.from(node.querySelectorAll?.("img, a[href]") || []);
  return items.map((item) => [
    item.getAttribute("alt"),
    item.getAttribute("title"),
    item.getAttribute("aria-label"),
    item.getAttribute("href"),
    item.getAttribute("src")
  ].filter(Boolean).join(" ")).join(" ");
}

function getAttachmentUrls(node) {
  const items = Array.from(node.querySelectorAll?.("img, a[href]") || []);
  return items.map((item) => item.getAttribute("src") || item.getAttribute("href") || "")
    .filter((url) => /\.(?:png|jpe?g|webp|gif|bmp)(?:[?#].*)?$/i.test(url))
    .map((url) => new URL(url, location.href).href);
}

function extractMessageDate(node, textValue) {
  const candidates = [
    textValue,
    node.getAttribute?.("title") || "",
    node.querySelector?.("time")?.getAttribute("datetime") || "",
    node.querySelector?.("time")?.textContent || "",
    node.parentElement?.textContent || ""
  ];

  for (const candidate of candidates) {
    const parsed = parseDate(candidate);
    if (parsed) return parsed;
  }

  return null;
}

async function loadOrderPages() {
  const pages = [{ doc: document, url: location.href }];
  const seenUrls = new Set([normalizePageUrl(location.href)]);
  let currentDoc = document;
  let currentUrl = location.href;

  while (pages.length < MAX_PAGES) {
    const orders = parseOrders(currentDoc, currentUrl);
    const nextUrl = findNextPageUrl(currentDoc, currentUrl, orders);
    const key = normalizePageUrl(nextUrl);
    if (!nextUrl || seenUrls.has(key)) break;

    seenUrls.add(key);
    const nextDoc = await fetchDocument(nextUrl);
    pages.push({ doc: nextDoc, url: nextUrl });
    currentDoc = nextDoc;
    currentUrl = nextUrl;
  }

  return pages;
}

function parseOrders(doc, baseUrl) {
  const rows = Array.from(doc.querySelectorAll("a.tc-item[href]"));

  return rows.map((row) => {
    const href = row.getAttribute("href") || row.href;
    const absoluteUrl = new URL(href, baseUrl).href;
    const priceNode = row.querySelector(".tc-seller-sum, .tc-price, .price, [class*='price']");
    const dateNode = row.querySelector(".tc-date-time, .date, time, [class*='date']");
    const statusNode = row.querySelector(".tc-status, .status, [class*='status']");
    const titleNode = row.querySelector(".order-desc > div:first-child, .order-desc, .tc-desc, .tc-title");
    const subtitleNode = row.querySelector(".order-desc .text-muted");
    const buyerNode = row.querySelector(".media-user-name, .tc-user, .user-link, [class*='user-name'], [class*='buyer']");
    const statusText = [row.className, text(statusNode), row.textContent].join(" ").toLowerCase();
    const title = cleanTitle(text(titleNode) || row.textContent);
    const subtitle = text(subtitleNode);

    return {
      id: getOrderId(absoluteUrl) || row.getAttribute("data-id") || absoluteUrl,
      url: absoluteUrl,
      title,
      game: getGameName(subtitle, title),
      buyer: text(buyerNode),
      subtitle,
      amount: parseAmount(text(priceNode) || row.textContent),
      currency: parseCurrency(text(priceNode) || row.textContent),
      date: parseDate([
        dateNode?.getAttribute("datetime"),
        dateNode?.getAttribute("title"),
        text(dateNode)
      ].filter(Boolean).join(" ")),
      statusText
    };
  }).filter((order) => order.url && order.amount > 0);
}

function findNextPageUrl(doc, baseUrl, orders) {
  const nextLink = doc.querySelector("a[rel='next'], .pagination a.next, a.next, a[href*='continue=']");
  if (nextLink?.href) return new URL(nextLink.getAttribute("href"), baseUrl).href;

  const lastOrder = orders.length ? orders[orders.length - 1] : null;
  if (!lastOrder?.id) return "";

  const url = new URL(baseUrl);
  url.searchParams.set("continue", lastOrder.id);
  return url.href;
}

function highlightOrders(state) {
  document.querySelectorAll(".funpay-analyzer-clean, .funpay-analyzer-dispute, .funpay-analyzer-excluded").forEach((node) => {
    node.classList.remove("funpay-analyzer-clean", "funpay-analyzer-dispute", "funpay-analyzer-excluded");
  });

  ensureHighlightStyle();
  markOrders(state.cleanOrders, "funpay-analyzer-clean");
  markOrders(state.disputeOrders, "funpay-analyzer-dispute");
  markOrders(state.excludedOrders, "funpay-analyzer-excluded");
}

function installHighlightObserver() {
  let timer = 0;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const state = await getState();
      if (state) highlightOrders(state);
    }, 250);
  };

  const observer = new MutationObserver(refresh);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  refresh();
}

function markOrders(orders, className) {
  const ids = new Set((orders || []).map((order) => order.id).filter(Boolean));
  const urls = new Set((orders || []).map((order) => order.url));

  for (const link of document.querySelectorAll("a.tc-item[href], a[href*='/orders/']")) {
    const href = new URL(link.getAttribute("href") || link.href, location.href).href;
    const id = getOrderId(href);

    if (urls.has(href) || ids.has(id)) {
      link.classList.add(className);
    }
  }
}

function ensureHighlightStyle() {
  if (document.getElementById("funpay-analyzer-style")) return;

  const style = document.createElement("style");
  style.id = "funpay-analyzer-style";
  style.textContent = `
    .funpay-analyzer-clean {
      outline: 2px solid #34d399 !important;
      outline-offset: -2px !important;
      background: rgba(52, 211, 153, .14) !important;
      box-shadow: inset 4px 0 0 #34d399 !important;
    }
    .funpay-analyzer-dispute {
      outline: 2px solid #ff4d6d !important;
      outline-offset: -2px !important;
      background: rgba(255, 77, 109, .14) !important;
      box-shadow: inset 4px 0 0 #ff4d6d !important;
    }
    .funpay-analyzer-excluded {
      outline: 2px solid #9ca3af !important;
      outline-offset: -2px !important;
      background: rgba(156, 163, 175, .16) !important;
      box-shadow: inset 4px 0 0 #9ca3af !important;
    }
  `;
  document.documentElement.append(style);
}

async function fetchDocument(url, cacheable = false, retryOnLimit = false, delayMs = 1400) {
  if (cacheable && documentCache.has(url)) return documentCache.get(url);

  const attempts = retryOnLimit ? RETRY_DELAYS_MS.length + 1 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await throttleFetch(delayMs);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      const response = await fetch(url, {
        credentials: "include",
        cache: "default",
        signal: controller.signal
      });

      if (response.status === 429 && attempt < attempts - 1) {
        await increaseDelayAfterLimit(delayMs);
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }

      if (!response.ok) throw new Error(`FunPay вернул ${response.status}`);

      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");

      if (cacheable) {
        documentCache.set(url, doc);
        if (documentCache.size > CACHE_LIMIT) {
          documentCache.delete(documentCache.keys().next().value);
        }
      }

      return doc;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("FunPay временно ограничил запросы. Увеличьте задержку и продолжите позже.");
}

async function throttleFetch(delayMs) {
  const wait = Math.max(0, Math.max(0, Number(delayMs) || 0) - (Date.now() - lastFetchAt));
  if (wait > 0) await sleep(wait);
  lastFetchAt = Date.now();
}

async function increaseDelayAfterLimit(currentDelayMs) {
  const settings = await getSettings();
  if (!settings.adaptiveDelay) return;

  const nextDelay = clamp(Math.max(Number(currentDelayMs || 0) + 1000, Math.round(settings.delayMs * 1.5)), 500, 30000);
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...settings,
      delayMs: nextDelay
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isListCandidate(order) {
  return isPaid(order) && !isClosed(order) && !isCancelled(order);
}

function isPaid(order) {
  return /(оплачен|оплачено|оплата|paid|payment)/i.test(order.statusText);
}

function isClosed(order) {
  return /(закрыт|закрыто|выполнен|заверш|подтвержд|closed|complete|completed|done|confirmed)/i.test(order.statusText);
}

function isCancelled(order) {
  return /(отмен|возврат|вернул\s+деньги|refund|cancel|canceled|cancelled)/i.test(order.statusText);
}

function dedupeOrders(orders) {
  const map = new Map();
  for (const order of orders) {
    if (!map.has(order.id)) map.set(order.id, order);
  }
  return Array.from(map.values());
}

function parseAmount(value) {
  const source = normalize(value).replace(/\s+/g, "");
  const matches = Array.from(source.matchAll(/\d+(?:[.,]\d+)?/g)).map((match) => Number(match[0].replace(",", ".")));
  return matches.length ? Math.max(...matches) : 0;
}

function parseCurrency(value) {
  const source = normalize(value);
  if (source.includes("$")) return "$";
  if (source.includes("€")) return "€";
  if (/₽|руб/i.test(source)) return "₽";
  return "₽";
}

function parseDate(value) {
  const source = normalize(value).toLowerCase();
  if (!source) return null;

  const iso = source.match(/\d{4}-\d{2}-\d{2}(?:[t\s]\d{2}:\d{2}(?::\d{2})?)?/);
  if (iso) {
    const date = new Date(iso[0]);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const numeric = source.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:\D+(\d{1,2}):(\d{2}))?/);
  if (numeric) {
    const year = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]);
    return new Date(year, Number(numeric[2]) - 1, Number(numeric[1]), Number(numeric[4] || 0), Number(numeric[5] || 0));
  }

  const time = source.match(/(\d{1,2}):(\d{2})/);
  if (/сегодня|today/.test(source) && time) {
    const date = new Date();
    date.setHours(Number(time[1]), Number(time[2]), 0, 0);
    return date;
  }

  if (/вчера|yesterday/.test(source) && time) {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    date.setHours(Number(time[1]), Number(time[2]), 0, 0);
    return date;
  }

  const monthDate = source.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:,\s*(\d{1,2}):(\d{2}))?/);
  if (monthDate) {
    const month = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"].indexOf(monthDate[2]);
    return new Date(new Date().getFullYear(), month, Number(monthDate[1]), Number(monthDate[3] || 0), Number(monthDate[4] || 0));
  }

  return null;
}

function getOrderId(url) {
  const source = String(url || "");
  const queryId = source.match(/[?&]id=([^&#]+)/i)?.[1];
  const pathId = source.match(/orders\/(?:trade\/)?([^/?#]+)/i)?.[1];

  if (queryId) return queryId;
  if (pathId && pathId.toLowerCase() !== "trade") return pathId;
  return "";
}

function getOrderKey(order) {
  return order?.id || order?.url || "";
}

function normalizePageUrl(url) {
  if (!url) return "";
  const parsed = new URL(url, location.href);
  return parsed.href;
}

function cleanTitle(value) {
  return normalize(value)
    .replace(/\d+(?:[.,]\d+)?\s*(₽|руб\.?|rur|usd|\$|€)/ig, "")
    .replace(/(оплачен|оплачено|закрыт|закрыто|выполнен|отмен|возврат|paid|closed|сегодня|вчера).*/i, "")
    .trim()
    .slice(0, 180) || "Без названия";
}

function getGameName(subtitle, fallback) {
  const game = normalize(subtitle).split(",")[0]?.trim();
  return game || normalize(fallback).split(/[|•,]/)[0]?.trim() || "Без названия";
}

function serializeOrder(order) {
  return {
    ...order,
    dateIso: order.date ? order.date.toISOString() : ""
  };
}

function sortOrders(orders) {
  return [...(orders || [])].sort((a, b) => b.amount - a.amount || String(b.dateIso || "").localeCompare(String(a.dateIso || "")));
}

function createState(overrides = {}) {
  const at = nowIso();
  return {
    runId: "",
    status: "idle",
    message: "",
    currency: "₽",
    totalOrdersFound: 0,
    candidateCount: 0,
    checkedChats: 0,
    nextIndex: 0,
    orders: [],
    cleanOrders: [],
    disputeOrders: [],
    excludedOrders: [],
    excludedCount: 0,
    createdAt: at,
    updatedAt: at,
    ...overrides
  };
}

function normalizeState(state, runId) {
  return createState({
    ...state,
    runId,
    cleanOrders: state.cleanOrders || [],
    disputeOrders: state.disputeOrders || [],
    excludedOrders: state.excludedOrders || [],
    orders: state.orders || []
  });
}

function makeRunId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function getState() {
  const data = await chrome.storage.local.get({ [STATE_KEY]: null });
  return data[STATE_KEY];
}

async function getSettings() {
  const data = await chrome.storage.local.get({
    [SETTINGS_KEY]: {
      delayMs: 1400,
      adaptiveDelay: true,
      pauseEvery: 25,
      pauseMs: 15000,
      blackWords: "не работает, не получил, ошибка, неверный, заблокирован, возврат",
      whiteWords: "спасибо, получил, работает, все ок, зашел"
    }
  });
  const settings = data[SETTINGS_KEY] || {};
  return {
    delayMs: clamp(Number(settings.delayMs || 1400), 500, 30000),
    adaptiveDelay: settings.adaptiveDelay !== false,
    pauseEvery: clamp(Number(settings.pauseEvery || 0), 0, 200),
    pauseMs: clamp(Number(settings.pauseMs || 0), 0, 120000),
    blackWords: String(settings.blackWords || ""),
    whiteWords: String(settings.whiteWords || "")
  };
}

async function saveState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

async function failRun(error) {
  const state = await getState();
  await saveState({
    ...(state || createState()),
    status: "error",
    message: error.message,
    updatedAt: nowIso()
  });
  currentRun = null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function text(node) {
  return normalize(node?.textContent || "");
}

function normalize(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}
})();
