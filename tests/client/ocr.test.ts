import { describe, expect, it } from "vitest";
import { parseCardText } from "../../shared/card-text";

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

  it("should recover a name joined to HP and ignore effect sentences", () => {
    const result = parseCardText([
      { text: "Basic Pokémon", confidence: 96 },
      { text: "Pikachu 40 HP D", confidence: 35 },
      { text: "JA AS A", confidence: 35 },
      { text: "Gnaw 10", confidence: 84 },
      { text: "Thunder Jolt Flip a coin. If tails,", confidence: 92 },
      { text: "Pikachu does 10 damage to itself.", confidence: 96 },
      { text: "S58/102", confidence: 65 },
    ]);

    expect(result).toMatchObject({
      name: "Pikachu",
      number: "58",
      setTotal: "102",
      query: "Pikachu 58/102",
    });
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

  it("should treat combined English and French card headers as noise", () => {
    const english = parseCardText([
      { text: "Basic Pokémon", confidence: 98 },
      { text: "58/102", confidence: 93 },
    ]);
    const french = parseCardText([
      { text: "Pokémon de base", confidence: 98 },
      { text: "58/102", confidence: 93 },
    ]);

    expect(english).toMatchObject({
      name: undefined,
      number: "58",
      setTotal: "102",
      query: "58/102",
    });
    expect(french.name).toBeUndefined();
  });
});
