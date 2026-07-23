import { validateCollectionEvents } from "./db";
import { MAX_HOLDING_QUANTITY, type AddHoldingInput } from "./collection";
import { normalizeCurrency } from "./money";
import type {
  CardCondition,
  CardFinish,
  CollectionEvent,
  Holding,
  PriceQuote,
} from "./types";

type ExportEnvelope = {
  format: "cardscope-collection";
  version: 1;
  exportedAt: string;
  events: CollectionEvent[];
};

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function eventsToJson(events: CollectionEvent[]): string {
  const envelope: ExportEnvelope = {
    format: "cardscope-collection",
    version: 1,
    exportedAt: new Date().toISOString(),
    // Synchronisation acknowledgements and server ordering are epoch-bound
    // account state, not portable user data.
    events: events.map(withoutSyncAcknowledgement),
  };
  return JSON.stringify(envelope, null, 2);
}

export function eventsFromJson(text: string): CollectionEvent[] {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object")
    throw new Error("Invalid CardScope export");
  const envelope = parsed as Partial<ExportEnvelope>;
  if (
    envelope.format !== "cardscope-collection" ||
    envelope.version !== 1 ||
    !Array.isArray(envelope.events)
  ) {
    throw new Error("Unsupported CardScope export");
  }
  if (
    typeof envelope.exportedAt !== "string" ||
    Number.isNaN(Date.parse(envelope.exportedAt))
  ) {
    throw new Error("Invalid CardScope export timestamp");
  }
  return validateCollectionEvents(envelope.events).map(
    withoutSyncAcknowledgement,
  );
}

function withoutSyncAcknowledgement(event: CollectionEvent): CollectionEvent {
  const copy = structuredClone(event);
  delete copy.syncedAt;
  delete copy.serverSequence;
  return copy;
}

export function holdingsToCsv(holdings: Holding[]): string {
  const headers = [
    "card_id",
    "name",
    "set",
    "number",
    "quantity",
    "finish",
    "condition",
    "cost",
    "cost_currency",
    "market_price",
    "price_currency",
    "price_source",
    "observed_at",
    "acquired_at",
    "note",
  ];
  const rows = holdings.map((holding) => [
    holding.cardId,
    holding.card.name,
    holding.card.setName,
    holding.card.printedNumber ?? holding.card.number,
    holding.quantity,
    holding.finish,
    holding.condition,
    holding.unitCost?.amount,
    holding.unitCost?.currency,
    holding.quote?.marketPrice,
    holding.quote?.currency,
    holding.quote?.source,
    holding.quote?.observedAt,
    holding.acquiredAt,
    holding.note,
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  row.push(cell);
  if (row.some((value) => value.length > 0)) rows.push(row);
  if (quoted) throw new Error("CSV contains an unterminated quoted value");
  return rows;
}

export function holdingsFromCsv(text: string): AddHoldingInput[] {
  const [headerRow, ...rows] = parseCsvRows(text.replace(/^\uFEFF/, ""));
  if (!headerRow) throw new Error("CSV is empty");
  const headers = headerRow.map((header) => header.trim().toLowerCase());
  const required = ["card_id", "name", "quantity", "finish", "condition"];
  if (required.some((header) => !headers.includes(header)))
    throw new Error("CSV is missing CardScope columns");
  const value = (row: string[], name: string) =>
    row[headers.indexOf(name)]?.trim() ?? "";
  const finishes = new Set<CardFinish>([
    "normal",
    "reverse",
    "holo",
    "first-edition",
    "other",
  ]);
  const conditions = new Set<CardCondition>([
    "mint",
    "near-mint",
    "excellent",
    "good",
    "played",
    "poor",
  ]);
  const invalidRow = (index: number, detail: string): never => {
    throw new Error(`Invalid CardScope CSV row ${index + 2}: ${detail}`);
  };
  const optionalAmount = (
    raw: string,
    index: number,
    field: string,
  ): number | undefined => {
    if (!raw) return undefined;
    if (!/^(?:\d+\.?\d*|\.\d+)$/.test(raw))
      invalidRow(index, `${field} must be non-negative`);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0)
      invalidRow(index, `${field} must be non-negative`);
    return parsed;
  };
  const optionalCurrency = (
    raw: string,
    index: number,
    field: string,
  ): string | undefined => {
    if (!raw) return undefined;
    const parsed = normalizeCurrency(raw);
    return parsed === null
      ? invalidRow(index, `${field} currency is unsupported`)
      : parsed;
  };

  return rows.map((row, index) => {
    const cardId = value(row, "card_id");
    const name = value(row, "name");
    const finishValue = value(row, "finish") as CardFinish;
    const conditionValue = value(row, "condition") as CardCondition;
    const rawQuantity = value(row, "quantity");
    const quantity = Number(rawQuantity);
    if (
      !cardId ||
      !name ||
      !finishes.has(finishValue) ||
      !conditions.has(conditionValue) ||
      !/^\d+$/.test(rawQuantity) ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_HOLDING_QUANTITY
    ) {
      throw new Error(`Invalid CardScope CSV row ${index + 2}`);
    }
    const cost = optionalAmount(value(row, "cost"), index, "cost");
    const marketPrice = optionalAmount(
      value(row, "market_price"),
      index,
      "market price",
    );
    const observedAt = value(row, "observed_at");
    if (observedAt && Number.isNaN(Date.parse(observedAt)))
      invalidRow(index, "observed_at is invalid");
    const acquiredAt = value(row, "acquired_at");
    if (acquiredAt && Number.isNaN(Date.parse(acquiredAt)))
      invalidRow(index, "acquired_at is invalid");
    const suppliedPriceCurrency = optionalCurrency(
      value(row, "price_currency"),
      index,
      "price",
    );
    const suppliedCostCurrency = optionalCurrency(
      value(row, "cost_currency"),
      index,
      "cost",
    );
    const priceCurrency = suppliedPriceCurrency ?? "USD";
    const quote: PriceQuote | undefined =
      marketPrice !== undefined
        ? {
            source: value(row, "price_source") || "CSV import",
            market: "import",
            currency: priceCurrency,
            finish: finishValue,
            condition: conditionValue,
            conditionIncluded: true,
            low: marketPrice,
            marketPrice,
            high: marketPrice,
            observedAt:
              observedAt && !Number.isNaN(Date.parse(observedAt))
                ? observedAt
                : new Date(0).toISOString(),
            staleAfter:
              observedAt && !Number.isNaN(Date.parse(observedAt))
                ? observedAt
                : new Date(0).toISOString(),
          }
        : undefined;
    return {
      card: {
        id: cardId,
        name,
        setName: value(row, "set") || undefined,
        printedNumber: value(row, "number") || undefined,
        quote,
        quotes: quote ? [quote] : [],
      },
      quantity,
      finish: finishValue,
      condition: conditionValue,
      unitCost:
        cost !== undefined
          ? {
              amount: cost,
              currency: suppliedCostCurrency ?? priceCurrency,
            }
          : undefined,
      quote,
      acquiredAt: acquiredAt || undefined,
      note: value(row, "note") || undefined,
    };
  });
}

export function downloadText(
  filename: string,
  contents: string,
  type: string,
): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
