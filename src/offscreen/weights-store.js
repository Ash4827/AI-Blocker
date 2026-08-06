// IndexedDB store for the model *weights* (the .onnx file bytes) — separate
// from cache.js, which stores small per-image inference results. Weights
// are tens of MB; chrome.storage (sync or local) is the wrong tool for that
// (sync has ~100KB total quota; local is a poor fit for a single large
// blob). IndexedDB has no such practical size ceiling for this use case.
//
// This is what makes the "don't bundle the model, fetch it lazily on first
// enable" requirement work: the extension package never contains the .onnx
// file: it's downloaded once into IndexedDB the first time pixel analysis
// actually runs, and reused from there on every later inference.
(function () {
  const DB_NAME = "ai-blocker-model-weights";
  const DB_VERSION = 1;
  const STORE_NAME = "weights";

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getStoredWeights(modelId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(modelId);
      req.onsuccess = () => resolve(req.result); // ArrayBuffer or undefined
      req.onerror = () => reject(req.error);
    });
  }

  async function storeWeights(modelId, arrayBuffer) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(arrayBuffer, modelId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Used when ort.InferenceSession.create() fails on cached bytes — there's
  // no way to validate an ArrayBuffer is a well-formed ONNX file before
  // handing it to the parser, so the recovery strategy is: if parsing ever
  // fails, assume the cached copy might be bad (an interrupted download
  // from a prior session, corrupted in a way that never gets re-checked
  // otherwise) and clear it, so the next attempt re-downloads from scratch
  // instead of repeating the same failure forever.
  async function deleteWeights(modelId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(modelId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  window.AIBlockerWeightsStore = { getStoredWeights, storeWeights, deleteWeights };
})();
