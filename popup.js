function showToast(msg, type = "info", durationMs = 3000) {
const MAX_TOASTS = 5;
let container = document.getElementById("toastContainer");
if (!container) {
  container = document.createElement("div");
  container.id = "toastContainer";
  container.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;";
  document.body.appendChild(container);
}

// Cap: remove oldest excess toasts
while (container.children.length >= MAX_TOASTS) {
  const oldest = container.firstElementChild;
  if (oldest && oldest._clearToast) clearTimeout(oldest._clearToast);
  if (oldest) oldest.remove();
}

const toast = document.createElement("div");
const colors = { info: "#3b82f6", success: "#22c55e", error: "#ef4444", warn: "#f59e0b" };
toast.style.cssText = `background:${colors[type]||colors.info};color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;max-width:280px;box-shadow:0 4px 12px rgba(0,0,0,.4);opacity:0;transition:opacity .2s;pointer-events:auto;`;
toast.textContent = msg;
container.appendChild(toast);
requestAnimationFrame(() => { toast.style.opacity = "1"; });

const removeTimer = setTimeout(() => {
  toast.style.opacity = "0";
  toast._fadeTimer = setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 220);
}, durationMs);

// Allow cleanup if this toast gets evicted early
toast._clearToast = () => {
  clearTimeout(removeTimer);
  if (toast._fadeTimer) clearTimeout(toast._fadeTimer);
};
}