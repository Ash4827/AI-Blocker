(async function () {
  const {
    getSettings,
    onSettingsChanged,
    classifyText,
    applyHideDecision,
    clearHideState,
    analyzePixelsIfEligible,
    observeFeed
  } = window.AIBlocker;

  let settings = await getSettings();

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
  // analysis here is best-effort only — see comment on grabVideoFrame.
  function grabVideoFrame(video) {
    try {
      if (!video || !video.videoWidth) return null;
      const MAX_DIM = 224;
      const scale = Math.min(1, MAX_DIM / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      // toDataURL throws (SecurityError) if the video element's underlying
      // resource was fetched without CORS clearance, which is the common
      // case for TikTok's CDN — expect this to fail more often than not.
      return canvas.toDataURL("image/jpeg", 0.8);
    } catch {
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
