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
    queryAllDeep
  } = window.AIBlocker;

  let settings = await getSettings();

  const FLAIR_LOG = "[AI Post Blocker][reddit-flair]";

  // Mod/community-assigned flair is a curated, short label — not free-form
  // caption text — so a bare "ai" is safe to match here in a way it
  // wouldn't be in HEURISTIC_KEYWORDS (common.js), which is tuned for
  // prose and needs 2+ hits to avoid false positives. Flair only needs one.
  const FLAIR_AI_KEYWORDS = [
    /\bai\b/i,
    /\bai[\s-]?generated\b/i,
    /\bai[\s-]?art\b/i,
    /\bmidjourney\b/i,
    /\bstable diffusion\b/i,
    /\bdall-?e\b/i,
    /\bsora\b/i
  ];

  // Reddit's exact flair markup could NOT be verified against a live DOM —
  // this environment couldn't reach reddit.com (sandboxed browser tool
  // blocks the domain by policy; a direct fetch hit Reddit's bot-detection
  // challenge instead of real content). This tries several plausible
  // strategies, most-to-least specific, and logs whenever one actually
  // finds something (see below) so you can visually confirm on a real
  // flaired post whether any of these are actually firing. If none ever
  // fire on posts you know have flair, open DevTools on one and adjust
  // this function — it's the sole boundary this feature depends on.
  function extractFlairText(el) {
    // 1) Reddit's Shreddit frontend exposes a lot of post metadata as
    // attributes directly on <shreddit-post> for SSR — cheapest and most
    // reliable path if it exists, no shadow-DOM traversal needed.
    const attrText = el.getAttribute("post-flair-text");
    if (attrText) return attrText.trim();

    // 2) A dedicated flair custom element, if Reddit uses one (consistent
    // with their general pattern of granular custom elements).
    const flairEl = queryAllDeep(el, "shreddit-post-flair")[0];
    if (flairEl) {
      const t = (flairEl.textContent || "").trim();
      if (t) return t;
    }

    // 3) Slot-based projection into shadow DOM, Reddit's common pattern.
    const slotted = queryAllDeep(el, '[slot="post-flair"], [slot*="flair" i]')[0];
    if (slotted) {
      const t = (slotted.textContent || "").trim();
      if (t) return t;
    }

    // 4) Broad fallback: any class/id mentioning "flair".
    const generic = queryAllDeep(el, '[class*="flair" i], [id*="flair" i]')[0];
    if (generic) {
      const t = (generic.textContent || "").trim();
      if (t) return t;
    }

    return "";
  }

  function checkFlairForAi(el) {
    const flairText = extractFlairText(el);
    if (!flairText) return null;

    console.log(`${FLAIR_LOG} found flair text: "${flairText}"`);

    for (const pattern of FLAIR_AI_KEYWORDS) {
      if (pattern.test(flairText)) return { text: flairText, pattern: pattern.source };
    }
    return null;
  }

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

    // Flair check first: a high-confidence, near-zero-false-positive
    // signal, routed through the same "label" path as an official platform
    // AI label — same weight, same free/unlimited treatment, gated by the
    // same detectLabels toggle (not a separate setting).
    if (settings.detectLabels) {
      const flairMatch = checkFlairForAi(el);
      if (flairMatch) {
        applyHideDecision(
          el,
          { hidden: true, reason: "label", detail: `flair: "${flairMatch.text}"` },
          settings
        );
        return;
      }
    }

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
