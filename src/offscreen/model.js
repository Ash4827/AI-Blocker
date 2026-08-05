// Thin wrapper around ONNX Runtime Web. The model weights are NOT bundled
// in the extension package — they're fetched from MODEL_DOWNLOAD_URL and
// cached in IndexedDB (weights-store.js) the first time pixel analysis
// actually runs an inference, per the "keep the default install small"
// requirement. See models/README.md and the Obsidian note "Pixel Analysis
// Model" for the full rationale and how to point this at real hosting.
(function () {
  const MODEL_ID = "ai-vs-human-generated-v1";

  // TODO: after creating a GitHub Release and attaching
  // ai-image-detector.onnx as its asset (see the Obsidian "Lazy Model
  // Loading" note), replace <user>/<repo>/<tag> below with yours. GitHub
  // Release asset URLs follow this exact pattern:
  const MODEL_DOWNLOAD_URL =
    "https://github.com/<user>/<repo>/releases/download/<tag>/ai-image-detector.onnx";

  const INPUT_SIZE = 224;
  // dima806/ai_vs_human_generated_image_detection's preprocessor_config.json:
  // ViTImageProcessor, rescale by 1/255 then normalize with mean=std=0.5 on
  // every channel (i.e. maps [0,1] to [-1,1]). Adjust here if you swap in a
  // different model with a different preprocessing contract.
  const CHANNEL_MEAN = [0.5, 0.5, 0.5];
  const CHANNEL_STD = [0.5, 0.5, 0.5];

  const { getStoredWeights, storeWeights } = window.AIBlockerWeightsStore;

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
        .then((bytes) => ort.InferenceSession.create(new Uint8Array(bytes)))
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

  async function classifyBitmap(bitmap) {
    const session = await getSession();
    const tensor = await bitmapToTensor(bitmap);
    const inputName = session.inputNames[0];
    const outputs = await session.run({ [inputName]: tensor });
    const outputName = session.outputNames[0];
    return toAiProbability(outputs[outputName].data);
  }

  window.AIBlockerModel = { classifyBitmap };
})();
