(function () {
  const cache = new Map();

  async function recognizeUrls(urls) {
    if (!("TextDetector" in window)) return "";

    const detector = new TextDetector();
    const chunks = [];

    for (const url of urls || []) {
      if (!url || cache.has(url)) {
        if (cache.has(url)) chunks.push(cache.get(url));
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

  window.funpayLocalOcr = { recognizeUrls };
})();
