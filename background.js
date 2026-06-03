const OPEN_PANEL_MESSAGE = "FUNPAY_LISTS_OPEN_PANEL_V1";

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  if (!tab.url?.startsWith("https://funpay.com/")) {
    await chrome.tabs.create({ url: "https://funpay.com/orders/trade" });
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: OPEN_PANEL_MESSAGE });
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["ocr.js", "content.js"]
    });
    await chrome.tabs.sendMessage(tab.id, { type: OPEN_PANEL_MESSAGE });
  }
});
