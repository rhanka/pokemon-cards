import type { OcrLine, ParsedCardText } from "./types.js";

const FRACTION_NUMBER =
  /\b([A-Z]{0,4}\s?\d{1,3}[A-Z]?)\s*[/／]\s*([A-Z]{0,4}\s?\d{1,3})\b/i;
const PROMO_NUMBER = /\b((?:SWSH|SVP|SM|XY|BW)?\s?\d{1,3}[A-Z]?)\b/i;
const CARD_NOISE =
  /^(basic|stage\s*[12]|trainer|supporter|item|stadium|energy|hp\s*\d+|pok[eé]mon|basic\s+pok[eé]mon|pok[eé]mon\s+de\s+base|stage\s*[12]\s+pok[eé]mon|pok[eé]mon\s+de\s+niveau\s*[12]|illus\.?|weakness|resistance|retreat|rule|ability)$/i;
const STAT_LINE =
  /(?:\bHP\s*\d+|[×x]\s*2|[-+]\s*\d+|\b\d{2,3}\s*$|©|illus\.?|weakness|resistance|retreat)/i;
// Tesseract often renders the energy symbol after a card's HP as one short
// alphanumeric glyph (for example `Pikachu 40 HP D`). Treat that glyph as
// part of the header suffix, not as part of the Pokémon name.
const NAME_HP_SUFFIX =
  /\s+(?:HP\s*\d{1,3}|\d{1,3}\s*HP)(?:\s+[\p{L}\p{N}]{1,3})?\s*$/iu;
const EFFECT_LINE =
  /\b(?:does?|deals?)\s+\d+\s+damage\b|\b(?:flip|toss)\s+(?:a|one)\s+coin\b|\binflige\s+\d+\s+(?:points?\s+de\s+)?d[ée]g[âa]ts\b|\blance[rz]?\s+(?:une|la)\s+pi[eè]ce\b/i;

function cleanLine(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[|_[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedCardNumber(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

function normalizedFractionNumber(value: string, total: string): string {
  const number = normalizedCardNumber(value);
  const normalizedTotal = normalizedCardNumber(total);
  // Fractional subset identifiers use the same alphabetic family on both
  // sides (TG23/TG30, RC1/RC32, GG01/GG70). If the denominator is purely
  // numeric, a lone leading glyph is instead a common OCR artefact such as
  // `S58/102` on the Base Set Pikachu.
  if (
    /^\d{1,3}$/.test(normalizedTotal) &&
    /^[A-Z]\d{1,3}[A-Z]?$/.test(number)
  ) {
    return number.slice(1);
  }
  return number;
}

function likelyName(lines: OcrLine[]): OcrLine | undefined {
  return lines
    .map((line) => {
      const text = cleanLine(line.text);
      return {
        ...line,
        text: text.replace(NAME_HP_SUFFIX, "").trim(),
        hasHpHeader: NAME_HP_SUFFIX.test(text),
      };
    })
    .filter(({ text, confidence }) => {
      const clean = cleanLine(text);
      if (confidence < 20 || clean.length < 3 || clean.length > 34)
        return false;
      if (
        CARD_NOISE.test(clean) ||
        STAT_LINE.test(clean) ||
        EFFECT_LINE.test(clean)
      )
        return false;
      if (FRACTION_NUMBER.test(clean)) return false;
      const letters = clean.match(/[\p{L}]/gu)?.length ?? 0;
      return letters / clean.length >= 0.55;
    })
    .sort((a, b) => {
      const aClean = cleanLine(a.text);
      const bClean = cleanLine(b.text);
      const aTitleBonus = /^(?:[\p{Lu}][\p{L}'’-]*\s*){1,4}$/u.test(aClean)
        ? 16
        : 0;
      const bTitleBonus = /^(?:[\p{Lu}][\p{L}'’-]*\s*){1,4}$/u.test(bClean)
        ? 16
        : 0;
      const aHeaderBonus = a.hasHpHeader ? 24 : 0;
      const bHeaderBonus = b.hasHpHeader ? 24 : 0;
      return (
        b.confidence +
        bTitleBonus +
        bHeaderBonus -
        (a.confidence + aTitleBonus + aHeaderBonus)
      );
    })[0];
}

export function parseCardText(input: string | OcrLine[]): ParsedCardText {
  const lines: OcrLine[] = Array.isArray(input)
    ? input
        .map((line) => ({ ...line, text: cleanLine(line.text) }))
        .filter((line) => line.text)
    : input
        .split(/\r?\n/)
        .map((text) => ({ text: cleanLine(text), confidence: 70 }))
        .filter((line) => line.text);
  const rawText = lines.map(({ text }) => text).join("\n");
  const numberLine = lines.find(({ text }) => FRACTION_NUMBER.test(text));
  const fraction = numberLine?.text.match(FRACTION_NUMBER);
  const fallbackNumberLine = lines
    .slice()
    .reverse()
    .find(
      ({ text }) =>
        PROMO_NUMBER.test(text) && /\d/.test(text) && text.length <= 16,
    );
  const fallbackNumber = fallbackNumberLine?.text.match(PROMO_NUMBER)?.[1];
  const nameLine = likelyName(lines);
  const number =
    fraction?.[1] && fraction[2]
      ? normalizedFractionNumber(fraction[1], fraction[2])
      : fallbackNumber
        ? normalizedCardNumber(fallbackNumber)
        : undefined;
  const setTotal = fraction?.[2]
    ? normalizedCardNumber(fraction[2])
    : undefined;
  const name = nameLine ? cleanLine(nameLine.text) : undefined;
  const signals: string[] = [];
  if (number) signals.push(fraction ? "collector-number" : "promo-number");
  if (setTotal) signals.push("set-total");
  if (name) signals.push("card-name");
  const nameConfidence = nameLine ? Math.min(1, nameLine.confidence / 100) : 0;
  const numberConfidence = numberLine
    ? Math.min(1, numberLine.confidence / 100)
    : fallbackNumberLine
      ? 0.45
      : 0;
  const confidence = Math.min(1, numberConfidence * 0.6 + nameConfidence * 0.4);
  const query = [name, number && setTotal ? `${number}/${setTotal}` : number]
    .filter(Boolean)
    .join(" ")
    .trim();

  return { rawText, name, number, setTotal, query, confidence, signals };
}
