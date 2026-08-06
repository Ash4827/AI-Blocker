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

  const TEXT_LOG = "[AI Post Blocker][x-text]";

  // Diagnostic: log the exact text classifyText() sees for every post,
  // unconditionally — same pattern as facebook.js/reddit.js's flair
  // logging. Added during a cross-platform audit that also caught the
  // selector bug fixed below.
  function logExtractedText(el) {
    const text = textOf(el).replace(/\s+/g, " ").trim();
    const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    console.log(`${TEXT_LOG} extracted (${text.length} chars): "${preview}"`);
  }

  // X removed data-testid="tweet" at some point — the old selector matched
  // zero elements on live testing (see the Obsidian "Cross-Platform
  // Selector Audit" note). Real tweets now carry data-tweet-id plus
  // schema.org microdata (itemtype="https://schema.org/SocialMediaPosting")
  // instead; data-tweet-id is the stable anchor. Verified against 5 real
  // tweets: correct containers, correct text extraction, correct image
  // extraction (avatar filtered by size, real media image kept).
  function getPostContainers() {
    return Array.from(document.querySelectorAll("article[data-tweet-id]"));
  }

  function getMediaTargets(el) {
    return getContentImages(el);
  }

  async function processPost(el) {
    if (!settings.enabled || !settings.platforms.twitter) return;
    logExtractedText(el);
    const decision = classifyText(el, settings);
    applyHideDecision(el, decision, settings);
    if (!decision.hidden) {
      await analyzePixelsIfEligible(el, settings, getMediaTargets);
    }
  }

  observeFeed(getPostContainers, processPost, {
    platform: "X",
    selectorDescription: "article[data-tweet-id]"
  });

  onSettingsChanged(async () => {
    settings = await getSettings();
    if (!settings.enabled || !settings.platforms.twitter) {
      document
        .querySelectorAll(".ai-blocker-hidden, .ai-blocker-blurred")
        .forEach(clearHideState);
    }
  });
})();
