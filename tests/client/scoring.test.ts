import { describe, expect, it } from "vitest";
import {
  decideRecognition,
  scoreCandidates,
  textSimilarity,
} from "../../src/lib/scoring";
import type { CatalogCard, ParsedCardText } from "../../src/lib/types";

const parsed: ParsedCardText = {
  rawText: "Pikachu\n025/165",
  name: "Pikachu",
  number: "025",
  setTotal: "165",
  query: "Pikachu 025/165",
  confidence: 0.92,
  signals: ["card-name", "collector-number"],
};

const cards: CatalogCard[] = [
  { id: "sv3pt5-025", name: "Pikachu", printedNumber: "025", setName: "151" },
  { id: "base-058", name: "Pikachu", printedNumber: "58", setName: "Base Set" },
  { id: "sv3pt5-026", name: "Raichu", printedNumber: "026", setName: "151" },
];

describe("recognition scoring", () => {
  it("should rank an exact number and name match first", () => {
    const results = scoreCandidates(parsed, cards);

    expect(results[0].id).toBe("sv3pt5-025");
    expect(results[0].scoreParts.number).toBe(1);
    expect(results[0].scoreParts.name).toBe(1);
    expect(decideRecognition(results).status).toBe("confident");
  });

  it("should use local visual similarity to disambiguate otherwise identical candidates", () => {
    const variants: CatalogCard[] = [
      { id: "normal", name: "Charizard ex", printedNumber: "199" },
      { id: "special", name: "Charizard ex", printedNumber: "199" },
    ];
    const text: ParsedCardText = {
      ...parsed,
      name: "Charizard ex",
      number: "199",
      query: "Charizard ex 199",
    };
    const results = scoreCandidates(text, variants, [
      { cardId: "normal", similarity: 0.38, provider: "reference-image" },
      { cardId: "special", similarity: 0.94, provider: "local-model" },
    ]);

    expect(results[0].id).toBe("special");
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].matchReasons).toContain("visual");
  });

  it("should abstain when every candidate is weak", () => {
    const weak = scoreCandidates(
      {
        ...parsed,
        name: "completely unreadable",
        number: "999",
        query: "unreadable",
      },
      cards,
    );

    expect(decideRecognition(weak).status).toBe("no-match");
  });

  it("should match accents and small OCR spelling differences", () => {
    expect(textSimilarity("Flabébé", "Flabebe")).toBe(1);
    expect(textSimilarity("Ninetales", "Ninetale5")).toBeGreaterThan(0.75);
  });
});
