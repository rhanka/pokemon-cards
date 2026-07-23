# Image recognition model and dataset study

Verified on 22 July 2026. CardScope does not call a metered general-purpose Vision API. The shipped MVP runs Tesseract.js in the TypeScript service on Kubernetes. A small specialised ONNX retrieval model is the intended later accelerator once a legally usable corpus and weights pass release gates.

## What is already available

| Candidate                                                                                                        | Verified facts                                                                                                                                                                                                                                              | Decision                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`turing552/clip-pokemon_cards-10ep`](https://huggingface.co/turing552/clip-pokemon_cards-10ep)                  | CLIP ViT-B/32 checkpoint, 605,246,338-byte weight file, no declared licence, unknown training dataset, no retrieval results. Its model card reports validation loss 4.1391 with batch size 64; a random in-batch contrastive baseline is `ln(64) = 4.1589`. | Reject for the mobile product: too large, provenance is missing, and no Top-1/Recall@5 evidence establishes useful recognition.                                              |
| [`turing552/pokemoncards-vlm-multimodal`](https://huggingface.co/datasets/turing552/pokemoncards-vlm-multimodal) | 13,088 images (11,779 train + 1,309 validation), 10,621,974,971-byte download, image/caption/UID fields. The dataset card declares no licence or source provenance.                                                                                         | Useful evidence that data exists, but refused by the rights gate for training or publication.                                                                                |
| [`TheFusion21/PokemonCards`](https://huggingface.co/datasets/TheFusion21/PokemonCards)                           | Roughly 13k English card rows sourced from `images.pokemontcg.io`; Hugging Face metadata declares CC-BY-NC-4.0, while the dataset card leaves upstream curation/licensing sections incomplete.                                                              | Reject for a paid commercial service because the declared licence is non-commercial and does not resolve upstream artwork rights.                                            |
| [`1vcian/Pokemon-TCGP-Card-Scanner`](https://github.com/1vcian/Pokemon-TCGP-Card-Scanner)                        | Demonstrates a sound browser pattern: YOLO11n oriented-box detection trained on 10k synthetic scenes, TensorFlow.js cropping, then a 24-bit RGB-aware perceptual hash and IndexedDB. The GitHub repository declares no licence.                             | Reimplement the architecture, not its source code, dataset, or weights. The MVP's guided one-card capture avoids needing a detector initially.                               |
| [`tcgdex/cards-database`](https://github.com/tcgdex/cards-database)                                              | Repository metadata declares MIT and the API exposes stable multilingual printing records and image URLs.                                                                                                                                                   | Use as catalogue metadata after source-level review. MIT on the database/code is not treated as a licence to redistribute Pokémon artwork or train a commercial model on it. |
| [`PokemonTCG/pokemon-tcg-data`](https://github.com/PokemonTCG/pokemon-tcg-data)                                  | Large structured catalogue, but the repository declares no licence.                                                                                                                                                                                         | API adapter only under its service terms; do not copy the repository into a commercial training corpus.                                                                      |

“Downloadable” is not the same as “commercially trainable.” Every image source must pass `ml/schemas/rights-manifest.schema.json`; missing commercial, derivative, ML-training, and model-redistribution permissions fail closed.

## Selected technical path

The first useful version deliberately uses the smallest legally defensible path:

1. a guided crop in the browser, so the MVP needs no object detector;
2. mandatory JPEG re-encoding in the browser to bound pixels and remove EXIF;
3. one English/French Tesseract.js worker in Node for collector number and name fragments;
4. catalogue lookup over authorised TCGdex metadata, followed by abstention and human confirmation.

The final Alpine image completed the real 600×825 Pikachu scan in 10.26 s cold
and 5.23 s warm at a 300m CPU limit. Cgroup counters measured 3.22 CPU-s for
the cold request and 1.66 CPU-s warm; planning deliberately charges 3.3 CPU-s
for every scan. The final limited cgroup peaked at 134 MiB and returned to
about 86 MiB without an OOM event; an earlier unrestricted run peaked around
183 MiB RSS. Kubernetes requests 20m CPU but permits a 300m burst; recognition
is serialized and has no in-memory queue. This is inexpensive at normal
monthly usage, but not a promise to scan one million photos in a launch burst.

The future encoder is trained with metric learning and hard negatives: same character across different sets, normal versus reverse/holo, reprints, and adjacent collector numbers. Training samples are synthesized in memory with perspective, glare, sleeve reflection, blur, shadow, colour-temperature shift, JPEG damage, and occlusion. Card UIDs—not individual photos—are isolated across train, validation, and test splits.

The target INT8 model is at most 5 MiB. A 21,000-card reference index with 128 signed INT8 values per card is about 2.7 MB before compact IDs. It runs in the TypeScript recognizer, never as a Python backend. Recognition therefore has no metered per-scan provider bill. EfficientNet-Lite0 is considered only if MobileNetV3 misses the release gates.

## Corpus acquisition plan

A commercially defensible corpus can combine only sources that pass legal review:

- reference images from a catalogue or rights holder with explicit commercial ML-training and derived-model permission;
- independent phone captures collected through an opt-in programme whose consent, deletion, and model-use terms are explicit;
- synthetic capture transformations derived only from those cleared references;
- a separate, never-trained-on pilot set covering old/new sets, FR/EN, foil/sleeves, glare, damaged cards, look-alike reprints, and unknown/non-card images.

User consent to upload a photograph is not assumed to settle every artwork right. The manifest records the rights holder, legal basis, terms version, acquisition date, content hash, permitted operations, and removal path. No source image or trained weight is committed to this repository.

## Release evidence

The model remains optional until a named benchmark proves:

- exact-printing Top-1 at least 95% for pilot and 98% for the product target;
- Recall@5 at least 99%, and 99.5% on cards valued above USD 20 when the slice is large enough;
- open-set false-accept rate below 0.5%;
- expected calibration error at most 5% with an explicit abstention threshold;
- fewer than 5% identity corrections and an independently measured latency target on the release hardware;
- model at most 5 MiB and higher confirmed-card throughput than the OCR baseline.

Until then, the shipped path is honest: server OCR + catalogue search + a top-candidate screen. The user confirms printing, language, finish, and condition; CardScope never claims authentication or automated grading.
