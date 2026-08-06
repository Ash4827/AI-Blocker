# AI Post Blocker

Manifest V3 Chrome extension that hides posts on Instagram, X, Facebook,
LinkedIn, Reddit, and TikTok that are either explicitly labeled
AI-generated, show heuristic text signals of being AI-generated, or —
optionally — score highly on a local, on-device pixel scan.

## How it works

- **`src/content/common.js`** — shared detection engine, injected on every
  matched page before the site-specific script. Exposes `window.AIBlocker`.
- **`src/content/{instagram,twitter,facebook,linkedin,reddit,tiktok}.js`** —
  walk each site's post containers and hand them to the shared classifier:
  - Instagram: `article`
  - X: `article[data-testid="tweet"]`
  - Facebook: `[role="article"]` (class names are obfuscated/unstable)
  - LinkedIn: `[data-urn]`
  - Reddit: `shreddit-post` (current frontend's custom element, not the
    legacy `.thing` markup)
  - TikTok: `[data-e2e="recommend-list-item-container"]` /
    `[data-e2e="explore-item"]` — this one drifts the most; watch the
    console warning described below.
- Detection has three tiers, each independently toggleable in the popup:
  1. **Label matching** — regex over visible text, `alt`, `aria-label`, and
     `title` attributes for explicit markers like "AI info", "Made with AI".
  2. **Heuristics** — weaker text signals (hashtags, tool names like
     Midjourney/Stable Diffusion/Sora, "prompt:"). Requires **two or more**
     distinct hits before flagging, to keep false positives down.
  3. **Pixel analysis** (off by default) — runs a local ONNX model against
     a post's images (or, on TikTok, a canvas frame-grab of the video) and
     flags it if the model's AI-probability is ≥ 0.75. Only runs on posts
     the first two tiers did **not** already flag, to avoid wasted compute.
- Matched posts are either blurred (with a "Show anyway" reveal button,
  default) or fully hidden, per the popup setting.
- A `MutationObserver` re-scans each feed as new posts load via infinite
  scroll, and warns in the console if a platform's post selector goes from
  matching posts to matching zero — the signal that site markup drifted.

## Pixel analysis architecture

- **Inference runs in an offscreen document** (`src/offscreen/`), not the
  content script, so a busy model doesn't janky-up page scroll. Content
  scripts message the background service worker
  (`CLASSIFY_IMAGE_PIXELS`), which lazily creates the offscreen document
  (`chrome.offscreen`) and relays the request to it.
- **Runtime**: [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/)
  (WASM backend, single-threaded to avoid needing cross-origin isolation),
  vendored into `lib/onnxruntime-web/` from the upstream npm package
  (MIT-licensed) — no CDN loads, satisfying MV3's no-remote-code policy.
- **Model**: [`dima806/ai_vs_human_generated_image_detection`](https://huggingface.co/dima806/ai_vs_human_generated_image_detection)
  (Apache-2.0, verified via the HF Hub API — see `models/README.md` for
  the full license evaluation against alternatives). Ships as PyTorch only,
  so it's converted to ONNX locally (see `models/README.md` for the
  conversion script and result).
- **Not bundled in the package** — the `.onnx` weights are fetched over the
  network and cached in **IndexedDB** (`src/offscreen/weights-store.js`)
  the first time pixel analysis actually runs an inference, not merely when
  the popup toggle is flipped. Until then, the install stays small and
  nothing extra downloads. Hosted at `raw.githubusercontent.com` (not
  GitHub Releases — Release asset URLs redirect to a signed blob-storage
  URL with no CORS header on any hop, so `fetch()` fails there
  unconditionally; verified before switching). See `models/README.md`
  for the full hosting story — the model file itself is tracked in this
  repo as a result (`scripts/ai-image-detector.onnx`, ~83 MB).
- **Gating**: `analyzePixelsIfEligible()` in `common.js` only fires for
  posts the label/heuristic tiers left unflagged, capped at 3 images/videos
  per post, and only if the free daily allowance isn't exhausted (see
  "Freemium gating" below).
- **Caching**: results are cached by a stable key (the image URL, or for
  TikTok's video frames, the video's `currentSrc`/poster — not the
  frame data itself, since each grab re-encodes to a different blob). Keys
  are SHA-256 hashed and stored in `chrome.storage.session` (cleared on
  browser restart) plus an in-memory `Map` for the offscreen document's
  lifetime, so virtualized-scroll re-renders don't re-run inference on
  media already scored.
- **Cross-origin image fetch**: the offscreen document fetches image URLs
  directly, which requires `host_permissions` for each platform's media CDN
  (`*.cdninstagram.com`, `*.fbcdn.net`, `pbs.twimg.com`, `*.licdn.com`,
  `*.redd.it`, `*.redditmedia.com`, `www.redditstatic.com` — declared in
  `manifest.json`). These hosts can change; if pixel analysis silently
  stops working for a platform, check whether its CDN domain moved.
  `www.redditstatic.com` (avatar images) was missed initially — it's not
  a subdomain of `redd.it`, so the `*.redd.it` wildcard never covered it,
  and every avatar fetch failed with an opaque `TypeError: Failed to
  fetch` until it was added explicitly.

## Freemium gating

Label/heuristic detection is free and unlimited on every platform, no
change there. Pixel analysis is metered:

- **`isPro`** — a local `chrome.storage.sync` flag, default `false`. No
  real payment/license verification exists yet; flipping it (currently via
  a dev-only checkbox in the popup) is the entire "upgrade" path today.
- **Free allowance** — 15 pixel scans/day (`FREE_DAILY_PIXEL_SCANS`,
  duplicated as a constant in both `src/background.js` and
  `src/offscreen/offscreen.js` — no bundler here to share it from one
  place) when `isPro` is false.
- **Where it's enforced**: inside `src/offscreen/offscreen.js`, *after*
  the cache check and *before* running inference — a cache hit (an image
  you've already scanned) doesn't cost a scan; only a fresh inference
  does. Quota counters live in `chrome.storage.local`, not `.sync`, since
  they can be written once per image during active scrolling and
  `.sync` enforces a write-rate cap that could plausibly trip.
- **What happens at the limit**: the offscreen document returns
  `{ quotaExceeded: true }` instead of running inference; the content
  script (`analyzePixelsIfEligible` in `common.js`) treats that as "stop
  trying, not an error" — the post stays visible (no false hide), and a
  local flag stops that page from sending further doomed requests for the
  rest of its lifetime. The popup shows remaining scans via a
  `GET_PIXEL_QUOTA_STATUS` message to the background script.
- **Known imprecision**: quota consumption isn't transactionally safe
  against a burst of concurrent scans across many tabs (`chrome.storage`
  isn't a lock) — usage could overshoot the daily limit by a small margin
  under heavy concurrent scrolling. Acceptable for a soft allowance meant
  to demonstrate the feature, not a hard security boundary.

## Load it locally

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Visit any supported platform — the toolbar icon opens the settings
   popup.

## Settings (via popup)

- Master on/off switch
- Per-platform toggle (Instagram / X / Facebook / LinkedIn / Reddit /
  TikTok)
- Toggle label-based, heuristic-based, and pixel-based detection
  independently
- Pixel-analysis quota display (remaining free scans today, or "Pro:
  unlimited")
- `isPro` dev toggle (no real billing yet — see "Freemium gating" below)
- Blur-with-reveal vs. hide-completely
- Running count of posts hidden this session (resettable)

## Bundle size & accuracy — read before shipping

**Size impact of bundling pixel analysis:**

- The ONNX Runtime Web WASM runtime alone (`lib/onnxruntime-web/`) is
  **~13 MB** — that's the smallest available build (single WASM binary,
  no WebGL/WebGPU backends, no training ops). This is a fixed cost the
  moment `offscreen.html` loads, regardless of model size.
- The actual chosen model (`dima806/ai_vs_human_generated_image_detection`,
  ViT-base, ~86M params) was converted and measured, not estimated:
  **327.5 MB** as FP32 ONNX, **82.9 MB** after dynamic INT8 quantization
  (verified to track the original PyTorch output closely — see
  `models/README.md`). A MobileNet-class detector would land smaller
  (5–15 MB) but none of the license-clean candidates evaluated used one —
  see `models/README.md` for the full evaluation.
- **Total lazy-loaded footprint**: ~83 MB model + ~13 MB ONNX Runtime Web
  runtime ≈ **~96 MB**, downloaded once (IndexedDB-cached after) only if
  the user actually turns pixel analysis on — never part of the base
  install. That's still substantial for something fetched over the
  network client-side; worth confirming this is an acceptable UX before
  shipping (a progress indicator is one natural follow-up — see the
  Obsidian "Lazy Model Loading" note's `modelStatus` field, wired for
  exactly this but not yet surfaced in the popup).

**Accuracy expectations, local lightweight model vs. cloud vision API:**

- Cloud AI-detection APIs (Hive, Sightengine, etc.) are retrained
  continuously against the newest generators and typically report
  90%+ accuracy on recent benchmarks, with active adversarial hardening.
- A local model small enough to bundle in a browser extension (MobileNet-
  class, quantized) will trail that meaningfully — expect noticeably
  higher false-negative rates against current-generation output
  (Midjourney v6+, Flux, Sora) and more false positives on heavily-
  edited/filtered real photos, since it can't be retrained/updated as
  fast as a hosted service and has far less capacity.
- Treat a pixel-analysis hit as "worth a second look," not ground truth.
  That's why it's gated behind its own toggle, defaults to off, and only
  ever runs on posts that passed the (cheaper, more precise) text tiers
  first — it's explicitly the least-trusted signal in this extension.

## Known limitations

- No platform exposes a stable public API for AI-content labels, so
  detection relies on scraping visible DOM text/attributes/selectors —
  these may drift as sites change their UI. The console warning described
  above is the early-warning signal.
- Heuristic and label detection are text-only; they miss AI content with
  no textual signal (that's what pixel analysis is for, with the caveats
  above).
- Reddit's `shreddit-post` may render its content in a shadow root; the
  extension checks one level of *open* shadow DOM but cannot see closed
  shadow roots or nested shadow trees. Reddit's "blur" mode overlay is
  appended into the element's light DOM, which only renders if
  `shreddit-post`'s template has an unnamed `<slot>` — unverified; switch
  Reddit to "hide completely" mode if the overlay doesn't appear.
- TikTok pixel analysis is genuinely best-effort: grabbing a video frame
  onto a `<canvas>` throws a `SecurityError` (tainted canvas) unless
  TikTok's CDN happens to grant CORS clearance for that video element,
  which is not the common case. When it fails, TikTok posts still get
  full label/heuristic text detection — they just skip the pixel tier.
- Re-enabling a platform toggle only affects posts scanned *after* that
  point; posts already unblurred from a prior "off" state won't be
  re-evaluated until the feed re-renders them as new DOM nodes.
- Icons in `icons/` are auto-generated placeholders — swap them for real
  artwork before publishing.
- `isPro` has no real payment/license verification behind it yet — it's a
  plain storage flag, flippable via the popup's dev checkbox.
- **The model binary is tracked in git** (`scripts/ai-image-detector.onnx`,
  ~83 MB) because it's hosted via `raw.githubusercontent.com`, which
  requires the file to actually live in the repo — GitHub Releases would
  have kept it out of history but its asset URLs don't support `fetch()`
  from an extension page at all (no CORS header on the redirect chain).
  See `models/README.md` for the full story. Revisit with a real CDN if
  repo size or a dedicated host ever starts to matter.
- **`chrome.storage` is unavailable inside the offscreen document** — per
  Chrome's own docs, `chrome.runtime` is the only extensions API
  supported there. Any new code added to `src/offscreen/*.js` that needs
  persistent storage has to relay through `background.js` (see how
  `CONSUME_PIXEL_QUOTA` does it) rather than calling `chrome.storage`
  directly — the latter will throw `Cannot read properties of undefined
  (reading '...')` unconditionally, not intermittently.
