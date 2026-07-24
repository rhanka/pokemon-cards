# Study — visual identification of Pokémon card printings

Date: 23 July 2026.

## Problem

OCR is not a reliable identity signal for a physical Pokémon card. Collector
numbers are small, foil and glare change their appearance, names repeat across
printings, and sleeves or partial occlusion are common. It must not be the
product's recognition mechanism.

The product needs exact-printing visual retrieval:

```text
guided photo
  -> quality and perspective correction
  -> compact visual encoder
  -> normalized embedding
  -> top-five nearest printings in a versioned index
  -> calibrated confidence or abstention
  -> human confirmation of printing, finish, and condition
```

An image is neither an authenticity proof nor a condition grade.

## Evidence reviewed

Two independent reviews and current Hugging Face metadata found no public
checkpoint that can be shipped as an exact-printing recognizer with a complete
rights record:

| Candidate | Limitation | Decision |
| --- | --- | --- |
| `turing552/clip-pokemon_cards-10ep` | 605 MB, no licence or data provenance, no retrieval benchmark; reported contrastive loss is close to a random in-batch baseline. | Reject. |
| `Matthieu68857/pokemon-cards-detection` | 167 MB DETR detector; it detects a card rather than identifying a printing; data and evaluation are undocumented. | Reject. |
| `hugginglearners/pokemon-card-checker` | 87 MB FastAI classifier for real/fake card backs, trained from Kaggle data. | Reject. |
| `TheFusion21/PokemonCards` | Dataset card declares CC-BY-NC-4.0; its roughly 13k CSV rows point to `images.pokemontcg.io`, rather than including cleared image files. | Admit only as a bounded local non-commercial experiment; upstream artwork authority is unverified, so no public model/index distribution. |
| `turing552/pokemoncards-vlm-multimodal` | 13,088 images, no licence or source provenance. | Reject. |
| Public data files marked MIT/CC0 | Metadata licence does not establish a right to train on or redistribute derived weights from Pokémon artwork. | Do not use without upstream evidence. |

The existing clean-room training pipeline is suitable as a build tool, but it
has no cleared corpus, exported ONNX model, reference index, or runtime asset.
Its current benchmark is not phone evidence.

## Candidate runtimes

### A. Browser visual retrieval — preferred

Svelte loads a versioned ONNX INT8 MobileNetV3-Small encoder lazily in a Web
Worker using `onnxruntime-web` WASM plus SIMD. The worker emits a normalized
128-dimensional embedding. The TypeScript API validates the vector and returns
the nearest five printings from a compact central Int8 index. The photo never
reaches the server. WebGPU is an optional later optimisation; it is not a
correctness dependency because Safari support remains uneven.

At 21,000 printings, a 128-dimensional signed-int8 index is about 2.7 MB
before metadata. The shipped model, index, calibrated threshold, WASM, and
compact mapping must remain under 12 MB compressed. The current Kubernetes
pod does no inference and stays compatible with one 20m CPU request / 256 MiB
memory request.

### B. Server visual inference

This would still be TypeScript, but receives the photo and competes with the
current small POC's CPU/memory budget. It is a fallback only after an explicit
server benchmark; it is not the primary plan.

### C. Perceptual hash

Useful as an optional capture-quality or reranking signal, but not as the
identifier: reprints, holographic reflections, angles, sleeves, and printing
variants make it too brittle.

## Release gates

- corpus rights explicitly permit the proposed use, ML training, and model
  redistribution for every source image; a CC-BY-NC experiment cannot be
  served or redistributed until its upstream artwork authority is verified;
- strict split by exact printing UID, with independent phone photos for probe,
  language, era, sleeve, glare, condition, and non-card slices;
- Top-1 >= 98%, Recall@5 >= 99%, Recall@5 >= 99.5% for the high-value slice
  when statistically supported;
- one-sided 95% upper confidence bound for open-set false acceptance < 0.5%;
- calibrated confidence uses both top-one similarity and top-one/top-two
  margin; auto-selection only at >= 99% predicted correctness;
- p95 warm encoding <= 750 ms, cold initialization <= 2 s, online path <=
  1.5 s, and Worker memory <= 100 MiB on two named phones including iPhone
  Safari and a mid-range Android;
- no model activation before the exact ONNX, index, calibration, corpus
  manifest, hashes, and phone report are versioned together.

## Owner decision and next step

The owner selected a free, non-commercial pilot and authorised a bounded local
experiment with `TheFusion21/PokemonCards`. The intake must record the
CC-BY-NC declaration, source URLs, hashes, and the unresolved upstream-image
provenance. It may support local retrieval research, but it does not clear a
publicly served model or index. Until those rights and the benchmark pass,
manual catalogue search is the honest fallback; OCR is not presented as
recognition.
