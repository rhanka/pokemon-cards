import { existsSync } from "node:fs";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { syncOperationSchema } from "../shared/collection-event-schema.js";
import {
  CARD_LANGUAGES,
  type CardLanguage,
  type CatalogueMetadata,
  type CatalogueSearchResult,
  type CatalogueSource,
  type PokemonCard,
  type SyncRequest,
} from "../shared/types.js";
import {
  AuthenticationError,
  AuthenticationUnavailableError,
  createAuthenticator,
  type Authenticator,
  type AuthPrincipal,
} from "./auth.js";
import { PokemonTcgAdapter, TcgdexAdapter } from "./catalog/adapters.js";
import {
  type CatalogueGuardLease,
  CatalogueRequestGuard,
} from "./catalog/guard.js";
import {
  CatalogueCardNotFoundError,
  CatalogueService,
  CatalogueUnavailableError,
} from "./catalog/service.js";
import { loadConfig, toPublicConfig, type RuntimeConfig } from "./config.js";
import {
  SqliteStore,
  SyncEnrollmentConflictError,
  SyncGenerationMismatchError,
  SyncOperationConflictError,
  SyncOperationInvalidError,
  SyncOperationTooLargeError,
  SyncStorageLimitError,
} from "./store.js";
import {
  RecognitionBusyError,
  type RecognitionEngine,
  RecognitionImageError,
  RecognitionTimeoutError,
  TesseractRecognitionEngine,
} from "./recognition.js";

type CatalogueLanguageMode = CardLanguage | "auto";

interface AppEnvironment {
  Variables: {
    principal: AuthPrincipal;
    recognitionLanguage: CatalogueLanguageMode;
    recognitionSignal: AbortSignal;
    recognitionUploadLease: Extract<CatalogueGuardLease, { allowed: true }>;
  };
}

export interface AppDependencies {
  config: RuntimeConfig;
  store: SqliteStore;
  catalogue: CatalogueService;
  authenticator: Authenticator;
  recognizer: RecognitionEngine;
}

export interface AppRuntime extends AppDependencies {
  app: Hono<AppEnvironment>;
  close: () => Promise<void>;
}

const syncGeneration = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value)), {
    message: "Sync generation must be a safe positive integer string",
  });
const catalogueLanguageMode = z.union([
  z.enum(CARD_LANGUAGES),
  z.literal("auto"),
]);
const RECOGNITION_E2E_TIMEOUT_MS = 35_000;
const AUTO_LANGUAGE_CARD_LIMIT = 24;
const AUTO_LANGUAGE_PER_LANGUAGE_LIMIT = 12;
const SYNC_PER_SUBJECT_PER_MINUTE = 60;
const SYNC_GLOBAL_PER_MINUTE = 600;
const SYNC_MAX_CONCURRENT_REQUESTS = 8;
const syncBodyLimit = bodyLimit({
  maxSize: 2 * 1024 * 1024,
  onError: (context) =>
    context.json(
      {
        error: {
          code: "payload_too_large",
          message: "Sync request body must not exceed 2 MiB",
        },
      },
      413,
    ),
});

function signalReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("Recognition was cancelled", "AbortError")
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signalReason(signal);
}

function interleaveCards(
  lists: readonly PokemonCard[][],
  limit: number,
): PokemonCard[] {
  const cards: PokemonCard[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest && cards.length < limit; index += 1) {
    for (const list of lists) {
      const card = list[index];
      if (!card || seen.has(card.id)) continue;
      seen.add(card.id);
      cards.push(card);
      if (cards.length >= limit) break;
    }
  }
  return cards;
}

function mergedCatalogueMetadata(
  results: readonly CatalogueSearchResult[],
): CatalogueMetadata {
  const first = results[0]?.metadata;
  if (!first) throw new CatalogueUnavailableError();
  const cache: CatalogueMetadata["cache"] = results.some(
    ({ metadata }) => metadata.cache === "stale",
  )
    ? "stale"
    : results.some(({ metadata }) => metadata.cache === "miss")
      ? "miss"
      : "hit";
  const warnings = [
    ...new Set(
      results
        .map(({ metadata }) => metadata.warning)
        .filter((warning): warning is string => Boolean(warning)),
    ),
  ];
  return {
    ...first,
    cache,
    stale: results.some(({ metadata }) => metadata.stale),
    fetchedAt: results.map(({ metadata }) => metadata.fetchedAt).sort()[0],
    staleAfter: results.map(({ metadata }) => metadata.staleAfter).sort()[0],
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
  };
}

async function searchCatalogueLanguages(input: {
  catalogue: CatalogueService;
  query: string;
  language: CatalogueLanguageMode;
  perLanguageLimit: number;
  maxCards: number;
  signal?: AbortSignal;
}): Promise<CatalogueSearchResult> {
  throwIfAborted(input.signal);
  if (input.language !== "auto") {
    const result = await input.catalogue.search(
      input.query,
      input.language,
      input.perLanguageLimit,
      input.signal,
    );
    return { ...result, cards: result.cards.slice(0, input.maxCards) };
  }

  const settled = await Promise.allSettled(
    CARD_LANGUAGES.map((language) =>
      input.catalogue.search(
        input.query,
        language,
        input.perLanguageLimit,
        input.signal,
      ),
    ),
  );
  const results: CatalogueSearchResult[] = [];
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    const language = CARD_LANGUAGES[index];
    if (!result || !language) throw new CatalogueUnavailableError();
    if (result.status === "rejected") throw result.reason;
    if (
      result.value.cards.some((card) => card.language !== language) ||
      (language === "fr" && result.value.metadata.source === "pokemon_tcg")
    ) {
      throw new CatalogueUnavailableError(
        `${language.toUpperCase()} catalogue results are unavailable`,
      );
    }
    results.push(result.value);
  }
  throwIfAborted(input.signal);
  return {
    query: input.query,
    cards: interleaveCards(
      results.map(({ cards }) => cards.slice(0, input.perLanguageLimit)),
      Math.min(input.maxCards, AUTO_LANGUAGE_CARD_LIMIT),
    ),
    metadata: mergedCatalogueMetadata(results),
  };
}

function invalidRequest(issues: z.core.$ZodIssue[]) {
  return {
    error: {
      code: "invalid_request",
      message: "The request did not match the API contract",
      details: issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    },
  };
}

function createAuthenticationMiddleware(
  authenticator: Authenticator,
): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    try {
      context.set(
        "principal",
        await authenticator.authenticate(context.req.raw),
      );
      await next();
    } catch (error) {
      if (error instanceof AuthenticationUnavailableError) {
        return context.json(
          {
            error: {
              code: "sync_disabled",
              message: error.message,
            },
          },
          503,
        );
      }
      if (error instanceof AuthenticationError) {
        context.header("WWW-Authenticate", "Bearer");
        return context.json(
          {
            error: {
              code: "unauthorized",
              message: error.message,
            },
          },
          401,
        );
      }
      throw error;
    }
  };
}

function requestClientId(request: Request): string {
  // Traefik appends the immediate PROXY-protocol client to X-Forwarded-For.
  // Prefer that final hop so a caller-supplied X-Real-IP cannot choose its
  // rate-limit bucket.
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .at(-1)
    ?.trim();
  if (forwarded) return forwarded;
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function syncStoreOptions(config: RuntimeConfig) {
  return {
    retentionDays: config.sync.retentionDays,
    maxAccounts: config.sync.maxAccounts,
    maxOperationBytes: config.sync.maxOperationBytes,
    maxAccountEvents: config.sync.maxAccountEvents,
    maxAccountBytes: config.sync.maxAccountBytes,
    maxPullBytes: config.sync.maxPullBytes,
  };
}

function syncErrorResponse(context: Context<AppEnvironment>, error: unknown) {
  if (error instanceof SyncEnrollmentConflictError) {
    return context.json(
      {
        error: {
          code: "sync_enrollment_conflict",
          message: error.message,
          currentEventCount: error.currentEventCount,
        },
      },
      409,
    );
  }
  if (error instanceof SyncGenerationMismatchError) {
    return context.json(
      {
        error: {
          code: "sync_generation_mismatch",
          message: error.message,
          currentGeneration: error.currentGeneration,
        },
      },
      409,
    );
  }
  if (error instanceof SyncOperationConflictError) {
    return context.json(
      {
        error: {
          code: "sync_operation_conflict",
          message: error.message,
          operationId: error.operationId,
        },
      },
      409,
    );
  }
  if (error instanceof SyncOperationInvalidError) {
    return context.json(
      {
        error: {
          code: "sync_operation_invalid",
          message: error.message,
          operationId: error.operationId,
        },
      },
      422,
    );
  }
  if (error instanceof SyncOperationTooLargeError) {
    return context.json(
      {
        error: {
          code: "operation_too_large",
          message: `Each sync operation must not exceed ${error.maximumBytes} bytes`,
          operationId: error.operationId,
        },
      },
      413,
    );
  }
  if (error instanceof SyncStorageLimitError) {
    return context.json(
      {
        error: {
          code: "sync_storage_limit",
          message: error.message,
          limit: error.limit,
        },
      },
      507,
    );
  }
  throw error;
}

function contentSecurityPolicy(config: RuntimeConfig): string {
  const connectSources = new Set(["'self'"]);
  const imageSources = new Set(["'self'", "data:", "blob:"]);
  if (config.oidc.enabled && config.oidc.issuer) {
    connectSources.add(new URL(config.oidc.issuer).origin);
  }
  if (config.catalogue.cardImagesEnabled) {
    if (config.catalogue.tcgdexCatalogEnabled) {
      connectSources.add("https://assets.tcgdex.net");
      imageSources.add("https://assets.tcgdex.net");
    }
    if (config.catalogue.pokemonTcgCatalogEnabled) {
      connectSources.add("https://images.pokemontcg.io");
      imageSources.add("https://images.pokemontcg.io");
    }
  }
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    // Sentropic's ThemeProvider injects a small runtime stylesheet containing
    // design tokens. Keep the exception scoped to style elements: scripts stay
    // nonce-free and inline event handlers remain forbidden.
    "style-src-elem 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    "worker-src 'self' blob:",
    `connect-src ${[...connectSources].join(" ")}`,
    `img-src ${[...imageSources].join(" ")}`,
    "font-src 'self'",
    "manifest-src 'self'",
  ].join("; ");
}

export function createApp(dependencies: AppDependencies): Hono<AppEnvironment> {
  const { config, store, catalogue, authenticator, recognizer } = dependencies;
  const app = new Hono<AppEnvironment>();
  const catalogueGuard = new CatalogueRequestGuard({
    perClientPerMinute: config.catalogue.rateLimitPerMinute,
    globalPerMinute: config.catalogue.globalRateLimitPerMinute,
    maxConcurrent: config.catalogue.maxConcurrentRequests,
  });
  const recognitionUploadGuard = new CatalogueRequestGuard({
    perClientPerMinute: config.recognition.rateLimitPerMinute,
    globalPerMinute: config.recognition.globalRateLimitPerMinute,
    maxConcurrent: config.recognition.maxConcurrentUploads,
  });
  const syncGuard = new CatalogueRequestGuard({
    perClientPerMinute: SYNC_PER_SUBJECT_PER_MINUTE,
    globalPerMinute: SYNC_GLOBAL_PER_MINUTE,
    maxConcurrent: SYNC_MAX_CONCURRENT_REQUESTS,
  });
  const recognitionBodyLimit = bodyLimit({
    maxSize: config.recognition.maxImageBytes,
    onError: (context) =>
      context.json(
        {
          error: {
            code: "recognition_payload_too_large",
            message: `Recognition images must not exceed ${config.recognition.maxImageBytes} bytes`,
          },
        },
        413,
      ),
  });

  app.use("*", async (context, next) => {
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Frame-Options", "DENY");
    context.header("X-XSS-Protection", "0");
    context.header("Cross-Origin-Opener-Policy", "same-origin");
    context.header("Cross-Origin-Resource-Policy", "same-origin");
    context.header("Content-Security-Policy", contentSecurityPolicy(config));
    if (new URL(config.publicOrigin).protocol === "https:") {
      context.header(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
    context.header(
      "Permissions-Policy",
      "camera=(self), microphone=(), geolocation=()",
    );
    await next();
  });

  app.get("/api/health", (context) => {
    try {
      const databaseOk = store.ping();
      const recognitionOk = recognizer.healthy?.() ?? true;
      const healthy = databaseOk && recognitionOk;
      return context.json(
        {
          status: healthy ? "ok" : "degraded",
          service: "cardscope-api",
          time: new Date().toISOString(),
          database: {
            ok: databaseOk,
            journalMode: store.journalMode(),
          },
          recognition: { ok: recognitionOk },
        },
        healthy ? 200 : 503,
      );
    } catch {
      return context.json(
        {
          status: "degraded",
          service: "cardscope-api",
          time: new Date().toISOString(),
          database: { ok: false, journalMode: "unknown" },
        },
        503,
      );
    }
  });

  app.get("/api/config", (context) => context.json(toPublicConfig(config)));

  app.use("/api/catalog/*", async (context, next) => {
    const lease = catalogueGuard.enter(requestClientId(context.req.raw));
    if (!lease.allowed) {
      context.header("Retry-After", String(lease.retryAfterSeconds));
      return context.json(
        {
          error: {
            code: "catalogue_rate_limited",
            message: "Too many catalogue requests; retry later",
          },
        },
        429,
      );
    }
    try {
      await next();
    } finally {
      lease.release();
    }
  });

  app.post(
    "/api/recognition/cards",
    async (context, next) => {
      const deadline = new AbortController();
      const timer = setTimeout(() => {
        deadline.abort(new RecognitionTimeoutError());
      }, RECOGNITION_E2E_TIMEOUT_MS);
      (timer as NodeJS.Timeout).unref?.();
      context.set(
        "recognitionSignal",
        AbortSignal.any([context.req.raw.signal, deadline.signal]),
      );
      try {
        await next();
      } finally {
        clearTimeout(timer);
      }
    },
    async (context, next) => {
      context.header("Cache-Control", "no-store");
      if (
        !config.recognition.enabled ||
        (!config.catalogue.tcgdexCatalogEnabled &&
          !config.catalogue.pokemonTcgCatalogEnabled)
      ) {
        return context.json(
          {
            error: {
              code: "recognition_disabled",
              message:
                "Recognition is disabled until an authorised catalogue is enabled",
            },
          },
          503,
        );
      }

      const parsed = z
        .object({
          language: catalogueLanguageMode.default("auto"),
        })
        .safeParse({
          language: context.req.query("language") ?? context.req.query("lang"),
        });
      if (!parsed.success)
        return context.json(invalidRequest(parsed.error.issues), 400);

      const mediaType = context.req
        .header("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (mediaType !== "image/jpeg") {
        return context.json(
          {
            error: {
              code: "recognition_media_type",
              message: "Recognition accepts image/jpeg only",
            },
          },
          415,
        );
      }

      const uploadLease = recognitionUploadGuard.enter(
        requestClientId(context.req.raw),
      );
      if (!uploadLease.allowed) {
        const busy = uploadLease.reason === "concurrency";
        context.header(
          "Retry-After",
          busy ? "5" : String(uploadLease.retryAfterSeconds),
        );
        return context.json(
          {
            error: {
              code: busy
                ? "recognition_upload_busy"
                : "recognition_rate_limited",
              message: busy
                ? "Too many recognition uploads are in progress"
                : "Too many recognition requests; retry later",
            },
          },
          429,
        );
      }

      context.set("recognitionLanguage", parsed.data.language);
      context.set("recognitionUploadLease", uploadLease);
      try {
        await next();
      } finally {
        uploadLease.release();
      }
    },
    recognitionBodyLimit,
    async (context) => {
      let image: Uint8Array;
      try {
        image = new Uint8Array(await context.req.arrayBuffer());
      } catch {
        return context.json(
          {
            error: {
              code: "recognition_invalid_image",
              message: "The recognition image could not be read",
            },
          },
          422,
        );
      }
      if (!image.byteLength) {
        return context.json(
          {
            error: {
              code: "recognition_invalid_image",
              message: "The recognition image is empty",
            },
          },
          422,
        );
      }

      context.get("recognitionUploadLease").release();

      try {
        const signal = context.get("recognitionSignal");
        const recognition = await recognizer.recognize(image, { signal });
        const cards = recognition.evidence.query
          ? (
              await searchCatalogueLanguages({
                catalogue,
                query: recognition.evidence.query,
                language: context.get("recognitionLanguage"),
                perLanguageLimit: AUTO_LANGUAGE_PER_LANGUAGE_LIMIT,
                maxCards: AUTO_LANGUAGE_CARD_LIMIT,
                signal,
              })
            ).cards
          : [];
        throwIfAborted(signal);
        return context.json({ ...recognition, cards });
      } catch (error) {
        if (error instanceof RecognitionBusyError) {
          context.get("recognitionUploadLease").refundClientQuota();
          context.header("Retry-After", "10");
          return context.json(
            {
              error: {
                code: "recognition_busy",
                message: "The recognition worker is busy; retry shortly",
              },
            },
            429,
          );
        }
        if (error instanceof RecognitionTimeoutError) {
          return context.json(
            {
              error: {
                code: "recognition_timeout",
                message: error.message,
              },
            },
            504,
          );
        }
        if (error instanceof RecognitionImageError) {
          return context.json(
            {
              error: {
                code:
                  error.reason === "unsupported"
                    ? "recognition_media_type"
                    : "recognition_invalid_image",
                message: error.message,
              },
            },
            error.reason === "unsupported" ? 415 : 422,
          );
        }
        if (error instanceof CatalogueUnavailableError) {
          return context.json(
            {
              error: {
                code: "catalogue_unavailable",
                message: error.message,
              },
            },
            503,
          );
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          return context.json(
            {
              error: {
                code: "recognition_cancelled",
                message: "Recognition was cancelled",
              },
            },
            408,
          );
        }
        throw error;
      } finally {
        image.fill(0);
      }
    },
  );

  app.get("/api/catalog/cards", async (context) => {
    const parsed = z
      .object({
        q: z.string().trim().min(1).max(120),
        language: catalogueLanguageMode.default("auto"),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .safeParse({
        q: context.req.query("q"),
        language: context.req.query("language") ?? context.req.query("lang"),
        limit: context.req.query("limit"),
      });
    if (!parsed.success)
      return context.json(invalidRequest(parsed.error.issues), 400);

    try {
      return context.json(
        await searchCatalogueLanguages({
          catalogue,
          query: parsed.data.q,
          language: parsed.data.language,
          perLanguageLimit:
            parsed.data.language === "auto"
              ? Math.min(AUTO_LANGUAGE_PER_LANGUAGE_LIMIT, parsed.data.limit)
              : parsed.data.limit,
          maxCards:
            parsed.data.language === "auto"
              ? Math.min(AUTO_LANGUAGE_CARD_LIMIT, parsed.data.limit)
              : parsed.data.limit,
        }),
      );
    } catch (error) {
      if (error instanceof CatalogueUnavailableError) {
        return context.json(
          {
            error: {
              code: "catalogue_unavailable",
              message: error.message,
            },
          },
          503,
        );
      }
      throw error;
    }
  });

  app.get("/api/catalog/cards/:id", async (context) => {
    const cardId = context.req.param("id");
    if (!cardId || cardId.length > 300) {
      return context.json(
        {
          error: {
            code: "invalid_request",
            message: "A valid card identifier is required",
          },
        },
        400,
      );
    }

    try {
      return context.json(await catalogue.getCard(cardId));
    } catch (error) {
      if (error instanceof CatalogueCardNotFoundError) {
        return context.json(
          { error: { code: "card_not_found", message: error.message } },
          404,
        );
      }
      if (error instanceof CatalogueUnavailableError) {
        return context.json(
          { error: { code: "catalogue_unavailable", message: error.message } },
          503,
        );
      }
      throw error;
    }
  });

  app.use("/api/sync", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  app.use("/api/sync", createAuthenticationMiddleware(authenticator));
  app.use("/api/sync", async (context, next) => {
    const lease = syncGuard.enter(context.get("principal").subject);
    if (!lease.allowed) {
      context.header("Retry-After", String(lease.retryAfterSeconds));
      return context.json(
        {
          error: {
            code: lease.reason === "rate" ? "sync_rate_limited" : "sync_busy",
            message:
              lease.reason === "rate"
                ? "Cloud sync request rate exceeded"
                : "Cloud sync is temporarily busy",
          },
        },
        lease.reason === "rate" ? 429 : 503,
      );
    }
    try {
      await next();
    } finally {
      lease.release();
    }
  });

  app.get("/api/sync", (context) => {
    const parsed = z
      .object({
        cursor: z.string().regex(/^\d+$/).optional(),
        generation: syncGeneration.optional(),
      })
      .superRefine((value, context) => {
        if (value.cursor !== undefined && value.generation === undefined) {
          context.addIssue({
            code: "custom",
            path: ["generation"],
            message: "A generation is required when a cursor is provided",
          });
        }
      })
      .safeParse({
        cursor: context.req.query("cursor"),
        generation: context.req.query("generation"),
      });
    if (!parsed.success)
      return context.json(invalidRequest(parsed.error.issues), 400);

    const principal = context.get("principal");
    try {
      return context.json(
        store.sync(
          principal.subject,
          {
            cursor: parsed.data.cursor,
            generation: parsed.data.generation ?? null,
            operations: [],
          },
          syncStoreOptions(config),
        ),
      );
    } catch (error) {
      return syncErrorResponse(context, error);
    }
  });

  app.post("/api/sync", syncBodyLimit, async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        {
          error: {
            code: "invalid_json",
            message: "The request body must be valid JSON",
          },
        },
        400,
      );
    }

    const schema = z
      .object({
        cursor: z.string().regex(/^\d+$/).nullable().optional(),
        generation: syncGeneration.nullable(),
        requireEmpty: z.boolean().optional(),
        operations: z.array(syncOperationSchema).max(config.sync.maxBatchSize),
      })
      .strict()
      .superRefine((value, context) => {
        if (
          value.generation === null &&
          ((value.cursor !== undefined &&
            value.cursor !== null &&
            value.cursor !== "0") ||
            value.operations.length > 0)
        ) {
          context.addIssue({
            code: "custom",
            path: ["generation"],
            message:
              "A null generation is only valid for an empty bootstrap request",
          });
        }
      });
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      return context.json(invalidRequest(parsed.error.issues), 400);

    const principal = context.get("principal");
    try {
      return context.json(
        store.sync(
          principal.subject,
          parsed.data as SyncRequest,
          syncStoreOptions(config),
        ),
      );
    } catch (error) {
      return syncErrorResponse(context, error);
    }
  });

  app.delete("/api/sync", (context) => {
    const principal = context.get("principal");
    try {
      const deletion = store.deleteAccount(
        principal.subject,
        syncStoreOptions(config),
      );
      return context.json({
        deleted: true,
        ...deletion,
        message:
          "Cloud sync events were deleted from the active database. This does not guarantee erasure from filesystem snapshots or backups, which follow their own retention policies.",
      });
    } catch (error) {
      return syncErrorResponse(context, error);
    }
  });

  if (config.staticRoot && existsSync(config.staticRoot)) {
    const staticFiles = serveStatic<AppEnvironment>({
      root: config.staticRoot,
      precompressed: true,
    });
    const spaIndex = serveStatic<AppEnvironment>({
      root: config.staticRoot,
      path: "index.html",
    });

    app.use("*", async (context, next) => {
      if (context.req.path === "/api" || context.req.path.startsWith("/api/"))
        return next();
      context.header(
        "Cache-Control",
        context.req.path.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0, must-revalidate",
      );
      return staticFiles(context, next);
    });
    app.get("*", async (context, next) => {
      if (context.req.path === "/api" || context.req.path.startsWith("/api/"))
        return next();
      context.header("Cache-Control", "public, max-age=0, must-revalidate");
      return spaIndex(context, next);
    });
  }

  app.notFound((context) =>
    context.json(
      { error: { code: "not_found", message: "Route not found" } },
      404,
    ),
  );

  return app;
}

export function createRuntime(config = loadConfig()): AppRuntime {
  const store = new SqliteStore(config.databasePath, {
    catalogueCacheMaxEntries: config.catalogue.cacheMaxEntries,
    catalogueCacheMaxBytes: config.catalogue.cacheMaxBytes,
  });
  store.pruneExpiredAccounts(new Date(), 100);
  store.pruneCatalogueCache(new Date(), 1_000);
  const enabledSources: CatalogueSource[] = [];
  if (config.catalogue.tcgdexCatalogEnabled) enabledSources.push("tcgdex");
  if (config.catalogue.pokemonTcgCatalogEnabled)
    enabledSources.push("pokemon_tcg");
  const catalogue = new CatalogueService({
    primary: new TcgdexAdapter({
      baseUrl: config.catalogue.tcgdexBaseUrl,
      timeoutMs: config.catalogue.timeoutMs,
      maxResponseBytes: config.catalogue.maxResponseBytes,
    }),
    secondary: new PokemonTcgAdapter({
      baseUrl: config.catalogue.pokemonTcgBaseUrl,
      apiKey: config.catalogue.pokemonTcgApiKey,
      timeoutMs: config.catalogue.timeoutMs,
      maxResponseBytes: config.catalogue.maxResponseBytes,
    }),
    enabledSources,
    cardImagesEnabled: config.catalogue.cardImagesEnabled,
    cache: store,
    cacheFreshMs: config.catalogue.cacheFreshMs,
    cacheMaxStaleMs: config.catalogue.cacheMaxStaleMs,
    providerFailureThreshold: config.catalogue.providerFailureThreshold,
    providerCooldownMs: config.catalogue.providerCooldownMs,
    marketQuotesEnabled: config.catalogue.marketQuotesEnabled,
  });
  const authenticator = createAuthenticator(config);
  const recognizer = new TesseractRecognitionEngine({
    dataPath: config.recognition.dataPath,
    maxPixels: config.recognition.maxPixels,
    normalizedMaxEdge: config.recognition.normalizedMaxEdge,
    timeoutMs: config.recognition.timeoutMs,
    idleTimeoutMs: config.recognition.idleTimeoutMs,
  });
  const dependencies = {
    config,
    store,
    catalogue,
    authenticator,
    recognizer,
  };
  const maintenanceTimer = setInterval(() => {
    try {
      const now = new Date();
      store.pruneExpiredAccounts(now, 100);
      store.pruneCatalogueCache(now, 1_000);
    } catch (error) {
      console.error("CardScope bounded retention cleanup failed", error);
    }
  }, config.maintenance.pruneIntervalMs);
  maintenanceTimer.unref();
  let closed = false;
  return {
    ...dependencies,
    app: createApp(dependencies),
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(maintenanceTimer);
      await recognizer.close();
      store.close();
    },
  };
}
