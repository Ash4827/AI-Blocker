(function () {
  const { getCached, setCached } = window.AIBlockerCache;
  const { classifyBitmap } = window.AIBlockerModel;

  const LOG = "[AI Post Blocker][offscreen]";

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

  // Serializes every quota read+write through a single in-process promise
  // chain. Why this exists: observeFeed() in common.js deliberately does
  // NOT await onFound() (see its comment) so a batch of newly-scrolled-in
  // posts triggers many concurrent classifyPayload() calls. Without this,
  // two concurrent calls can both read usedToday=N before either writes
  // N+1, and the second write clobbers the first — a classic lost-update
  // race. chrome.storage has no transactions of its own; this is the
  // cheapest correct fix because every quota write happens in this one JS
  // realm (the offscreen document) — there's no cross-realm concurrency to
  // guard against, only intra-realm interleaving via awaits, which a plain
  // promise chain fully serializes.
  let quotaQueue = Promise.resolve();

  // Consumes one unit of the free daily allowance. Lives here (not
  // background.js) specifically so it only fires on an actual cache miss —
  // re-scrolling past an already-classified image must not cost a scan.
  function consumePixelQuota() {
    const attempt = quotaQueue.then(async () => {
      const { isPro = false } = await chrome.storage.sync.get("isPro");
      if (isPro) return { allowed: true, isPro: true };

      const { pixelScansUsedToday = 0, pixelScansDate = "" } =
        await chrome.storage.local.get(["pixelScansUsedToday", "pixelScansDate"]);

      const today = todayKey();
      const usedToday = pixelScansDate === today ? pixelScansUsedToday : 0;
      console.log(`${LOG} quota check: usedToday=${usedToday}/${FREE_DAILY_PIXEL_SCANS}`);
      if (usedToday >= FREE_DAILY_PIXEL_SCANS) return { allowed: false };

      const nextUsed = usedToday + 1;
      await chrome.storage.local.set({
        pixelScansUsedToday: nextUsed,
        pixelScansDate: today
      });
      console.log(`${LOG} quota consumed: ${nextUsed}/${FREE_DAILY_PIXEL_SCANS}`);
      return { allowed: true, used: nextUsed, limit: FREE_DAILY_PIXEL_SCANS };
    });
    // Keep the queue itself always-resolved so one failed attempt doesn't
    // permanently jam every attempt after it; the real result/error still
    // flows to this call's own caller via `attempt`.
    quotaQueue = attempt.catch(() => {});
    return attempt;
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
        console.warn(`${LOG} unexpected failure [inference]`, err?.message || err);
        sendResponse({ error: String(err?.message || err), stage: "inference" });
      });

    return true; // keep the message channel open for the async response
  });
})();
