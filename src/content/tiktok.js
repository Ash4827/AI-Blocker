(async function () {
  const {
    getSettings,
    onSettingsChanged,
    classifyText,
    applyHideDecision,
    clearHideState,
    analyzePixelsIfEligible,
    observeFeed,
    textOf
  } = window.AIBlocker;

  let settings = await getSettings();

  const TEXT_LOG = "[AI Post Blocker][tiktok-text]";
  const MEDIA_LOG = "[AI Post Blocker][tiktok-media]";

  // Diagnostic: log the exact text classifyText() sees for every post,
  // unconditionally — same pattern as facebook.js/reddit.js's flair
  // logging. Live-tested against TikTok's real (logged-out, publicly
  // viewable) feed during a cross-platform audit: the container selector
  // matched correctly and innerText cleanly captured username + caption +
  // hashtags on real posts, so this is a lower-risk platform than
  // Facebook/Instagram/X turned out to be — logged anyway for parity and
  // to keep confirming it as TikTok's markup evolves.
  function logExtractedText(el) {
    const text = textOf(el).replace(/\s+/g, " ").trim();
    const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    console.log(`${TEXT_LOG} extracted (${text.length} chars): "${preview}"`);
  }

  // TikTok's feed markup is especially volatile; this selector covers the
  // For You / Following feed item wrapper as of writing. The 0-match
  // console warning (see common.js) is the signal to update it.
  function getPostContainers() {
    return Array.from(
      document.querySelectorAll(
        '[data-e2e="recommend-list-item-container"], [data-e2e="explore-item"]'
      )
    );
  }

  // TikTok is video-first: there's rarely a static image to hash, so the
  // primary signal is caption/hashtag text (handled generically by
  // classifyText via the container's innerText/aria/alt/title). Pixel
  // analysis here is best-effort — see comment on grabVideoFrame.
  //
  // Revised expectation, not just theory: a cross-platform audit live-
  // tested this against TikTok's real public feed and the canvas grab
  // succeeded on 2/2 sampled videos (not the tainted-canvas SecurityError
  // this comment used to assume "more often than not") — worth treating as
  // "genuinely best-effort, outcome varies by video" rather than "expect
  // failure," pending a larger sample. The MEDIA_LOG line below records
  // which outcome actually happens on any given video, so this can keep
  // being checked rather than re-assumed.
  function grabVideoFrame(video) {
    try {
      if (!video || !video.videoWidth) {
        console.log(`${MEDIA_LOG} no video or video not yet loaded (videoWidth=0) — skipped`);
        return null;
      }
      const MAX_DIM = 224;
      const scale = Math.min(1, MAX_DIM / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      // toDataURL throws (SecurityError) if the video element's underlying
      // resource was fetched without CORS clearance — see the comment above
      // on how often this actually happens in practice.
      const frame = canvas.toDataURL("image/jpeg", 0.8);
      console.log(
        `${MEDIA_LOG} frame grab succeeded (${video.videoWidth}x${video.videoHeight} source, ` +
          `${frame.length} char data URL) — src: ${video.currentSrc || video.poster || "(none)"}`
      );
      return frame;
    } catch (err) {
      console.log(
        `${MEDIA_LOG} frame grab FAILED [${err.name}] (tainted canvas — CORS clearance not granted ` +
          `for this video's source) — falling back to text-only detection for this post`
      );
      return null;
    }
  }

  function getMediaTargets(el) {
    const video = el.querySelector("video");
    if (!video) return [];
    const frame = grabVideoFrame(video);
    if (!frame) return [];
    // Cache by the video's source (or poster) rather than the frame data
    // itself, so scrolling back past the same clip reuses the prior result
    // instead of re-running inference on a fresh, differently-encoded grab.
    const cacheKey = video.currentSrc || video.poster || frame;
    return [{ kind: "dataurl", value: frame, cacheKey }];
  }

  async function processPost(el) {
    if (!settings.enabled || !settings.platforms.tiktok) return;
    logExtractedText(el);
    const decision = classifyText(el, settings);
    applyHideDecision(el, decision, settings);
    if (!decision.hidden) {
      await analyzePixelsIfEligible(el, settings, getMediaTargets);
    }
  }

  observeFeed(getPostContainers, processPost, {
    platform: "TikTok",
    selectorDescription:
      '[data-e2e="recommend-list-item-container"], [data-e2e="explore-item"]'
  });

  onSettingsChanged(async () => {
    settings = await getSettings();
    if (!settings.enabled || !settings.platforms.tiktok) {
      document
        .querySelectorAll(".ai-blocker-hidden, .ai-blocker-blurred")
        .forEach(clearHideState);
    }
  });
})();
