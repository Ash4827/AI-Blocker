# Pixel-analysis model

## Model chosen: `dima806/ai_vs_human_generated_image_detection`

Evaluated three candidates against the Hugging Face Hub API directly
(`https://huggingface.co/api/models/{id}`), not just the rendered model
card, since license info can be missing from one and present in the other:

| Candidate | License (verified) | Verdict |
|---|---|---|
| `dima806/ai_vs_real_image_detection` | Apache-2.0 | Rejected — trained on CIFAKE (32×32 CIFAR-style objects upscaled), a poor match for real photos/illustrations. |
| **`dima806/ai_vs_human_generated_image_detection`** | **Apache-2.0** | **Chosen.** General "AI vs human" images (not face-specific), ~1 year old training data, 97.9% accuracy on its own test set. |
| `LPX55/detection-model-1-ONNX` (base: `haywoodsloan/ai-image-detector-deploy`) | **None found** — no license tag/field/file in either repo | Rejected. Absence of a license tag means no rights are granted; not safe to redistribute in a commercial product regardless of how the model card reads. |

Apache-2.0 explicitly permits commercial use, modification, and
redistribution (with a patent grant), which is why the chosen model is
safe to convert, host, and ship inside a commercial extension. The only
obligation is preserving attribution and the license terms — done here via
this file plus the original model's LICENSE/README, both linked above.

Model card: https://huggingface.co/dima806/ai_vs_human_generated_image_detection

## Why it needed converting

The chosen model only ships PyTorch weights (`model.safetensors`) — no
ONNX export exists anywhere on the Hub for it. Converted locally:

```python
import torch
from transformers import ViTForImageClassification

model = ViTForImageClassification.from_pretrained(
    "dima806/ai_vs_human_generated_image_detection"
)
model.eval()

dummy = torch.randn(1, 3, 224, 224, dtype=torch.float32)
torch.onnx.export(
    model, dummy, "ai-image-detector.onnx",
    input_names=["pixel_values"], output_names=["logits"],
    dynamic_axes={"pixel_values": {0: "batch"}, "logits": {0: "batch"}},
    opset_version=17, do_constant_folding=True,
)
```

(Full script with ONNX-checker verification and a quantization pass:
`scripts/convert_to_onnx.py` in this repo — see that file for the exact
steps and the resulting file size/accuracy spot-check.)

## Contract this code assumes

`src/offscreen/model.js` expects:

- **Input**: tensor `[1, 3, 224, 224]`, NCHW, RGB, rescaled to `[0,1]` then
  normalized per-channel with mean=`[0.5,0.5,0.5]`, std=`[0.5,0.5,0.5]`
  (i.e. maps to `[-1,1]`) — taken directly from this model's
  `preprocessor_config.json` (`ViTImageProcessor`).
- **Output**: 2-class logits `[1, 2]`, `id2label = {0: "human", 1:
  "AI-generated"}` — softmax, take index 1.

If you swap in a different model, `bitmapToTensor()` and
`CHANNEL_MEAN`/`CHANNEL_STD` in `model.js` are the entire contract
boundary to update.

## Lazy loading — no weights bundled in the package

Per the "keep the default install small" requirement, the `.onnx` file is
**not** included in this repo/package. Instead:

- `src/offscreen/model.js`'s `MODEL_DOWNLOAD_URL` is a placeholder
  constant that needs to point at wherever the converted file ends up
  hosted.
- The first time pixel analysis runs an actual inference (not a cache
  hit), `loadModelBytes()` fetches that URL, then stores the raw bytes in
  **IndexedDB** (`src/offscreen/weights-store.js`) so every later
  inference — including after the offscreen document is torn down and
  recreated — reuses the cached copy instead of re-downloading.
- **Why the URL is a placeholder rather than filled in**: hosting the
  converted file requires publishing it somewhere (a GitHub repo, a
  Hugging Face account, a CDN) — that's an account/publishing decision
  only you can make, not something to guess at or fabricate a URL for.
  Once you've picked a host, drop the converted `.onnx` there and update
  `MODEL_DOWNLOAD_URL`.

## Realistic expectations (measured, not estimated)

The conversion in `scripts/convert_to_onnx.py` has actually been run:

- **Size**: FP32 ONNX export was **327.5 MB**. After dynamic INT8
  quantization (`onnxruntime.quantization.quantize_dynamic`): **82.9 MB**
  — a ~4x reduction. This is a ViT-base model (~86M params), so despite
  quantization it's meaningfully larger than a MobileNet-class detector
  would be; see the top-level README's "Bundle size & accuracy" section
  for how this compares to the alternative of picking a smaller backbone.
- **Quantization accuracy check**: cross-ran the same random input through
  the original PyTorch model and the quantized ONNX graph.
  PyTorch P(AI-generated) = 0.2233, quantized ONNX P(AI-generated) =
  0.2417 — max probability delta 0.018 across the batch, comfortably under
  the 0.05 tolerance the script asserts on. Quantization did not
  meaningfully change the model's behavior.
- **Accuracy**: local lightweight models trail cloud vision APIs (Hive,
  Sightengine, etc.) noticeably, especially against recent generators
  (Midjourney v6+, Flux, Sora) that cloud services retrain against
  continuously, and this specific model's own README already flags
  concept drift against generators newer than its ~1-year-old training
  set. Treat pixel-analysis hits as "worth a second look," not ground
  truth — this is why it defaults to off, sits behind its own toggle, and
  is additionally metered by the freemium daily allowance (see top-level
  README's "Freemium gating" section).
