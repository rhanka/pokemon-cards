export interface FusionCardRow {
  id: string;
  imageUrl: string;
  name: string;
  setId: string;
}

export interface RejectedFusionCardRow {
  rowNumber: number;
  reason: string;
}

export interface FusionCardSelection {
  cards: FusionCardRow[];
  rejected: RejectedFusionCardRow[];
  available: number;
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

function parseFusionHeader(rows: string[][]): string[] {
  const header = rows.shift()?.map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, "") : value));
  if (!header || header.length !== FUSION_COLUMNS.length) {
    throw new Error("TheFusion21 CSV does not have the expected header");
  }
  for (const [index, expected] of FUSION_COLUMNS.entries()) {
    if (header[index] !== expected) {
      throw new Error(`TheFusion21 CSV header mismatch at column ${index + 1}`);
    }
  }
  return header;
}

function parseFusionCardRow(row: string[], rowNumber: number, header: string[]): FusionCardRow {
  if (row.length !== header.length) {
    throw new Error(`TheFusion21 CSV row ${rowNumber} has ${row.length} columns`);
  }
  const [id, imageUrl, , name, , setName] = row;
  if (!id || !imageUrl || !name || !setName) {
    throw new Error(`TheFusion21 CSV row ${rowNumber} has an empty required field`);
  }
  if (!/^[A-Za-z0-9!._-]{1,120}$/.test(id)) {
    throw new Error(`TheFusion21 CSV row ${rowNumber} has an unsafe card id: ${id}`);
  }
  const parsed = validateFusionImageUrl(imageUrl);
  return { id, imageUrl: parsed.toString(), name, setId: parsed.pathname.split("/")[1]! };
}

/**
 * Parse a bounded source selection while retaining a precise report of unusable
 * source rows. The offset and limit are applied to valid, unique cards rather
 * than raw CSV line numbers, so a malformed source row cannot block a batch.
 */
export function selectFusionCardsCsv(
  input: string,
  options: { offset?: number; limit?: number } = {},
): FusionCardSelection {
  const rows = parseRfc4180(input);
  const header = parseFusionHeader(rows);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  if (!(limit === Number.POSITIVE_INFINITY || (Number.isSafeInteger(limit) && limit > 0))) {
    throw new Error("limit must be a positive integer");
  }

  const seen = new Set<string>();
  const valid: FusionCardRow[] = [];
  const rejected: RejectedFusionCardRow[] = [];
  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    try {
      const card = parseFusionCardRow(row, rowNumber, header);
      if (!seen.add(card.id)) throw new Error(`TheFusion21 CSV repeats card id ${card.id}`);
      valid.push(card);
    } catch (error) {
      rejected.push({
        rowNumber,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    cards: valid.slice(offset, offset + limit),
    rejected,
    available: valid.length,
  };
}

/** Strict legacy parser retained for a caller that expects malformed input to stop the run. */
export function parseFusionCardsCsv(input: string, limit = Number.POSITIVE_INFINITY): FusionCardRow[] {
  const rows = parseRfc4180(input);
  const header = parseFusionHeader(rows);
  const seen = new Set<string>();
  return rows.slice(0, limit).map((row, index) => {
    const card = parseFusionCardRow(row, index + 2, header);
    if (!seen.add(card.id)) throw new Error(`TheFusion21 CSV repeats card id ${card.id}`);
    return card;
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
