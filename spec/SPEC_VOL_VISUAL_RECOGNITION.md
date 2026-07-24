# Volition — visual Pokémon card recognition

CardScope will identify a Pokémon card from its visual appearance, not from
OCR. The service is a free, non-commercial pilot: no checkout, advertising,
affiliate commission, paid ranking, or resale of personal data.

The CardScope source code remains MIT. That licence applies only to original
source code. It does not relicense card artwork, names, trademarks, training
data, reference images, or model artefacts.

## Direction chosen

- A guided single-card capture is encoded in the browser by an ONNX model in a
  Web Worker; the phone sends only a normalized embedding to the TypeScript
  service for top-five lookup.
- The service returns candidates and calibrated abstention. A user confirms
  printing, finish, and condition; a photo is never authentication or grading
  evidence.
- `TheFusion21/PokemonCards` is admitted only for a local non-commercial
  experiment, under the dataset card's CC-BY-NC-4.0 declaration and a
  provenance record. Its external image URLs and upstream artwork authority
  remain unverified.
- No reference image, generated model, or index derived from that experiment
  is published or served to users until its own model-redistribution and
  upstream-rights gates pass. The public application continues to offer
  catalogue search while this evidence is incomplete.
- All corpus intake happens through a bounded TypeScript script that records
  source URL, hash, size, and time. Images and artefacts stay ignored by Git.
- Python is permitted only as the existing offline training/export tool; no
  Python process, container, or endpoint is part of the application runtime.

## Definition of done

The visual recognizer may replace the legacy scan path only when the exact
ONNX, compact index, calibration report, provenance manifest, and phone
benchmark are versioned together; the corpus is lawful for its proposed use;
and it meets the accuracy, false-acceptance, latency, privacy, and package-size
gates in `SPEC_EVOL_VISUAL_RECOGNITION.md`.
