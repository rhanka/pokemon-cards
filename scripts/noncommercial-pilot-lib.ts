export interface FusionCardRow {
  id: string;
  imageUrl: string;
  name: string;
  setId: string;
}

const FUSION_COLUMNS = ["id", "image_url", "caption", "name", "hp", "set_name"] as const;
const FUSION_IMAGE_HOST = "images.pokemontcg.io";
const FUSION_IMAGE_PATH = /^\/[A-Za-z0-9-]+\/[A-Za-z0-9!._-]+_hires\.png$/;

export function parseRfc4180(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"') {
      if (cell) throw new Error("CSV has an unexpected quote in an unquoted field");
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") {
      cell += character;
    }
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field");
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function parseFusionCardsCsv(input: string, limit = Number.POSITIVE_INFINITY): FusionCardRow[] {
  const rows = parseRfc4180(input);
  const header = rows.shift()?.map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, "") : value));
  if (!header || header.length !== FUSION_COLUMNS.length) {
    throw new Error("TheFusion21 CSV does not have the expected header");
  }
  for (const [index, expected] of FUSION_COLUMNS.entries()) {
    if (header[index] !== expected) {
      throw new Error(`TheFusion21 CSV header mismatch at column ${index + 1}`);
    }
  }

  const seen = new Set<string>();
  return rows.slice(0, limit).map((row, index) => {
    if (row.length !== header.length) {
      throw new Error(`TheFusion21 CSV row ${index + 2} has ${row.length} columns`);
    }
    const [id, imageUrl, , name, , setName] = row;
    if (!id || !imageUrl || !name || !setName) {
      throw new Error(`TheFusion21 CSV row ${index + 2} has an empty required field`);
    }
    if (!/^[A-Za-z0-9!._-]{1,120}$/.test(id)) {
      throw new Error(`TheFusion21 CSV row ${index + 2} has an unsafe card id: ${id}`);
    }
    if (!seen.add(id)) throw new Error(`TheFusion21 CSV repeats card id ${id}`);
    const parsed = validateFusionImageUrl(imageUrl);
    return { id, imageUrl: parsed.toString(), name, setId: parsed.pathname.split("/")[1]! };
  });
}

export function validateFusionImageUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("TheFusion21 image URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== FUSION_IMAGE_HOST ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !FUSION_IMAGE_PATH.test(parsed.pathname)
  ) {
    throw new Error("TheFusion21 image URL is outside the approved image host and path");
  }
  return parsed;
}

export function fusionAssetPath(card: FusionCardRow): string {
  return `references/${fusionCardKey(card)}.png`;
}

export function fusionCardKey(card: FusionCardRow): string {
  return card.id.replace(/[^A-Za-z0-9-]/g, (character) => {
    const codePoint = character.codePointAt(0);
    if (!codePoint) throw new Error("TheFusion21 card id has an invalid Unicode code point");
    return `_${codePoint.toString(16)}_`;
  });
}
