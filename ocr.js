/**
* ocr.js — FunPay Lists OCR module
*
* Strategy:
* 1. Try native Chrome TextDetector (fast, no deps, Chromium only)
* 2. If unavailable, try Tesseract.js loaded from extension resources
* 3. Cache results to avoid re-processing the same image URL
*/
(function () {
 const cache = new Map();
 let tesseractWorker = null;
 let tesseractLoading = false;
 let tesseractReady = false;

 // ── Native TextDetector (Chrome Shape Detection API) ──────────────────────
 async function tryNativeOcr(urls) {
   if (!("TextDetector" in window)) return null;

   const detector = new TextDetector();
   const chunks = [];

   for (const url of urls || []) {
     if (!url) continue;
     if (cache.has(url)) {
       const cached = cache.get(url);
       if (cached) chunks.push(cached);
       continue;
     }

     try {
       const response = await fetch(url, { credentials: "include", cache: "force-cache" });
       if (!response.ok) throw new Error(String(response.status));

       const blob = await response.blob();
       const bitmap = await createImageBitmap(blob);
       const lines = await detector.detect(bitmap);
       const text = lines.map((line) => line.rawValue || "").filter(Boolean).join(" ");
       bitmap.close?.();

       cache.set(url, text);
       if (text) chunks.push(text);
     } catch (_error) {
       cache.set(url, "");
     }
   }

   return chunks.join(" ");
 }

 // ── Tesseract.js Fallback ─────────────────────────────────────────────────
 async function loadTesseract() {
   if (tesseractReady) return true;
   if (tesseractLoading) {
     // Wait for it
     return new Promise((resolve) => {
       const interval = setInterval(() => {
         if (tesseractReady) { clearInterval(interval); resolve(true); }
         if (!tesseractLoading) { clearInterval(interval); resolve(false); }
       }, 100);
     });
   }

   tesseractLoading = true;

   try {
     // Try to load Tesseract from extension resources
     const scriptUrl = chrome.runtime.getURL("tesseract.min.js");
     await new Promise((resolve, reject) => {
       const script = document.createElement("script");
       script.src = scriptUrl;
       script.onload = resolve;
       script.onerror = reject;
       document.head.appendChild(script);
     });

     if (typeof Tesseract === "undefined") throw new Error("Tesseract not defined");

     tesseractWorker = await Tesseract.createWorker("rus", 1, {
       workerPath: chrome.runtime.getURL("tesseract-worker.min.js"),
       corePath: chrome.runtime.getURL("tesseract-core.wasm.js"),
       langPath: chrome.runtime.getURL("lang-data"),
       logger: () => {},
     });

     tesseractReady = true;
     tesseractLoading = false;
     return true;
   } catch (_e) {
     tesseractLoading = false;
     return false;
   }
 }

 async function tryTesseractOcr(urls) {
   const loaded = await loadTesseract();
   if (!loaded || !tesseractWorker) return "";

   const chunks = [];

   for (const url of urls || []) {
     if (!url) continue;
     if (cache.has(url)) {
       const cached = cache.get(url);
       if (cached) chunks.push(cached);
       continue;
     }

     try {
       const response = await fetch(url, { credentials: "include", cache: "force-cache" });
       if (!response.ok) throw new Error(String(response.status));

       const blob = await response.blob();
       const objectUrl = URL.createObjectURL(blob);

       const { data: { text } } = await tesseractWorker.recognize(objectUrl);
       URL.revokeObjectURL(objectUrl);

       const cleaned = (text || "").replace(/\s+/g, " ").trim();
       cache.set(url, cleaned);
       if (cleaned) chunks.push(cleaned);
     } catch (_e) {
       cache.set(url, "");
     }
   }

   return chunks.join(" ");
 }

 // ── Public API ────────────────────────────────────────────────────────────
 async function recognizeUrls(urls) {
   if (!urls || urls.length === 0) return "";

   // Try native first (fast)
   const nativeResult = await tryNativeOcr(urls);
   if (nativeResult !== null) return nativeResult;

   // Fallback to Tesseract
   return tryTesseractOcr(urls);
 }

 window.funpayLocalOcr = { recognizeUrls };
})();
