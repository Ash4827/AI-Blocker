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

  const TEXT_LOG = "[AI Post Blocker][facebook-text]";

  // Diagnostic: log the exact text classifyText() actually sees for every
  // post, unconditionally — not just on a miss. Added after a real post
  // (page name "AI IMAGE CREATOR [PROMPT]", caption hashtags "#AIContent
  // #GrowWithAI #AI #aiart #newpost") wasn't caught, to answer the
  // question directly rather than guess at it: is the [role="article"]
  // anchor actually capturing the page name/caption text, or is Facebook's
  // DOM putting it somewhere textOf() doesn't reach? Truncated to keep the
  // console readable; remove/gate behind a verbose flag if this gets noisy
  // in normal use.
  function logExtractedText(el) {
    const text = textOf(el).replace(/\s+/g, " ").trim();
    const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    console.log(`${TEXT_LOG} extracted (${text.length} chars): "${preview}"`);
  }

  // Facebook's class names are obfuscated/regenerated per build, so anchor
  // on the role attribute instead — each feed post is role="article".
  function getPostContainers() {
    return Array.from(document.querySelectorAll('[role="article"]'));
  }

  function getMediaTargets(el) {
    return getContentImages(el);
  }

  async function processPost(el) {
    if (!settings.enabled || !settings.platforms.facebook) return;
    logExtractedText(el);
    const decision = classifyText(el, settings);
    applyHideDecision(el, decision, settings);
    if (!decision.hidden) {
      await analyzePixelsIfEligible(el, settings, getMediaTargets);
    }
  }

  observeFeed(getPostContainers, processPost, {
    platform: "Facebook",
    selectorDescription: '[role="article"]'
  });

  onSettingsChanged(async () => {
    settings = await getSettings();
    if (!settings.enabled || !settings.platforms.facebook) {
      document
        .querySelectorAll(".ai-blocker-hidden, .ai-blocker-blurred")
        .forEach(clearHideState);
    }
  });
})();
