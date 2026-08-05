(async function () {
  const {
    getSettings,
    onSettingsChanged,
    classifyText,
    applyHideDecision,
    clearHideState,
    analyzePixelsIfEligible,
    observeFeed,
    getContentImages
  } = window.AIBlocker;

  let settings = await getSettings();

  // Reddit's current (Shreddit) frontend renders each post as a
  // <shreddit-post> custom element, not the legacy .thing/.link markup.
  //
  // Caveat: "hide completely" mode (display: none on the element) works
  // regardless of shadow DOM internals. "Blur" mode appends an overlay into
  // the element's light DOM, which only renders if shreddit-post's shadow
  // template has an unnamed <slot> to project it into — unverified. If the
  // overlay doesn't appear on Reddit, switch this platform to hide mode.
  function getPostContainers() {
    return Array.from(document.querySelectorAll("shreddit-post"));
  }

  function getMediaTargets(el) {
    // shreddit-post's media may live in an open shadow root; getContentImages
    // already checks one level of shadow DOM via queryAllDeep. If Reddit ever
    // switches to a closed shadow root this will silently find nothing and
    // pixel analysis will no-op for Reddit (fails open, not closed).
    return getContentImages(el);
  }

  async function processPost(el) {
    if (!settings.enabled || !settings.platforms.reddit) return;
    const decision = classifyText(el, settings);
    applyHideDecision(el, decision, settings);
    if (!decision.hidden) {
      await analyzePixelsIfEligible(el, settings, getMediaTargets);
    }
  }

  observeFeed(getPostContainers, processPost, {
    platform: "Reddit",
    selectorDescription: "shreddit-post"
  });

  onSettingsChanged(async () => {
    settings = await getSettings();
    if (!settings.enabled || !settings.platforms.reddit) {
      document
        .querySelectorAll(".ai-blocker-hidden, .ai-blocker-blurred")
        .forEach(clearHideState);
    }
  });
})();
