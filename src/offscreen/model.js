// Thin wrapper around ONNX Runtime Web. The model weights are NOT bundled
// in the extension package — they're fetched from MODEL_DOWNLOAD_URL and
// cached in IndexedDB (weights-store.js) the first time pixel analysis
// actually runs an inference, per the "keep the default install small"
// requirement. See models/README.md and the Obsidian note "Pixel Analysis
// Model" for the full rationale and how to point this at real hosting.
(function () {
  const MODEL_ID = "ai-vs-human-generated-v1";

  // GitHub Release assets don't work here: the download URL 302s to a
  // signed release-assets.githubusercontent.com/blob-storage URL with no
  // Access-Control-Allow-Origin header on any hop, so fetch() from an
  // extension page fails with an opaque "TypeError: Failed to fetch"
  // every time, regardless of host_permissions. raw.githubusercontent.com
  // serves the file directly with `Access-Control-Allow-Origin: *`
  // (verified), which is why this points there instead — see the Obsidian
  // "Pixel Analysis Sync Error" note for the confirmation and the
  // tradeoff (this repo now carries an 83MB binary in git history;
  // revisit with a real CDN, e.g. Cloudflare R2, if this gets real
  // traffic).
  const MODEL_DOWNLOAD_URL =
    "https://raw.githubusercontent.com/Ash4827/AI-Blocker/master/scripts/ai-image-detector.onnx";

  const INPUT_SIZE = 224;
  // dima806/ai_vs_human_generated_image_detection's preprocessor_config.json:
  // ViTImageProcessor, rescale by 1/255 then normalize with mean=std=0.5 on
  // every channel (i.e. maps [0,1] to [-1,1]). Adjust here if you swap in a
  // different model with a different preprocessing contract.
  const CHANNEL_MEAN = [0.5, 0.5, 0.5];
  const CHANNEL_STD = [0.5, 0.5, 0.5];

  const { getStoredWeights, storeWeights, deleteWeights } = window.AIBlockerWeightsStore;

  const LOG = "[AI Post Blocker][model]";

  let sessionPromise = null;
  let warnedMissing = false;

  function warnOnce(message) {
    if (warnedMissing) return;
    warnedMissing = true;
    console.warn(`[AI Post Blocker] ${message}`);
  }

  async function setModelStatus(patch) {
    try {
      await chrome.storage.local.set({
        modelStatus: { ...patch, updatedAt: Date.now() }
      });
    } catch {
      // status reporting is best-effort UI sugar for the popup; never fatal
    }
  }

  async function loadModelBytes() {
    const cached = await getStoredWeights(MODEL_ID);
    if (cached) return cached;

    await setModelStatus({ state: "downloading" });
    const response = await fetch(MODEL_DOWNLOAD_URL);
    if (!response.ok) {
      throw new Error(`model download failed: HTTP ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    await storeWeights(MODEL_ID, bytes);
    await setModelStatus({ state: "ready", sizeBytes: bytes.byteLength });
    return bytes;
  }

  function getSession() {
    if (!sessionPromise) {
      sessionPromise = loadModelBytes()
        .then((bytes) =>
          ort.InferenceSession.create(new Uint8Array(bytes)).catch((err) => {
            // Parsing failed on bytes we just handed it. If they came from
            // IndexedDB rather than a fresh download, they may be corrupted
            // from an interrupted download in a *prior* session — nothing
            // ever validates cached bytes before reusing them, so a bad
            // cache entry would otherwise repeat this exact failure forever.
            // Clear it so the next attempt re-downloads instead.
            console.warn(
              `${LOG} InferenceSession.create() failed on cached model bytes — ` +
                `clearing the cache so the next attempt re-downloads`,
              err?.stack || err
            );
            deleteWeights(MODEL_ID).catch(() => {});
            throw err;
          })
        )
        .catch((err) => {
          sessionPromise = null;
          setModelStatus({ state: "error", error: String(err?.message || err) });
          warnOnce(
            "Pixel-analysis model could not be loaded (no model hosted yet at " +
              "MODEL_DOWNLOAD_URL in src/offscreen/model.js) — pixel analysis will " +
              "no-op until one is available."
          );
          throw err;
        });
    }
    return sessionPromise;
  }

  async function bitmapToTensor(bitmap) {
    const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, INPUT_SIZE, INPUT_SIZE);
    const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);

    // NCHW, RGB, rescaled to [0,1] then normalized per-channel with
    // (x - mean) / std. This is the one place the preprocessing contract
    // lives — change CHANNEL_MEAN/STD above if you swap models instead of
    // editing the loop itself.
    const plane = INPUT_SIZE * INPUT_SIZE;
    const floatData = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      floatData[i] = (data[i * 4] / 255 - CHANNEL_MEAN[0]) / CHANNEL_STD[0];
      floatData[plane + i] = (data[i * 4 + 1] / 255 - CHANNEL_MEAN[1]) / CHANNEL_STD[1];
      floatData[plane * 2 + i] = (data[i * 4 + 2] / 255 - CHANNEL_MEAN[2]) / CHANNEL_STD[2];
    }
    return new ort.Tensor("float32", floatData, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  }

  function toAiProbability(outputData) {
    // dima806/ai_vs_human_generated_image_detection: 2-class raw logits,
    // id2label = { 0: "human", 1: "AI-generated" } — softmax, take index 1.
    if (outputData.length === 1) return outputData[0];
    const max = Math.max(...outputData);
    const exps = Array.from(outputData, (v) => Math.exp(v - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps[exps.length - 1] / sum;
  }

  // Serializes every touch of the shared InferenceSession (getSession() +
  // session.run()) through a single in-process promise chain. Building the
  // tensor is left OUTSIDE the queue on purpose — it only touches locals
  // (a fresh OffscreenCanvas/Float32Array per call), so it's safe to run
  // concurrently and gating it too would just add needless latency.
  //
  // Why this exists: ONNX Runtime Web's WASM backend runs one shared
  // linear-memory execution context per InferenceSession — concurrent
  // session.run() calls on the same session are not a supported pattern
  // (ONNX Runtime's own docs on this: the recommended fix for parallel
  // inference is a *pool* of sessions, not concurrent calls on one — see
  // e.g. their CUDA-provider guidance, which documents the same
  // constraint). Our architecture guarantees concurrent calls happen:
  // observeFeed() in common.js deliberately doesn't await onFound(), so a
  // batch of newly-scrolled posts fires many classifyBitmap() calls at
  // once, all against this one shared session. This is the same fix
  // pattern already applied to the quota counter in offscreen.js, for the
  // same underlying reason — shared mutable state, no built-in locking,
  // concurrent writers.
  let inferenceQueue = Promise.resolve();
  // Diagnostic only: counts calls currently queued/running, so we can
  // directly confirm (or rule out) real-world contention rather than just
  // trust the reasoning above. If this never exceeds 1, concurrency isn't
  // actually the issue and the "sync" error has a different cause.
  let inFlight = 0;

  function runQueued(tensor) {
    inFlight++;
    if (inFlight > 1) {
      console.log(`${LOG} inference queue contention: ${inFlight} calls in flight, serializing`);
    }
    const attempt = inferenceQueue.then(async () => {
      try {
        const session = await getSession();
        const inputName = session.inputNames[0];
        const outputs = await session.run({ [inputName]: tensor });
        const outputName = session.outputNames[0];
        return toAiProbability(outputs[outputName].data);
      } finally {
        inFlight--;
      }
    });
    // Keep the queue itself always-resolved so one failed run doesn't jam
    // every run after it; the real result/error still flows to this
    // call's own caller via `attempt`.
    inferenceQueue = attempt.catch(() => {});
    return attempt;
  }

  async function classifyBitmap(bitmap) {
    const tensor = await bitmapToTensor(bitmap);
    return runQueued(tensor);
  }

  window.AIBlockerModel = { classifyBitmap };
})();
