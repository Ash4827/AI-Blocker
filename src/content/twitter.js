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
  // logging. Added during a cross-platform audit: live-testing against a
  // real public profile found article[data-testid="tweet"] matching ZERO
  // elements — X removed data-testid="tweet" entirely; real posts now use
  // article[data-tweet-id] plus schema.org microdata instead. This log
  // exists independent of that selector question, for whenever the
  // container selector is fixed and the actual text-extraction quality
  // needs checking too.
  function logExtractedText(el) {
    const text = textOf(el).replace(/\s+/g, " ").trim();
    const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    console.log(`${TEXT_LOG} extracted (${text.length} chars): "${preview}"`);
  }

  // Every tweet/post in the timeline is an <article data-testid="tweet">.
  function getPostContainers() {
    return Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
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
    selectorDescription: 'article[data-testid="tweet"]'
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
