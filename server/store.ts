import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CatalogueSource,
  SyncEvent,
  SyncOperation,
  SyncRequest,
  SyncResponse,
} from "../shared/types.js";

export interface CacheEntry<T> {
  key: string;
  value: T;
  source: CatalogueSource;
  fetchedAt: string;
  staleAfter: string;
  expiresAt: string;
  status: "fresh" | "stale";
}

export interface PutCacheEntry<T> {
  key: string;
  value: T;
  source: CatalogueSource;
  fetchedAt: string;
  staleAfter: string;
  expiresAt: string;
}

interface CacheRow {
  cache_key: string;
  payload_json: string;
  source: CatalogueSource;
  fetched_at: string;
  stale_after: string;
  expires_at: string;
}

interface SyncEventRow {
  sequence: number;
  operation_json: string;
  received_at: string;
}

interface RetentionRow {
  retention_until: string;
}

interface ExpiredAccountRow {
  user_id: string;
}

interface AccountUsageRow {
  event_count: number;
  total_bytes: number;
}

export interface CatalogueCachePruneResult {
  expired: number;
  evicted: number;
}

export interface SyncStoreOptions {
  retentionDays: number;
  eventLimit?: number;
  maxOperationBytes?: number;
  maxAccountEvents?: number;
  maxAccountBytes?: number;
  maxPullBytes?: number;
  now?: Date;
}

export class SyncOperationTooLargeError extends Error {
  constructor(
    readonly operationId: string,
    readonly bytes: number,
    readonly maximumBytes: number,
  ) {
    super(
      `Sync operation ${operationId} exceeds the ${maximumBytes}-byte limit`,
    );
    this.name = "SyncOperationTooLargeError";
  }
}

export class SyncStorageLimitError extends Error {
  constructor(readonly limit: "events" | "bytes") {
    super(
      limit === "events"
        ? "Cloud sync event limit reached for this account"
        : "Cloud sync storage limit reached for this account",
    );
    this.name = "SyncStorageLimitError";
  }
}

const DEFAULT_CACHE_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_OPERATION_BYTES = 64 * 1024;
const DEFAULT_MAX_ACCOUNT_EVENTS = 10_000;
const DEFAULT_MAX_ACCOUNT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PULL_BYTES = 1024 * 1024;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1_000);
}

function parseCursor(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (!/^\d+$/.test(cursor))
    throw new Error("Sync cursor must be a non-negative integer");

  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed))
    throw new Error("Sync cursor is outside the supported range");
  return parsed;
}

export class SqliteStore {
  readonly database: DatabaseSync;
  private closed = false;
  private readonly catalogueCacheMaxEntries: number;

  constructor(
    filename: string,
    options: { catalogueCacheMaxEntries?: number } = {},
  ) {
    if (filename !== ":memory:")
      mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });

    this.catalogueCacheMaxEntries =
      options.catalogueCacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    if (
      !Number.isSafeInteger(this.catalogueCacheMaxEntries) ||
      this.catalogueCacheMaxEntries < 1 ||
      this.catalogueCacheMaxEntries > 1_000_000
    ) {
      throw new Error(
        "Catalogue cache limit must be an integer between 1 and 1000000",
      );
    }

    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS catalogue_cache (
        cache_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('tcgdex', 'pokemon_tcg')),
        fetched_at TEXT NOT NULL,
        stale_after TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS catalogue_cache_expiry_idx
        ON catalogue_cache (expires_at);

      CREATE TABLE IF NOT EXISTS sync_accounts (
        user_id TEXT PRIMARY KEY,
        retention_until TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS sync_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        operation_type TEXT NOT NULL CHECK (
          operation_type IN (
            'holding.added',
            'holding.quantity-adjusted',
            'holding.updated',
            'holding.removed'
          )
        ),
        holding_id TEXT NOT NULL,
        operation_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE (user_id, operation_id),
        FOREIGN KEY (user_id) REFERENCES sync_accounts (user_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS sync_events_user_sequence_idx
        ON sync_events (user_id, sequence);
    `);
  }

  journalMode(): string {
    const row = this.database.prepare("PRAGMA journal_mode").get() as
      { journal_mode?: string } | undefined;
    return row?.journal_mode ?? "unknown";
  }

  ping(): boolean {
    const row = this.database.prepare("SELECT 1 AS ok").get() as
      { ok?: number } | undefined;
    return row?.ok === 1;
  }

  private checkpointWal(): void {
    if (this.journalMode() === "wal") {
      this.database.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
    }
  }

  getCache<T>(key: string, now = new Date()): CacheEntry<T> | null {
    const row = this.database
      .prepare(
        `SELECT cache_key, payload_json, source, fetched_at, stale_after, expires_at
         FROM catalogue_cache
         WHERE cache_key = ?`,
      )
      .get(key) as CacheRow | undefined;

    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= now.getTime()) {
      const deleted = this.database
        .prepare(
          "DELETE FROM catalogue_cache WHERE cache_key = ? AND expires_at <= ?",
        )
        .run(key, now.toISOString());
      if (deleted.changes > 0) this.checkpointWal();
      return null;
    }

    return {
      key: row.cache_key,
      value: JSON.parse(row.payload_json) as T,
      source: row.source,
      fetchedAt: row.fetched_at,
      staleAfter: row.stale_after,
      expiresAt: row.expires_at,
      status:
        new Date(row.stale_after).getTime() > now.getTime() ? "fresh" : "stale",
    };
  }

  putCache<T>(entry: PutCacheEntry<T>): void {
    this.database
      .prepare(
        `INSERT INTO catalogue_cache (
           cache_key, payload_json, source, fetched_at, stale_after, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (cache_key) DO UPDATE SET
           payload_json = excluded.payload_json,
           source = excluded.source,
           fetched_at = excluded.fetched_at,
           stale_after = excluded.stale_after,
           expires_at = excluded.expires_at`,
      )
      .run(
        entry.key,
        JSON.stringify(entry.value),
        entry.source,
        entry.fetchedAt,
        entry.staleAfter,
        entry.expiresAt,
      );

    const pruneTime = new Date(entry.fetchedAt);
    this.pruneCatalogueCache(
      Number.isNaN(pruneTime.getTime()) ? new Date() : pruneTime,
      500,
    );
  }

  pruneCatalogueCache(
    now = new Date(),
    expiredLimit = 1_000,
  ): CatalogueCachePruneResult {
    if (Number.isNaN(now.getTime()))
      throw new Error("Cache prune time must be a valid date");
    if (
      !Number.isSafeInteger(expiredLimit) ||
      expiredLimit < 1 ||
      expiredLimit > 10_000
    ) {
      throw new Error(
        "Cache prune limit must be an integer between 1 and 10000",
      );
    }

    let expired = 0;
    let evicted = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      expired = Number(
        this.database
          .prepare(
            `DELETE FROM catalogue_cache
             WHERE cache_key IN (
               SELECT cache_key
               FROM catalogue_cache
               WHERE expires_at <= ?
               ORDER BY expires_at ASC, cache_key ASC
               LIMIT ?
             )`,
          )
          .run(now.toISOString(), expiredLimit).changes,
      );

      const countRow = this.database
        .prepare("SELECT COUNT(*) AS count FROM catalogue_cache")
        .get() as { count: number };
      const excess = Math.max(
        0,
        Number(countRow.count) - this.catalogueCacheMaxEntries,
      );
      if (excess > 0) {
        evicted = Number(
          this.database
            .prepare(
              `DELETE FROM catalogue_cache
               WHERE cache_key IN (
                 SELECT cache_key
                 FROM catalogue_cache
                 ORDER BY fetched_at ASC, cache_key ASC
                 LIMIT ?
               )`,
            )
            .run(excess).changes,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    if (expired + evicted > 0) this.checkpointWal();
    return { expired, evicted };
  }

  deleteAccount(userId: string): boolean {
    if (userId.trim() === "")
      throw new Error("Sync user identifier cannot be empty");

    let deleted = false;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database
        .prepare("DELETE FROM sync_accounts WHERE user_id = ?")
        .run(userId);
      this.database.exec("COMMIT");
      deleted = result.changes === 1;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (deleted) this.checkpointWal();
    return deleted;
  }

  pruneExpiredAccounts(now = new Date(), limit = 100): number {
    if (Number.isNaN(now.getTime()))
      throw new Error("Prune time must be a valid date");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Prune limit must be an integer between 1 and 1000");
    }

    const nowIso = now.toISOString();
    const expiredAccounts = this.database
      .prepare(
        `SELECT user_id
         FROM sync_accounts
         WHERE retention_until <= ?
         ORDER BY retention_until ASC, user_id ASC
         LIMIT ?`,
      )
      .all(nowIso, limit) as unknown as ExpiredAccountRow[];
    if (expiredAccounts.length === 0) return 0;

    let deleted = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const deleteAccount = this.database.prepare(
        "DELETE FROM sync_accounts WHERE user_id = ? AND retention_until <= ?",
      );
      for (const account of expiredAccounts) {
        deleted += Number(deleteAccount.run(account.user_id, nowIso).changes);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (deleted > 0) this.checkpointWal();
    return deleted;
  }

  sync(
    userId: string,
    request: SyncRequest,
    options: SyncStoreOptions,
  ): SyncResponse {
    if (userId.trim() === "")
      throw new Error("Sync user identifier cannot be empty");

    const cursor = parseCursor(request.cursor);
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const retentionUntil = addDays(now, options.retentionDays).toISOString();
    const eventLimit = options.eventLimit ?? 500;
    const maxOperationBytes =
      options.maxOperationBytes ?? DEFAULT_MAX_OPERATION_BYTES;
    const maxAccountEvents =
      options.maxAccountEvents ?? DEFAULT_MAX_ACCOUNT_EVENTS;
    const maxAccountBytes =
      options.maxAccountBytes ?? DEFAULT_MAX_ACCOUNT_BYTES;
    const maxPullBytes = options.maxPullBytes ?? DEFAULT_MAX_PULL_BYTES;
    const acceptedOperationIds: string[] = [];
    const serializedOperations = request.operations.map((operation) => {
      const json = JSON.stringify(operation);
      const bytes = Buffer.byteLength(json, "utf8");
      if (bytes > maxOperationBytes) {
        throw new SyncOperationTooLargeError(
          operation.id,
          bytes,
          maxOperationBytes,
        );
      }
      return { operation, json, bytes };
    });

    for (const [name, value] of [
      ["eventLimit", eventLimit],
      ["maxOperationBytes", maxOperationBytes],
      ["maxAccountEvents", maxAccountEvents],
      ["maxAccountBytes", maxAccountBytes],
      ["maxPullBytes", maxPullBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
      }
    }

    // Each sync makes bounded progress on retention cleanup without an
    // unbounded table scan or long write transaction.
    this.pruneExpiredAccounts(now, 25);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO sync_accounts (user_id, retention_until, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT (user_id) DO NOTHING`,
        )
        .run(userId, retentionUntil, nowIso);

      const insertEvent = this.database.prepare(
        `INSERT INTO sync_events (
           user_id, operation_id, operation_type, holding_id, operation_json,
           occurred_at, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, operation_id) DO NOTHING`,
      );

      const usage = this.database
        .prepare(
          `SELECT COUNT(*) AS event_count,
                  COALESCE(SUM(length(CAST(operation_json AS BLOB))), 0) AS total_bytes
           FROM sync_events
           WHERE user_id = ?`,
        )
        .get(userId) as unknown as AccountUsageRow;
      let accountEvents = Number(usage.event_count);
      let accountBytes = Number(usage.total_bytes);

      for (const { operation, json, bytes } of serializedOperations) {
        const result = insertEvent.run(
          userId,
          operation.id,
          operation.type,
          operation.holdingId,
          json,
          operation.occurredAt,
          nowIso,
        );
        if (result.changes === 1) {
          accountEvents += 1;
          accountBytes += bytes;
          if (accountEvents > maxAccountEvents)
            throw new SyncStorageLimitError("events");
          if (accountBytes > maxAccountBytes)
            throw new SyncStorageLimitError("bytes");
          acceptedOperationIds.push(operation.id);
        }
      }

      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    const storedRetention = this.database
      .prepare("SELECT retention_until FROM sync_accounts WHERE user_id = ?")
      .get(userId) as unknown as RetentionRow;
    const rows = this.database
      .prepare(
        `SELECT sequence, operation_json, received_at
         FROM sync_events
         WHERE user_id = ? AND sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(userId, cursor, eventLimit) as unknown as SyncEventRow[];

    const events: SyncEvent[] = [];
    const emptyResponse: SyncResponse = {
      acceptedOperationIds,
      cursor: String(cursor),
      events: [],
      hasMore: true,
      retentionUntil: storedRetention.retention_until,
    };
    let responseBytes =
      Buffer.byteLength(JSON.stringify(emptyResponse), "utf8") + 64;
    for (const row of rows) {
      const event = {
        ...(JSON.parse(row.operation_json) as SyncOperation),
        sequence: Number(row.sequence),
        receivedAt: row.received_at,
      } as SyncEvent;
      const eventBytes =
        Buffer.byteLength(JSON.stringify(event), "utf8") +
        (events.length ? 1 : 0);
      if (responseBytes + eventBytes > maxPullBytes) break;
      events.push(event);
      responseBytes += eventBytes;
    }

    const nextCursor =
      events.length > 0 ? events[events.length - 1].sequence : cursor;
    const moreRow = this.database
      .prepare(
        `SELECT 1 AS present
         FROM sync_events
         WHERE user_id = ? AND sequence > ?
         LIMIT 1`,
      )
      .get(userId, nextCursor) as { present?: number } | undefined;
    const response: SyncResponse = {
      acceptedOperationIds,
      cursor: String(nextCursor),
      events,
      hasMore: moreRow?.present === 1,
      retentionUntil: storedRetention.retention_until,
    };
    while (
      response.events.length > 0 &&
      Buffer.byteLength(JSON.stringify(response), "utf8") > maxPullBytes
    ) {
      response.events.pop();
      response.cursor = String(
        response.events.length > 0
          ? response.events[response.events.length - 1].sequence
          : cursor,
      );
      response.hasMore = true;
    }
    return response;
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}
