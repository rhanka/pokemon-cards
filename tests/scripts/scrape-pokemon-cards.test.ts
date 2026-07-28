import { describe, expect, it } from "vitest";

import { selectCollectedItems } from "../../scripts/scrape-pokemon-cards.js";

const cards = [
  {
    id: "base1-1",
    imageUrl: "https://images.pokemontcg.io/base1/1_hires.png",
    name: "Alakazam",
    setId: "base1",
  },
  {
    id: "base1-2",
    imageUrl: "https://images.pokemontcg.io/base1/2_hires.png",
    name: "Blastoise",
    setId: "base1",
  },
  {
    id: "base1-3",
    imageUrl: "https://images.pokemontcg.io/base1/3_hires.png",
    name: "Chansey",
    setId: "base1",
  },
];

function item(id: string) {
  return {
    item_id: `fusion:${id}`,
    card_uid: `tcg:${id}`,
    relative_path: `references/${id}.png`,
    sha256: "a".repeat(64),
    source_id: "thefusion21-pokemoncards",
    role: "reference" as const,
    capture_group: "catalogue-reference",
    language: "en",
    set_id: "base1",
    variant: "unknown",
  };
}

describe("PokemonCards scraper unavailable asset handling", () => {
  const completed = {
    "base1-1": item("base1-1"),
    "base1-2": item("base1-2"),
  };
  const failures = [
    {
      cardId: "base1-3",
      reason:
        "request failed (404) for https://images.pokemontcg.io/base1/3_hires.png",
    },
  ];

  it("keeps the default strict when an upstream reference is unavailable", () => {
    expect(() =>
      selectCollectedItems(cards, completed, failures, false),
    ).toThrow("1 downloads failed");
  });

  it("allows an explicitly incomplete corpus while retaining the unavailable source record", () => {
    const result = selectCollectedItems(cards, completed, failures, true);

    expect(result.items.map((entry) => entry.card_uid)).toEqual([
      "tcg:base1-1",
      "tcg:base1-2",
    ]);
    expect(result.unavailableAssets).toEqual([
      expect.objectContaining({
        card: expect.objectContaining({ id: "base1-3" }),
      }),
    ]);
  });

  it("refuses a missing reference that was not actually attempted", () => {
    expect(() => selectCollectedItems(cards, completed, [], true)).toThrow(
      "without a failure record",
    );
  });
});
