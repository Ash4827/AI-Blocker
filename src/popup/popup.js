const PLATFORM_IDS = ["instagram", "twitter", "facebook", "linkedin", "reddit", "tiktok"];

const els = {
  enabled: document.getElementById("enabled"),
  detectLabels: document.getElementById("detect-labels"),
  detectHeuristics: document.getElementById("detect-heuristics"),
  detectPixels: document.getElementById("detect-pixels"),
  quotaStatus: document.getElementById("quota-status"),
  isPro: document.getElementById("is-pro"),
  modeBlur: document.getElementById("mode-blur"),
  modeHide: document.getElementById("mode-hide"),
  hiddenCount: document.getElementById("hidden-count"),
  resetCount: document.getElementById("reset-count"),
  platforms: Object.fromEntries(
    PLATFORM_IDS.map((id) => [id, document.getElementById(`platform-${id}`)])
  )
};

async function load() {
  const settings = await chrome.storage.sync.get(null);
  els.enabled.checked = settings.enabled ?? true;
  for (const id of PLATFORM_IDS) {
    els.platforms[id].checked = settings.platforms?.[id] ?? true;
  }
  els.detectLabels.checked = settings.detectLabels ?? true;
  els.detectHeuristics.checked = settings.detectHeuristics ?? true;
  els.detectPixels.checked = settings.pixelAnalysis ?? false;
  els.isPro.checked = settings.isPro ?? false;
  const mode = settings.mode ?? "blur";
  els.modeBlur.checked = mode === "blur";
  els.modeHide.checked = mode === "hide";
  renderCount(settings.hiddenCount ?? 0);
  await refreshQuota();
}

function renderCount(count) {
  els.hiddenCount.textContent = `${count} post${count === 1 ? "" : "s"} hidden`;
}

async function refreshQuota() {
  const quota = await chrome.runtime.sendMessage({ type: "GET_PIXEL_QUOTA_STATUS" });
  if (!quota) return;
  els.quotaStatus.textContent = quota.isPro
    ? "Pro: unlimited pixel scans"
    : `${quota.remaining} / ${quota.limit} free pixel scans left today`;
}

function save(partial) {
  chrome.storage.sync.set(partial);
}

els.enabled.addEventListener("change", () => save({ enabled: els.enabled.checked }));

for (const id of PLATFORM_IDS) {
  els.platforms[id].addEventListener("change", async () => {
    const { platforms = {} } = await chrome.storage.sync.get("platforms");
    save({ platforms: { ...platforms, [id]: els.platforms[id].checked } });
  });
}

els.detectLabels.addEventListener("change", () =>
  save({ detectLabels: els.detectLabels.checked })
);

els.detectHeuristics.addEventListener("change", () =>
  save({ detectHeuristics: els.detectHeuristics.checked })
);

els.detectPixels.addEventListener("change", () =>
  save({ pixelAnalysis: els.detectPixels.checked })
);

els.isPro.addEventListener("change", async () => {
  save({ isPro: els.isPro.checked });
  await refreshQuota();
});

els.modeBlur.addEventListener("change", () => save({ mode: "blur" }));
els.modeHide.addEventListener("change", () => save({ mode: "hide" }));

els.resetCount.addEventListener("click", () => {
  save({ hiddenCount: 0 });
  renderCount(0);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.hiddenCount) {
    renderCount(changes.hiddenCount.newValue ?? 0);
  }
  if ((area === "sync" && changes.isPro) || (area === "local" && changes.pixelScansUsedToday)) {
    refreshQuota();
  }
});

load();
