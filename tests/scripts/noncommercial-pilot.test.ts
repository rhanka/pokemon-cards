import { describe, expect, it } from "vitest";

import {
  fusionAssetPath,
  fusionCardKey,
  parseFusionCardsCsv,
  selectFusionCardsCsv,
  validateFusionImageUrl,
} from "../../scripts/noncommercial-pilot-lib.js";

describe("TheFusion21 non-commercial pilot intake", () => {
  it("parses the declared CSV shape and keeps a safe asset path", () => {
    const cards = parseFusionCardsCsv(
      [
        "id,image_url,caption,name,hp,set_name",
        'base1-4,https://images.pokemontcg.io/base1/4_hires.png,"Charizard, 4/102",Charizard,120,Base',
      ].join("\n"),
    );

    expect(cards).toEqual([
      {
        id: "base1-4",
        imageUrl: "https://images.pokemontcg.io/base1/4_hires.png",
        name: "Charizard",
        setId: "base1",
      },
    ]);
    expect(fusionAssetPath(cards[0]!)).toBe("references/base1-4.png");
    expect(fusionCardKey({ ...cards[0]!, id: "ex10-!" })).toBe("ex10-_21_");
  });

  it("rejects image links outside the declared image host", () => {
    expect(() => validateFusionImageUrl("https://example.com/base1/4_hires.png")).toThrow(
      "outside the approved image host",
    );
    expect(() => validateFusionImageUrl("https://images.pokemontcg.io/base1/4.png")).toThrow(
      "outside the approved image host",
    );
  });

  it("keeps valid rows when another source row is malformed and supports stable offsets", () => {
    const selection = selectFusionCardsCsv(
      [
        "id,image_url,caption,name,hp,set_name",
        "bad,https://example.com/base1/4_hires.png,bad,Bad,1,Base",
        "base1-1,https://images.pokemontcg.io/base1/1_hires.png,one,One,1,Base",
        "base1-2,https://images.pokemontcg.io/base1/2_hires.png,two,Two,2,Base",
      ].join("\n"),
      { offset: 1, limit: 1 },
    );

    expect(selection.available).toBe(2);
    expect(selection.cards.map((card) => card.id)).toEqual(["base1-2"]);
    expect(selection.rejected).toEqual([
      expect.objectContaining({ rowNumber: 2, reason: expect.stringContaining("outside the approved") }),
    ]);
  });
});
