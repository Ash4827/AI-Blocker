// Caches pixel-analysis results by a stable key (image URL, or — for video
// frame-grabs where there's no stable URL — a caller-supplied cacheKey like
// the video's currentSrc). Keeps re-renders during scroll from re-running
// inference on media we've already classified.
(function () {
  const memCache = new Map();
  // chrome.storage.session requires Chrome 112+; degrade to memory-only cache
  // on older builds rather than throwing.
  const hasSessionStorage = !!chrome.storage?.session;

  async function hashKey(rawKey) {
    const bytes = new TextEncoder().encode(rawKey);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function getCached(rawKey) {
    const key = await hashKey(rawKey);
    if (memCache.has(key)) return memCache.get(key);
    if (!hasSessionStorage) return undefined;

    try {
      const stored = await chrome.storage.session.get(key);
      if (stored[key] !== undefined) {
        memCache.set(key, stored[key]);
        return stored[key];
      }
    } catch {
      // storage unavailable — fall through to a cache miss
    }
    return undefined;
  }

  async function setCached(rawKey, value) {
    const key = await hashKey(rawKey);
    memCache.set(key, value);
    if (!hasSessionStorage) return;
    try {
      await chrome.storage.session.set({ [key]: value });
    } catch {
      // best-effort persistence only; the in-memory cache still works
    }
  }

  window.AIBlockerCache = { getCached, setCached };
})();
