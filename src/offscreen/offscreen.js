(function () {
  const { getCached, setCached } = window.AIBlockerCache;
  const { classifyBitmap } = window.AIBlockerModel;

  // Kept in sync with background.js's FREE_DAILY_PIXEL_SCANS by convention
  // (no bundler/shared-module setup in this extension) — see the comment
  // there and the Obsidian "Freemium Gating" note.
  const FREE_DAILY_PIXEL_SCANS = 15;

  if (typeof ort !== "undefined") {
    ort.env.wasm.wasmPaths = chrome.runtime.getURL("lib/onnxruntime-web/");
    // Single-threaded: avoids requiring cross-origin isolation (COOP/COEP)
    // for SharedArrayBuffer, at the cost of some inference speed.
    ort.env.wasm.numThreads = 1;
  }

  function todayKey() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  }

  // Consumes one unit of the free daily allowance. Lives here (not
  // background.js) specifically so it only fires on an actual cache miss —
  // re-scrolling past an already-classified image must not cost a scan.
  async function consumePixelQuota() {
    const { isPro = false } = await chrome.storage.sync.get("isPro");
    if (isPro) return { allowed: true };

    const { pixelScansUsedToday = 0, pixelScansDate = "" } =
      await chrome.storage.local.get(["pixelScansUsedToday", "pixelScansDate"]);

    const today = todayKey();
    const usedToday = pixelScansDate === today ? pixelScansUsedToday : 0;
    if (usedToday >= FREE_DAILY_PIXEL_SCANS) return { allowed: false };

    await chrome.storage.local.set({
      pixelScansUsedToday: usedToday + 1,
      pixelScansDate: today
    });
    return { allowed: true };
  }

  async function classifyPayload({ imageUrl, imageDataUrl, cacheKey }) {
    const key = cacheKey || imageUrl || imageDataUrl;
    const cached = await getCached(key);
    if (cached !== undefined) return { aiProbability: cached };

    const quota = await consumePixelQuota();
    if (!quota.allowed) return { quotaExceeded: true };

    const source = imageUrl || imageDataUrl;
    const response = await fetch(source);
    if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);

    const aiProbability = await classifyBitmap(bitmap);
    await setCached(key, aiProbability);
    return { aiProbability };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "OFFSCREEN_CLASSIFY_IMAGE") return false;

    classifyPayload(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: String(err?.message || err) }));

    return true; // keep the message channel open for the async response
  });
})();
