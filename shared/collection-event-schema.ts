import { z } from "zod";

export const MAX_COLLECTION_IDENTIFIER_LENGTH = 160;
export const MAX_HOLDING_QUANTITY = 100_000;

const nonBlankText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim() === value, {
      message: "Text must not have surrounding whitespace",
    });

export const collectionIdentifierSchema = nonBlankText(
  MAX_COLLECTION_IDENTIFIER_LENGTH,
);

const isoDate = z
  .string()
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Timestamp must be parseable",
  });
const optionalText = (maximum: number) =>
  z.string().min(1).max(maximum).optional();
const currency = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .refine(
    (value) => {
      try {
        return Intl.supportedValuesOf("currency").includes(value);
      } catch {
        try {
          new Intl.NumberFormat("en", {
            style: "currency",
            currency: value,
          }).format(0);
          return true;
        } catch {
          return false;
        }
      }
    },
    { message: "Currency must be supported by Intl" },
  );
const cardFinish = z.enum([
  "normal",
  "reverse",
  "holo",
  "first-edition",
  "other",
]);
const cardCondition = z.enum([
  "mint",
  "near-mint",
  "excellent",
  "good",
  "played",
  "poor",
]);
const money = z
  .object({
    amount: z.number().finite().nonnegative(),
    currency,
  })
  .strict();
const priceQuote = z
  .object({
    id: optionalText(4_096),
    source: z.string().min(1).max(4_096),
    sourceUrl: optionalText(16_384),
    market: z.string().min(1).max(4_096),
    currency,
    sku: optionalText(4_096),
    condition: cardCondition.optional(),
    conditionIncluded: z.boolean().optional(),
    finish: cardFinish.optional(),
    low: z.number().finite().nonnegative().nullable(),
    marketPrice: z.number().finite().nonnegative().nullable(),
    high: z.number().finite().nonnegative().nullable(),
    volume: z.number().finite().nonnegative().nullable().optional(),
    liquidity: z.enum(["high", "medium", "low", "unknown"]).optional(),
    observedAt: isoDate,
    staleAfter: isoDate,
  })
  .strict();
const catalogCard = z
  .object({
    id: z.string().min(1).max(4_096),
    name: z.string().min(1).max(4_096),
    number: optionalText(4_096),
    printedNumber: optionalText(4_096),
    setId: optionalText(4_096),
    setName: optionalText(4_096),
    language: z.enum(["en", "fr", "ja", "other"]).optional(),
    rarity: optionalText(4_096),
    releaseDate: optionalText(4_096),
    images: z
      .object({
        small: optionalText(16_384),
        large: optionalText(16_384),
      })
      .strict()
      .optional(),
    quote: priceQuote.optional(),
    quotes: z.array(priceQuote).optional(),
    externalIds: z
      .record(z.string().min(1).max(4_096), z.string().min(1).max(4_096))
      .optional(),
    reference: z
      .object({
        perceptualHash: optionalText(4_096),
        rgbHash: z
          .array(z.number().finite().nonnegative())
          .max(4_096)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const holding = z
  .object({
    id: collectionIdentifierSchema,
    cardId: collectionIdentifierSchema,
    card: catalogCard,
    quantity: z.number().int().min(1).max(MAX_HOLDING_QUANTITY),
    finish: cardFinish,
    condition: cardCondition,
    unitCost: money.optional(),
    quote: priceQuote.optional(),
    note: optionalText(20_000),
    acquiredAt: isoDate.optional(),
    addedAt: isoDate,
    updatedAt: isoDate,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.card.id !== value.cardId) {
      context.addIssue({
        code: "custom",
        path: ["card", "id"],
        message: "Card identifier must match the holding",
      });
    }
  });

type EventBaseShape = {
  id: typeof collectionIdentifierSchema;
  deviceId: typeof collectionIdentifierSchema;
  holdingId: typeof collectionIdentifierSchema;
  occurredAt: typeof isoDate;
  syncedAt: z.ZodOptional<typeof isoDate>;
  serverSequence?: z.ZodOptional<z.ZodNumber>;
};

function eventSchema(includeServerSequence: boolean) {
  const base: EventBaseShape = {
    id: collectionIdentifierSchema,
    deviceId: collectionIdentifierSchema,
    holdingId: collectionIdentifierSchema,
    occurredAt: isoDate,
    syncedAt: isoDate.optional(),
  };
  if (includeServerSequence)
    base.serverSequence = z.number().int().positive().safe().optional();
  return z
    .discriminatedUnion("type", [
      z
        .object({
          ...base,
          type: z.literal("holding.added"),
          payload: z.object({ holding }).strict(),
        })
        .strict(),
      z
        .object({
          ...base,
          type: z.literal("holding.quantity-adjusted"),
          payload: z
            .object({
              delta: z
                .number()
                .int()
                .min(-MAX_HOLDING_QUANTITY)
                .max(MAX_HOLDING_QUANTITY)
                .refine((value) => value !== 0, {
                  message: "Quantity delta must not be zero",
                }),
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          ...base,
          type: z.literal("holding.updated"),
          payload: z
            .object({
              finish: cardFinish.optional(),
              condition: cardCondition.optional(),
              unitCost: money.nullable().optional(),
              note: z.string().min(1).max(20_000).nullable().optional(),
              quote: priceQuote.nullable().optional(),
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          ...base,
          type: z.literal("holding.removed"),
          payload: z
            .object({ reason: z.string().min(1).max(4_096).optional() })
            .strict(),
        })
        .strict(),
    ])
    .superRefine((operation, context) => {
      if (
        operation.type === "holding.added" &&
        operation.payload.holding.id !== operation.holdingId
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload", "holding", "id"],
          message: "Holding identifier must match the operation envelope",
        });
      }
    });
}

/** Exact wire contract accepted by POST /api/sync. */
export const syncOperationSchema = eventSchema(false);

/** Wire contract plus response-only ordering metadata persisted by the client. */
export const collectionEventSchema = eventSchema(true);
