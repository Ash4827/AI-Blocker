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

// Quota is actually *consumed* in src/offscreen/offscreen.js, not here —
// it has to happen after the cache check (a cache hit shouldn't cost a
// scan) and right before inference, both of which live there. This
// handler only relays; readPixelQuota() above is read-only, for the popup.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "POST_HIDDEN") {
    incrementHiddenCount();
    return false;
  }

  if (message?.type === "GET_PIXEL_QUOTA_STATUS") {
    readPixelQuota().then(sendResponse);
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
