const OPEN_PANEL_MESSAGE = "FUNPAY_LISTS_OPEN_PANEL_V1";
const ALARM_NAME = "funpayListsReminder";
const STATE_KEY = "funpayListsState";
const SETTINGS_KEY = "funpayListsSettings";

// ── Side Panel ──────────────────────────────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
if (!tab?.id) return;

if (!tab.url?.startsWith("https://funpay.com/")) {
  await chrome.tabs.create({ url: "https://funpay.com/orders/trade" });
  return;
}

// Open side panel on the current tab
try {
  await chrome.sidePanel.open({ tabId: tab.id });
  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true
  });
} catch (_e) {
  // Fallback: inject content script and open floating panel
  try {
    await chrome.tabs.sendMessage(tab.id, { type: OPEN_PANEL_MESSAGE });
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["ocr.js", "content.js"]
    });
    await chrome.tabs.sendMessage(tab.id, { type: OPEN_PANEL_MESSAGE });
  }
}
});

// ── Alarms: reminder for stale paid orders ──────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
if (alarm.name !== ALARM_NAME) return;
await checkStaleOrders();
});

async function checkStaleOrders() {
const { [STATE_KEY]: state, [SETTINGS_KEY]: settings } = await chrome.storage.local.get([STATE_KEY, SETTINGS_KEY]);
if (!state || !settings) return;

const reminderDays = settings.reminderDays ?? 3;
if (!reminderDays || reminderDays <= 0) return;

const now = Date.now();
const thresholdMs = reminderDays * 24 * 60 * 60 * 1000;

const allOrders = [
  ...(state.cleanOrders || []),
  ...(state.disputeOrders || [])
];

const stale = allOrders.filter(order => {
  if (!order.dateIso) return false;
  const orderTime = new Date(order.dateIso).getTime();
  return (now - orderTime) >= thresholdMs;
});

if (stale.length === 0) return;

chrome.notifications.create(`funpay-stale-${Date.now()}`, {
  type: "basic",
  iconUrl: "icons/icon48.png",
  title: "FunPay Lists — Зависшие заказы",
  message: `${stale.length} заказ(ов) оплачено более ${reminderDays} дн. назад и не закрыто.`,
  priority: 2
});
}

// ── Setup alarm when settings change ───────────────────────────────────────
chrome.storage.onChanged.addListener(async (changes, area) => {
if (area !== "local") return;
if (!changes[SETTINGS_KEY]) return;

const settings = changes[SETTINGS_KEY].newValue || {};
const reminderDays = settings.reminderDays ?? 3;

await chrome.alarms.clear(ALARM_NAME);

if (reminderDays > 0) {
  // Check every 4 hours
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 240 });
}
});

// ── Init alarm on startup ───────────────────────────────────────────────────
chrome.runtime.onStartup.addListener(async () => {
const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
const reminderDays = settings?.reminderDays ?? 3;
if (reminderDays > 0) {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 240 });
  }
}
});

chrome.runtime.onInstalled.addListener(async () => {
const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
const reminderDays = settings?.reminderDays ?? 3;
if (reminderDays > 0) {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 240 });
}
});
