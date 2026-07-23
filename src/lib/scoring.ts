import type {
  CatalogCard,
  ParsedCardText,
  RecognitionCandidate,
  RecognitionDecision,
  VisualMatch,
} from "./types";

export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function levenshteinDistance(a: string, b: string): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

export function textSimilarity(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const left = normalizeForMatch(a);
  const right = normalizeForMatch(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const edit =
    1 - levenshteinDistance(left, right) / Math.max(left.length, right.length);
  const normalizeOcrGlyphs = (value: string) =>
    value.replaceAll("0", "o").replaceAll("5", "s").replaceAll("8", "b");
  const ocrLeft = normalizeOcrGlyphs(left);
  const ocrRight = normalizeOcrGlyphs(right);
  const ocrEdit =
    1 -
    levenshteinDistance(ocrLeft, ocrRight) /
      Math.max(ocrLeft.length, ocrRight.length);
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  const intersection = [...leftTokens].filter((token) =>
    rightTokens.has(token),
  ).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const tokenScore = union > 0 ? intersection / union : 0;
  return Math.max(
    0,
    Math.min(1, Math.max(edit, ocrEdit) * 0.82 + tokenScore * 0.18),
  );
}

export function cardNumberSimilarity(
  parsed: ParsedCardText,
  card: CatalogCard,
): number {
  if (!parsed.number) return 0;
  const expected = normalizeForMatch(parsed.number).replace(/\s/g, "");
  const actual = normalizeForMatch(
    card.printedNumber ?? card.number ?? "",
  ).replace(/\s/g, "");
  if (!actual) return 0;
  if (expected === actual) return 1;
  if (expected.replace(/^0+/, "") === actual.replace(/^0+/, "")) return 0.96;
  return textSimilarity(expected, actual) * 0.5;
}

export function scoreCandidates(
  parsed: ParsedCardText,
  cards: CatalogCard[],
  visualMatches: VisualMatch[] = [],
): RecognitionCandidate[] {
  const visuals = new Map(
    visualMatches.map((match) => [match.cardId, match.similarity]),
  );
  return cards
    .map((card, index): RecognitionCandidate => {
      const number = cardNumberSimilarity(parsed, card);
      const name = textSimilarity(parsed.name, card.name);
      const visual = visuals.get(card.id) ?? null;
      const catalogue = Math.max(0, 1 - index * 0.04);
      const hasNumber = Boolean(parsed.number);
      const hasName = Boolean(parsed.name);
      const hasVisual = visual !== null;
      let totalWeight = 0;
      let weighted = 0;
      const add = (score: number, weight: number, enabled: boolean) => {
        if (!enabled) return;
        weighted += score * weight;
        totalWeight += weight;
      };
      add(number, 0.5, hasNumber);
      add(name, 0.3, hasName);
      add(visual ?? 0, 0.42, hasVisual);
      add(catalogue, 0.08, true);
      const score = totalWeight > 0 ? weighted / totalWeight : 0;
      const matchReasons: string[] = [];
      if (number >= 0.9) matchReasons.push("number");
      if (name >= 0.82) matchReasons.push("name");
      if ((visual ?? 0) >= 0.8) matchReasons.push("visual");
      return {
        ...card,
        score,
        scoreParts: { number, name, visual, catalogue },
        matchReasons,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

export function decideRecognition(
  candidates: RecognitionCandidate[],
): RecognitionDecision {
  const best = candidates[0];
  if (!best) return { status: "no-match", candidates: [], score: 0, margin: 0 };
  const margin = best.score - (candidates[1]?.score ?? 0);
  const strongIndependentSignals = best.matchReasons.length >= 2;
  const status =
    best.score >= 0.76 && (margin >= 0.08 || strongIndependentSignals)
      ? "confident"
      : best.score >= 0.42
        ? "review"
        : "no-match";
  return { status, candidates, best, score: best.score, margin };
}
