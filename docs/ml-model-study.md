# Image recognition model and dataset study

Verified on 22 July 2026. CardScope does not call a metered general-purpose vision API. The intended production path is a small on-device retrieval model, with OCR and a perceptual hash as complementary signals.

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

The first useful version combines four cheap signals:

1. a guided crop in the browser, so the MVP needs no object detector;
2. local OCR for collector number and name fragments;
3. a tiny RGB perceptual fingerprint to rerank catalogue candidates;
4. once the rights and benchmark gates pass, a MobileNetV3-Small 224 px encoder producing a normalized 128-dimensional embedding.

The encoder is trained with metric learning and hard negatives: same character across different sets, normal versus reverse/holo, reprints, and adjacent collector numbers. Training samples are synthesized in memory with perspective, glare, sleeve reflection, blur, shadow, colour-temperature shift, JPEG damage, and occlusion. Card UIDs—not individual photos—are isolated across train, validation, and test splits.

The target INT8 model is at most 5 MiB. A 21,000-card reference index with 128 signed INT8 values per card is about 2.7 MB before compact IDs; it can be sharded by language/set and cached locally. Recognition therefore has no per-scan inference bill. EfficientNet-Lite0 is considered only if MobileNetV3 misses the release gates.

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
- fewer than 5% identity corrections and end-to-end p95 below 250 ms on named low/mid-range phones;
- model at most 5 MiB and at least 15 confirmed cards per minute in continuous use.

Until then, the shipped fallback is honest: OCR + catalogue search + perceptual reranking + a top-candidate screen. The user confirms printing, language, finish, and condition; CardScope never claims authentication or automated grading.
