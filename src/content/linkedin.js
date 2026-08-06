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

  const TEXT_LOG = "[AI Post Blocker][linkedin-text]";

  // Diagnostic: log the exact text classifyText() sees for every post,
  // unconditionally — same pattern as facebook.js/reddit.js's flair
  // logging. LinkedIn could not be live-tested during the cross-platform
  // audit this was added in (fully login-walled — even public company
  // pages redirect to a signup wall, unlike Facebook/X/Instagram/TikTok,
  // which all had some public-access path). This selector and the text
  // extraction it feeds remain entirely unverified against real markup;
  // this log is the way to actually check once someone can test logged in.
  function logExtractedText(el) {
    const text = textOf(el).replace(/\s+/g, " ").trim();
    const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    console.log(`${TEXT_LOG} extracted (${text.length} chars): "${preview}"`);
  }

  // Every feed post carries a stable [data-urn] identifying it, regardless
  // of the (frequently-changing) class names LinkedIn ships around it.
  function getPostContainers() {
    return Array.from(document.querySelectorAll("[data-urn]"));
  }

  function getMediaTargets(el) {
    return getContentImages(el);
  }

  async function processPost(el) {
    if (!settings.enabled || !settings.platforms.linkedin) return;
    logExtractedText(el);
    const decision = classifyText(el, settings);
    applyHideDecision(el, decision, settings);
    if (!decision.hidden) {
      await analyzePixelsIfEligible(el, settings, getMediaTargets);
    }
  }

  observeFeed(getPostContainers, processPost, {
    platform: "LinkedIn",
    selectorDescription: "[data-urn]"
  });

  onSettingsChanged(async () => {
    settings = await getSettings();
    if (!settings.enabled || !settings.platforms.linkedin) {
      document
        .querySelectorAll(".ai-blocker-hidden, .ai-blocker-blurred")
        .forEach(clearHideState);
    }
  });
})();
