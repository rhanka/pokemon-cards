import { describe, expect, it } from "vitest";
import { parseCardText } from "../../src/lib/ocr";

describe("card text parser", () => {
  it("should extract the printed name and collector number from noisy OCR lines", () => {
    const result = parseCardText([
      { text: "BASIC", confidence: 96 },
      { text: "Pikachu", confidence: 94 },
      { text: "HP 60", confidence: 92 },
      { text: "Gnaw 10", confidence: 74 },
      { text: "025 / 165", confidence: 91 },
      { text: "illus. Atsuko Nishida", confidence: 80 },
    ]);

    expect(result.name).toBe("Pikachu");
    expect(result.number).toBe("025");
    expect(result.setTotal).toBe("165");
    expect(result.query).toBe("Pikachu 025/165");
    expect(result.signals).toEqual(
      expect.arrayContaining(["card-name", "collector-number", "set-total"]),
    );
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("should preserve alphanumeric gallery collector numbers", () => {
    const result = parseCardText([
      { text: "Umbreon VMAX", confidence: 92 },
      { text: "TG23 / TG30", confidence: 89 },
    ]);

    expect(result.name).toBe("Umbreon VMAX");
    expect(result.number).toBe("TG23");
    expect(result.setTotal).toBe("TG30");
  });

  it("should not use rules, stats, or copyright lines as a card name", () => {
    const result = parseCardText([
      { text: "STAGE 1", confidence: 99 },
      { text: "HP 120", confidence: 99 },
      { text: "Weakness ×2", confidence: 88 },
      { text: "©2024 Pokémon", confidence: 96 },
      { text: "101/198", confidence: 93 },
    ]);

    expect(result.name).toBeUndefined();
    expect(result.number).toBe("101");
  });
});
