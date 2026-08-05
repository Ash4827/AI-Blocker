"""
Converts dima806/ai_vs_human_generated_image_detection (PyTorch/safetensors,
Apache-2.0) to ONNX, then applies dynamic INT8 quantization to shrink it.

Not run automatically as part of building the extension — this is a one-time
conversion whose *output* (ai-image-detector.onnx) gets hosted wherever you
choose (see models/README.md's "Lazy loading" section) and pointed to via
MODEL_DOWNLOAD_URL in src/offscreen/model.js. The extension itself never
runs Python; this script only exists to produce the file it fetches.

Requires: torch, transformers, onnx, onnxruntime (pip install these first).
"""

import os

import onnx
import torch
from transformers import ViTForImageClassification

MODEL_ID = "dima806/ai_vs_human_generated_image_detection"
FP32_PATH = "ai-image-detector.fp32.onnx"
QUANTIZED_PATH = "ai-image-detector.onnx"


def export_fp32():
    print(f"Loading {MODEL_ID} ...")
    model = ViTForImageClassification.from_pretrained(MODEL_ID)
    model.eval()
    print("id2label:", model.config.id2label)

    dummy = torch.randn(1, 3, 224, 224, dtype=torch.float32)

    print("Exporting to ONNX ...")
    torch.onnx.export(
        model,
        dummy,
        FP32_PATH,
        input_names=["pixel_values"],
        output_names=["logits"],
        dynamic_axes={"pixel_values": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17,
        do_constant_folding=True,
    )

    print("Verifying ONNX graph ...")
    onnx_model = onnx.load(FP32_PATH)
    onnx.checker.check_model(onnx_model)
    print(f"OK — {FP32_PATH} ({os.path.getsize(FP32_PATH) / 1024 / 1024:.1f} MB)")


def quantize():
    from onnxruntime.quantization import QuantType, quantize_dynamic

    print("Quantizing (dynamic INT8) ...")
    quantize_dynamic(FP32_PATH, QUANTIZED_PATH, weight_type=QuantType.QInt8)
    print(f"OK — {QUANTIZED_PATH} ({os.path.getsize(QUANTIZED_PATH) / 1024 / 1024:.1f} MB)")


def verify_against_pytorch():
    """Sanity check: same input should produce close results from PyTorch
    and the quantized ONNX graph. Quantization trades some precision for
    size, so we check probabilities are close, not bit-identical."""
    import numpy as np
    import onnxruntime as ort

    print("Cross-checking PyTorch vs. quantized ONNX on random input ...")
    model = ViTForImageClassification.from_pretrained(MODEL_ID)
    model.eval()

    x = torch.randn(1, 3, 224, 224, dtype=torch.float32)
    with torch.no_grad():
        torch_logits = model(pixel_values=x).logits.numpy()
    torch_probs = np.exp(torch_logits) / np.exp(torch_logits).sum(axis=-1, keepdims=True)

    session = ort.InferenceSession(QUANTIZED_PATH)
    onnx_logits = session.run(None, {"pixel_values": x.numpy()})[0]
    onnx_probs = np.exp(onnx_logits) / np.exp(onnx_logits).sum(axis=-1, keepdims=True)

    diff = np.abs(torch_probs - onnx_probs).max()
    print(f"PyTorch P(AI)={torch_probs[0][1]:.4f}  ONNX(quantized) P(AI)={onnx_probs[0][1]:.4f}  max_diff={diff:.4f}")
    assert diff < 0.05, "quantized output diverges too much from the PyTorch original"
    print("OK — quantized model tracks the PyTorch original closely enough to ship")


if __name__ == "__main__":
    export_fp32()
    quantize()
    verify_against_pytorch()
    os.remove(FP32_PATH)
    print(f"\nDone. Host {QUANTIZED_PATH} somewhere reachable and point "
          f"MODEL_DOWNLOAD_URL in src/offscreen/model.js at it.")
