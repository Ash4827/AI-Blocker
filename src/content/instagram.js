(async function () {
  const {
    getSettings,
    onSettingsChanged,
    classifyText,
    applyHideDecision,
    clearHideState,
    analyzePixelsIfEligible,
    observeFeed,
    getContentImages,
    textOf
  } = window.AIBlocker;

  let settings = await getSettings();

  const TEXT_LOG = "[AI Post Blocker][instagram-text]";

  // Diagnostic: log the exact text classifyText() sees for every post,
  // unconditionally — same pattern as facebook.js/reddit.js's flair
  // logging. Added during a cross-platform audit prompted by a Facebook
  // extraction miss; live-tested single-post permalinks on real Instagram
  // pages showed zero <article> elements at all (see the Obsidian
  // "Facebook Text and Image Extraction Fix" note's cross-platform audit
  // section) — this log exists to confirm whether that also means
  // classifyText() is silently seeing empty/near-empty text here.
  function logExtractedText(el) {
    const text = textOf(el).replace(/\s+/g, " ").trim();
    const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    console.log(`${TEXT_LOG} extracted (${text.length} chars): "${preview}"`);
  }

  // Each feed/reel/profile-grid post on Instagram is rendered as an <article>.
  function getPostContainers() {
    return Array.from(document.querySelectorAll("article"));
  }

  function getMediaTargets(el) {
    return getContentImages(el);
  }

  async function processPost(el) {
    if (!settings.enabled || !settings.platforms.instagram) return;
    logExtractedText(el);
    const decision = classifyText(el, settings);
    applyHideDecision(el, decision, settings);
    if (!decision.hidden) {
      await analyzePixelsIfEligible(el, settings, getMediaTargets);
    }
  }

  observeFeed(getPostContainers, processPost, {
    platform: "Instagram",
    selectorDescription: "article"
  });

  onSettingsChanged(async () => {
    settings = await getSettings();
    if (!settings.enabled || !settings.platforms.instagram) {
      document
        .querySelectorAll(".ai-blocker-hidden, .ai-blocker-blurred")
        .forEach(clearHideState);
    }
  });
})();
