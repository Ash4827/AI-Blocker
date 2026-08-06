(function () {
  const { getCached, setCached } = window.AIBlockerCache;
  const { classifyBitmap } = window.AIBlockerModel;

  const LOG = "[AI Post Blocker][offscreen]";

  if (typeof ort !== "undefined") {
    ort.env.wasm.wasmPaths = chrome.runtime.getURL("lib/onnxruntime-web/");
    // Single-threaded: avoids requiring cross-origin isolation (COOP/COEP)
    // for SharedArrayBuffer, at the cost of some inference speed.
    ort.env.wasm.numThreads = 1;
  }

  // Quota can't be checked/consumed directly in this file: per Chrome's own
  // docs, "chrome.runtime is the only extensions API supported by offscreen
  // documents" — chrome.storage is genuinely undefined here, not just
  // unreliable. (This used to do the chrome.storage.sync/.local read-write
  // inline, which is exactly what was throwing "Cannot read properties of
  // undefined (reading 'sync')" on every single call — see the Obsidian
  // "Pixel Analysis Sync Error" note.) Relayed to background.js instead,
  // which has full chrome.storage access. Still called from the same spot
  // below — after the cache check, right before inference — so a cache hit
  // still doesn't cost a scan; only *where* the storage read/write happens
  // changed, not *when* it's triggered.
  function consumePixelQuota() {
    return chrome.runtime.sendMessage({ type: "CONSUME_PIXEL_QUOTA" });
  }

  // Note on where these logs are visible: this file runs in the offscreen
  // document, a separate DevTools context from the page you're browsing.
  // See it via chrome://extensions → this extension → "Inspect views:
  // offscreen.html" (only listed while the document is alive). The content
  // script (common.js) logs the same outcomes — with the raw score and the
  // fetch/decode distinction — into the regular page console, which is the
  // more convenient place to watch during normal testing.
  async function classifyPayload({ imageUrl, imageDataUrl, cacheKey }) {
    const key = cacheKey || imageUrl || imageDataUrl;
    const source = imageUrl || imageDataUrl;

    const cached = await getCached(key);
    if (cached !== undefined) {
      console.log(`${LOG} cache hit p=${cached.toFixed(3)}`, source);
      return { aiProbability: cached, cached: true };
    }

    const quota = await consumePixelQuota();
    if (!quota.allowed) {
      console.log(`${LOG} quota exceeded, not fetching`, source);
      return { quotaExceeded: true };
    }

    // Fetch stage: fetch() throwing is opaque by browser design — it covers
    // CORS rejection (host not covered by manifest host_permissions, or the
    // CDN itself doesn't allow it), DNS failure, and plain network errors,
    // all indistinguishably. JS cannot tell these apart; a human has to
    // cross-check the failing URL's host against manifest.json.
    let blob;
    try {
      const response = await fetch(source);
      if (!response.ok) {
        // Reaching this line means fetch() did NOT throw — so this is
        // provably not a CORS block. The request went through and the
        // server itself rejected it (expired/signed URL, hotlink
        // protection, deleted content, auth wall, etc.).
        const err = new Error(`HTTP ${response.status} ${response.statusText}`);
        err.stage = "fetch-http";
        throw err;
      }
      blob = await response.blob();
    } catch (err) {
      const stage = err.stage || "fetch-network";
      console.warn(`${LOG} FETCH FAILED [${stage}]`, source, err.message || err);
      return { error: String(err.message || err), stage };
    }

    // Decode stage: createImageBitmap throwing here means the bytes we got
    // back aren't a decodable image (corrupt, unsupported format, an HTML
    // error page served with a 200 status, etc.) — not a network problem.
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (err) {
      console.warn(`${LOG} DECODE FAILED [decode]`, source, err?.message || err);
      return { error: String(err?.message || err), stage: "decode" };
    }

    const aiProbability = await classifyBitmap(bitmap);
    console.log(`${LOG} scored p=${aiProbability.toFixed(3)}`, source);
    await setCached(key, aiProbability);
    // Carries the post-consume tally back to common.js so the page-console
    // "SCORED" log can show the running quota count in the same place
    // you're already watching scores — no need to separately open the
    // offscreen document's console to see whether the counter is moving.
    return {
      aiProbability,
      quota: quota.isPro ? undefined : { used: quota.used, limit: quota.limit }
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "OFFSCREEN_CLASSIFY_IMAGE") return false;

    classifyPayload(message)
      .then(sendResponse)
      .catch((err) => {
        // Catches anything unexpected outside the fetch/decode stages above
        // (e.g. the model itself failing to load) — still tagged so it
        // shows up distinctly rather than looking like a low score.
        //
        // Logging err.stack (not just err.message) deliberately: the
        // message-passing round-trip back to the content script only ever
        // carries a stringified message, discarding the stack entirely —
        // this offscreen-document console is the ONLY place the real
        // originating file/line survives. See "Inspect views: offscreen.html"
        // in chrome://extensions to actually read it.
        console.warn(`${LOG} unexpected failure [inference]`, err?.stack || err);
        sendResponse({ error: String(err?.message || err), stage: "inference" });
      });

    return true; // keep the message channel open for the async response
  });
})();
