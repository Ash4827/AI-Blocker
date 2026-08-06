const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "blur", // "blur" | "hide"
  platforms: {
    instagram: true,
    twitter: true,
    facebook: true,
    linkedin: true,
    reddit: true,
    tiktok: true
  },
  detectLabels: true,
  detectHeuristics: true,
  pixelAnalysis: false,
  hiddenCount: 0,
  // Freemium: label/heuristic detection (above) is always free and
  // unlimited. Pixel analysis is metered below, unless isPro is true.
  // isPro is a local flag only — no real payment/license verification
  // exists yet. Flipping it in storage is the entire "upgrade" path today.
  isPro: false
};

// Quota state (pixelScansUsedToday / pixelScansDate) intentionally lives in
// chrome.storage.local, not .sync: it can be written once per image during
// active scrolling, and .sync enforces a ~120 writes/minute cap that a fast
// scroll session could plausibly hit. isPro/settings stay in .sync since
// they're written rarely and benefit from cross-device sync once real
// billing exists.
const FREE_DAILY_PIXEL_SCANS = 15;

const OFFSCREEN_URL = "src/offscreen/offscreen.html";

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(null);
  const merged = {
    ...DEFAULT_SETTINGS,
    ...existing,
    platforms: { ...DEFAULT_SETTINGS.platforms, ...existing.platforms }
  };
  await chrome.storage.sync.set(merged);
});

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["BLOBS"],
    justification:
      "Decode fetched images and run on-device AI-image-detection inference off the content script's thread."
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// Reads current usage without mutating anything — used for popup display,
// where "today" needs to be computed the same way but nothing should be
// consumed just by looking.
async function readPixelQuota() {
  const [{ isPro = false }, { pixelScansUsedToday = 0, pixelScansDate = "" }] =
    await Promise.all([
      chrome.storage.sync.get("isPro"),
      chrome.storage.local.get(["pixelScansUsedToday", "pixelScansDate"])
    ]);
  const usedToday = pixelScansDate === todayKey() ? pixelScansUsedToday : 0;
  return {
    isPro,
    used: usedToday,
    limit: FREE_DAILY_PIXEL_SCANS,
    remaining: isPro ? null : Math.max(0, FREE_DAILY_PIXEL_SCANS - usedToday)
  };
}

// Serializes every quota read+write through a single in-process promise
// chain. chrome.runtime.onMessage handlers in this service worker can fire
// concurrently (many images in flight during a scroll session), and
// chrome.storage has no transactions of its own — without this, two
// concurrent calls can both read usedToday=N before either writes N+1,
// clobbering one increment. See the Obsidian "Freemium Gating" note for
// the simulation that reproduced this exact race.
let quotaQueue = Promise.resolve();

// Actually *consumes* one unit of quota — moved here from
// src/offscreen/offscreen.js, where it used to live. It can't live there:
// per Chrome's own docs, "chrome.runtime is the only extensions API
// supported by offscreen documents" — chrome.storage is genuinely
// undefined in that context, not just unreliable. Every other
// chrome.storage touch in the offscreen document (cache.js, model.js) is
// wrapped in try/catch and degrades silently; this was the one call that
// wasn't, so it threw on every single invocation. Relayed via
// CONSUME_PIXEL_QUOTA below — the offscreen document still decides *when*
// to call this (after its own cache check, right before inference, so a
// cache hit doesn't cost a scan), it just can't do the storage read/write
// itself anymore.
function consumePixelQuota() {
  const attempt = quotaQueue.then(async () => {
    const { isPro = false } = await chrome.storage.sync.get("isPro");
    if (isPro) return { allowed: true, isPro: true };

    const { pixelScansUsedToday = 0, pixelScansDate = "" } =
      await chrome.storage.local.get(["pixelScansUsedToday", "pixelScansDate"]);

    const today = todayKey();
    const usedToday = pixelScansDate === today ? pixelScansUsedToday : 0;
    if (usedToday >= FREE_DAILY_PIXEL_SCANS) return { allowed: false };

    const nextUsed = usedToday + 1;
    await chrome.storage.local.set({
      pixelScansUsedToday: nextUsed,
      pixelScansDate: today
    });
    return { allowed: true, used: nextUsed, limit: FREE_DAILY_PIXEL_SCANS };
  });
  quotaQueue = attempt.catch(() => {});
  return attempt;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "POST_HIDDEN") {
    incrementHiddenCount();
    return false;
  }

  if (message?.type === "GET_PIXEL_QUOTA_STATUS") {
    readPixelQuota().then(sendResponse);
    return true;
  }

  if (message?.type === "CONSUME_PIXEL_QUOTA") {
    consumePixelQuota().then(sendResponse);
    return true;
  }

  if (message?.type === "CLASSIFY_IMAGE_PIXELS") {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const result = await chrome.runtime.sendMessage({
          type: "OFFSCREEN_CLASSIFY_IMAGE",
          imageUrl: message.imageUrl,
          imageDataUrl: message.imageDataUrl,
          cacheKey: message.cacheKey
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ error: String(err?.message || err) });
      }
    })();
    return true; // async response
  }

  return false;
});

async function incrementHiddenCount() {
  const { hiddenCount = 0 } = await chrome.storage.sync.get("hiddenCount");
  await chrome.storage.sync.set({ hiddenCount: hiddenCount + 1 });
}
