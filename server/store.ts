import { createHash } from "node:crypto";
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
import {
  compactSyncOperation,
  type JsonObject,
  rehydrateSyncOperation,
  SYNC_STORAGE_VERSION,
} from "./sync/codec.js";

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

interface CacheSizeRow {
  cache_key: string;
  stored_bytes: number;
}

interface SyncEventRow {
  sequence: number;
  operation_id: string;
  operation_type: SyncOperation["type"];
  holding_id: string;
  device_id: string | null;
  client_synced_at: string | null;
  operation_json: string;
  storage_version: number;
  card_snapshot_json: string | null;
  quote_snapshot_json: string | null;
  occurred_at: string;
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

interface SharedObjectRow {
  object_id: number;
  payload_json: string;
}

interface AccountSharedObjectRow {
  object_id: number;
  stored_bytes: number;
}

interface InternedSyncObject {
  objectId: number;
  storedBytes: number;
}

interface SyncTableInfoRow {
  name: string;
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
const DEFAULT_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_OPERATION_BYTES = 64 * 1024;
const DEFAULT_MAX_ACCOUNT_EVENTS = 10_000;
const DEFAULT_MAX_ACCOUNT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PULL_BYTES = 1024 * 1024;
const SYNC_ROW_OVERHEAD_BYTES = 96;
const SYNC_SHARED_OBJECT_ROW_OVERHEAD_BYTES = 96;
const CATALOGUE_CACHE_ROW_OVERHEAD_BYTES = 64;
const MAX_CACHE_BYTES = 16 * 1024 * 1024 * 1024;
const SHARED_OBJECT_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

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

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? "null";
}

function utf8Bytes(value: string | undefined): number {
  return value ? Buffer.byteLength(value, "utf8") : 0;
}

function storedSyncEventBytes(
  operation: SyncOperation,
  payloadJson: string,
): number {
  return (
    SYNC_ROW_OVERHEAD_BYTES +
    utf8Bytes(operation.id) +
    utf8Bytes(operation.type) +
    utf8Bytes(operation.holdingId) +
    utf8Bytes(operation.deviceId) +
    utf8Bytes(operation.occurredAt) +
    utf8Bytes(operation.syncedAt) +
    utf8Bytes(payloadJson)
  );
}

function storedSyncSharedObjectBytes(
  kind: "card" | "quote",
  contentHash: string,
  payloadJson: string,
): number {
  return (
    SYNC_SHARED_OBJECT_ROW_OVERHEAD_BYTES +
    utf8Bytes(kind) +
    utf8Bytes(contentHash) +
    utf8Bytes(payloadJson)
  );
}

function syncSharedObjectBytesSql(alias: string): string {
  return `(
    ${SYNC_SHARED_OBJECT_ROW_OVERHEAD_BYTES}
    + length(CAST(${alias}.object_kind AS BLOB))
    + length(CAST(${alias}.content_hash AS BLOB))
    + length(CAST(${alias}.payload_json AS BLOB))
  )`;
}

function catalogueCacheEntryBytesSql(): string {
  return `(
    ${CATALOGUE_CACHE_ROW_OVERHEAD_BYTES}
    + length(CAST(cache_key AS BLOB))
    + length(CAST(payload_json AS BLOB))
    + length(CAST(source AS BLOB))
    + length(CAST(fetched_at AS BLOB))
    + length(CAST(stale_after AS BLOB))
    + length(CAST(expires_at AS BLOB))
  )`;
}

export class SqliteStore {
  readonly database: DatabaseSync;
  private closed = false;
  private readonly catalogueCacheMaxEntries: number;
  private readonly catalogueCacheMaxBytes: number;
  private nextSharedObjectPruneAt = 0;

  constructor(
    filename: string,
    options: {
      catalogueCacheMaxEntries?: number;
      catalogueCacheMaxBytes?: number;
    } = {},
  ) {
    if (filename !== ":memory:")
      mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });

    this.catalogueCacheMaxEntries =
      options.catalogueCacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    this.catalogueCacheMaxBytes =
      options.catalogueCacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES;
    if (
      !Number.isSafeInteger(this.catalogueCacheMaxEntries) ||
      this.catalogueCacheMaxEntries < 1 ||
      this.catalogueCacheMaxEntries > 1_000_000
    ) {
      throw new Error(
        "Catalogue cache limit must be an integer between 1 and 1000000",
      );
    }
    if (
      !Number.isSafeInteger(this.catalogueCacheMaxBytes) ||
      this.catalogueCacheMaxBytes < 1 ||
      this.catalogueCacheMaxBytes > MAX_CACHE_BYTES
    ) {
      throw new Error(
        `Catalogue cache byte limit must be an integer between 1 and ${MAX_CACHE_BYTES}`,
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

      CREATE TABLE IF NOT EXISTS sync_shared_objects (
        object_id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_kind TEXT NOT NULL CHECK (object_kind IN ('card', 'quote')),
        content_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE (object_kind, content_hash)
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
        storage_version INTEGER NOT NULL DEFAULT 1,
        device_id TEXT,
        client_synced_at TEXT,
        card_snapshot_id INTEGER,
        quote_snapshot_id INTEGER,
        stored_bytes INTEGER,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE (user_id, operation_id),
        FOREIGN KEY (user_id) REFERENCES sync_accounts (user_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS sync_events_user_sequence_idx
        ON sync_events (user_id, sequence);
    `);

    this.migrateSyncEventColumns();
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS sync_events_card_snapshot_idx
        ON sync_events (card_snapshot_id);
      CREATE INDEX IF NOT EXISTS sync_events_quote_snapshot_idx
        ON sync_events (quote_snapshot_id);
      CREATE INDEX IF NOT EXISTS sync_events_storage_version_idx
        ON sync_events (storage_version, sequence);
    `);
    this.migrateLegacySyncEvents(1_000);
  }

  private migrateSyncEventColumns(): void {
    const columns = new Set(
      (
        this.database.prepare("PRAGMA table_info(sync_events)").all() as
          SyncTableInfoRow[] | []
      ).map((column) => column.name),
    );
    const additions = [
      ["storage_version", "INTEGER NOT NULL DEFAULT 0"],
      ["device_id", "TEXT"],
      ["client_synced_at", "TEXT"],
      ["card_snapshot_id", "INTEGER"],
      ["quote_snapshot_id", "INTEGER"],
      ["stored_bytes", "INTEGER"],
    ] as const;
    for (const [name, declaration] of additions) {
      if (!columns.has(name)) {
        this.database.exec(
          `ALTER TABLE sync_events ADD COLUMN ${name} ${declaration}`,
        );
      }
    }
  }

  private migrateLegacySyncEvents(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error(
        "Legacy sync migration limit must be an integer between 1 and 10000",
      );
    }
    const rows = this.database
      .prepare(
        `SELECT sequence, operation_json
         FROM sync_events
         WHERE storage_version = 0
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(limit) as unknown as Array<{
      sequence: number;
      operation_json: string;
    }>;
    if (rows.length === 0) return 0;

    const update = this.database.prepare(
      `UPDATE sync_events
       SET operation_json = ?,
           storage_version = ?,
           device_id = ?,
           client_synced_at = ?,
           card_snapshot_id = ?,
           quote_snapshot_id = ?,
           stored_bytes = ?
       WHERE sequence = ? AND storage_version = 0`,
    );

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const operation = JSON.parse(row.operation_json) as SyncOperation;
        const compacted = compactSyncOperation(operation);
        const payloadJson = canonicalJson(compacted.payload);
        const cardSnapshot = compacted.cardSnapshot
          ? this.internSyncObject("card", compacted.cardSnapshot)
          : null;
        const quoteSnapshot = compacted.quoteSnapshot
          ? this.internSyncObject("quote", compacted.quoteSnapshot)
          : null;
        update.run(
          payloadJson,
          SYNC_STORAGE_VERSION,
          operation.deviceId,
          operation.syncedAt ?? null,
          cardSnapshot?.objectId ?? null,
          quoteSnapshot?.objectId ?? null,
          storedSyncEventBytes(operation, payloadJson),
          row.sequence,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return rows.length;
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

  private internSyncObject(
    kind: "card" | "quote",
    payload: JsonObject,
  ): InternedSyncObject {
    const payloadJson = canonicalJson(payload);
    const contentHash = createHash("sha256")
      .update(payloadJson, "utf8")
      .digest("hex");
    this.database
      .prepare(
        `INSERT INTO sync_shared_objects (
           object_kind, content_hash, payload_json
         ) VALUES (?, ?, ?)
         ON CONFLICT (object_kind, content_hash) DO NOTHING`,
      )
      .run(kind, contentHash, payloadJson);
    const stored = this.database
      .prepare(
        `SELECT object_id, payload_json
         FROM sync_shared_objects
         WHERE object_kind = ? AND content_hash = ?`,
      )
      .get(kind, contentHash) as unknown as SharedObjectRow | undefined;
    if (!stored || stored.payload_json !== payloadJson) {
      throw new Error("Sync shared-object integrity check failed");
    }
    return {
      objectId: Number(stored.object_id),
      storedBytes: storedSyncSharedObjectBytes(kind, contentHash, payloadJson),
    };
  }

  private accountSharedObjects(userId: string): Map<number, number> {
    const rows = this.database
      .prepare(
        `SELECT object.object_id,
                ${syncSharedObjectBytesSql("object")} AS stored_bytes
         FROM sync_shared_objects AS object
         WHERE object.object_id IN (
           SELECT card_snapshot_id
           FROM sync_events
           WHERE user_id = ? AND card_snapshot_id IS NOT NULL
           UNION
           SELECT quote_snapshot_id
           FROM sync_events
           WHERE user_id = ? AND quote_snapshot_id IS NOT NULL
         )`,
      )
      .all(userId, userId) as unknown as AccountSharedObjectRow[];
    return new Map(
      rows.map((row) => [Number(row.object_id), Number(row.stored_bytes)]),
    );
  }

  private deleteUnreferencedSyncObjects(limit: number): number {
    return Number(
      this.database
        .prepare(
          `DELETE FROM sync_shared_objects
           WHERE object_id IN (
             SELECT object_id
             FROM sync_shared_objects AS candidate
             WHERE NOT EXISTS (
               SELECT 1
               FROM sync_events
               WHERE card_snapshot_id = candidate.object_id
                  OR quote_snapshot_id = candidate.object_id
             )
             ORDER BY object_id ASC
             LIMIT ?
           )`,
        )
        .run(limit).changes,
    );
  }

  private deleteAllUnreferencedSyncObjects(batchSize = 10_000): number {
    let total = 0;
    while (true) {
      const deleted = this.deleteUnreferencedSyncObjects(batchSize);
      total += deleted;
      if (deleted < batchSize) return total;
    }
  }

  pruneSyncSharedObjects(limit = 1_000): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error(
        "Shared sync-object prune limit must be an integer between 1 and 10000",
      );
    }
    const deleted = this.deleteUnreferencedSyncObjects(limit);
    if (deleted > 0) this.checkpointWal();
    return deleted;
  }

  private pruneSyncSharedObjectsIfDue(now: Date): void {
    if (now.getTime() < this.nextSharedObjectPruneAt) return;
    this.nextSharedObjectPruneAt =
      now.getTime() + SHARED_OBJECT_PRUNE_INTERVAL_MS;
    const deleted = this.deleteAllUnreferencedSyncObjects();
    if (deleted > 0) this.checkpointWal();
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

      const totalBytes = this.catalogueCacheBytes();
      let bytesToFree = Math.max(0, totalBytes - this.catalogueCacheMaxBytes);
      if (bytesToFree > 0) {
        const oldest = this.database
          .prepare(
            `SELECT cache_key,
                    ${catalogueCacheEntryBytesSql()} AS stored_bytes
             FROM catalogue_cache
             ORDER BY fetched_at ASC, cache_key ASC`,
          )
          .all() as unknown as CacheSizeRow[];
        const deleteEntry = this.database.prepare(
          "DELETE FROM catalogue_cache WHERE cache_key = ?",
        );
        for (const entry of oldest) {
          if (bytesToFree <= 0) break;
          const result = deleteEntry.run(entry.cache_key);
          if (result.changes === 1) {
            evicted += 1;
            bytesToFree -= Number(entry.stored_bytes);
          }
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    if (expired + evicted > 0) this.checkpointWal();
    return { expired, evicted };
  }

  catalogueCacheBytes(): number {
    const row = this.database
      .prepare(
        `SELECT COALESCE(SUM(${catalogueCacheEntryBytesSql()}), 0) AS total_bytes
         FROM catalogue_cache`,
      )
      .get() as { total_bytes?: number } | undefined;
    return Number(row?.total_bytes ?? 0);
  }

  deleteAccount(userId: string): boolean {
    if (userId.trim() === "")
      throw new Error("Sync user identifier cannot be empty");

    let deleted = false;
    let prunedObjects = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database
        .prepare("DELETE FROM sync_accounts WHERE user_id = ?")
        .run(userId);
      deleted = result.changes === 1;
      if (deleted) {
        // Each DELETE is bounded to 10k rows, while the loop gives the
        // account-erasure API a final no-orphan guarantee.
        prunedObjects = this.deleteAllUnreferencedSyncObjects();
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (deleted || prunedObjects > 0) this.checkpointWal();
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
    if (expiredAccounts.length === 0) {
      this.pruneSyncSharedObjectsIfDue(now);
      return 0;
    }

    let deleted = 0;
    let prunedObjects = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const deleteAccount = this.database.prepare(
        "DELETE FROM sync_accounts WHERE user_id = ? AND retention_until <= ?",
      );
      for (const account of expiredAccounts) {
        deleted += Number(deleteAccount.run(account.user_id, nowIso).changes);
      }
      if (deleted > 0) {
        // Expired-account cleanup has the same final guarantee as explicit
        // deletion, but each individual object DELETE remains bounded.
        prunedObjects = this.deleteAllUnreferencedSyncObjects();
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (deleted > 0 || prunedObjects > 0) this.checkpointWal();
    this.pruneSyncSharedObjectsIfDue(now);
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
      const compacted = compactSyncOperation(operation);
      const payloadJson = canonicalJson(compacted.payload);
      return {
        operation,
        compacted,
        payloadJson,
        storedBytes: storedSyncEventBytes(operation, payloadJson),
      };
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

    // Each sync makes bounded progress on legacy compaction and retention
    // cleanup without an unbounded table scan or long write transaction.
    this.migrateLegacySyncEvents(25);
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
           storage_version, device_id, client_synced_at, card_snapshot_id,
           quote_snapshot_id, stored_bytes, occurred_at, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, operation_id) DO NOTHING`,
      );
      const operationExists = this.database.prepare(
        `SELECT 1 AS present
         FROM sync_events
         WHERE user_id = ? AND operation_id = ?`,
      );

      const usage = this.database
        .prepare(
          `SELECT COUNT(*) AS event_count,
                  COALESCE(
                    SUM(
                      COALESCE(
                        stored_bytes,
                        length(CAST(operation_json AS BLOB))
                      )
                    ),
                    0
                  ) AS total_bytes
           FROM sync_events
           WHERE user_id = ?`,
        )
        .get(userId) as unknown as AccountUsageRow;
      const accountSharedObjects = this.accountSharedObjects(userId);
      let accountEvents = Number(usage.event_count);
      let accountBytes =
        Number(usage.total_bytes) +
        [...accountSharedObjects.values()].reduce(
          (total, bytes) => total + bytes,
          0,
        );

      for (const {
        operation,
        compacted,
        payloadJson,
        storedBytes,
      } of serializedOperations) {
        if (operationExists.get(userId, operation.id)) continue;
        const cardSnapshot = compacted.cardSnapshot
          ? this.internSyncObject("card", compacted.cardSnapshot)
          : null;
        const quoteSnapshot = compacted.quoteSnapshot
          ? this.internSyncObject("quote", compacted.quoteSnapshot)
          : null;
        const result = insertEvent.run(
          userId,
          operation.id,
          operation.type,
          operation.holdingId,
          payloadJson,
          SYNC_STORAGE_VERSION,
          operation.deviceId,
          operation.syncedAt ?? null,
          cardSnapshot?.objectId ?? null,
          quoteSnapshot?.objectId ?? null,
          storedBytes,
          operation.occurredAt,
          nowIso,
        );
        if (result.changes === 1) {
          accountEvents += 1;
          accountBytes += storedBytes;
          // Shared snapshots count once per account, regardless of how many
          // operations reference them. Global content-addressed deduplication
          // still ensures the database stores only one physical object.
          for (const snapshot of [cardSnapshot, quoteSnapshot]) {
            if (snapshot && !accountSharedObjects.has(snapshot.objectId)) {
              accountBytes += snapshot.storedBytes;
              accountSharedObjects.set(snapshot.objectId, snapshot.storedBytes);
            }
          }
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
        `SELECT event.sequence,
                event.operation_id,
                event.operation_type,
                event.holding_id,
                event.device_id,
                event.client_synced_at,
                event.operation_json,
                event.storage_version,
                event.occurred_at,
                event.received_at,
                card.payload_json AS card_snapshot_json,
                quote.payload_json AS quote_snapshot_json
         FROM sync_events AS event
         LEFT JOIN sync_shared_objects AS card
           ON card.object_id = event.card_snapshot_id
         LEFT JOIN sync_shared_objects AS quote
           ON quote.object_id = event.quote_snapshot_id
         WHERE event.user_id = ? AND event.sequence > ?
         ORDER BY event.sequence ASC
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
      const operation =
        row.storage_version === SYNC_STORAGE_VERSION
          ? rehydrateSyncOperation(
              {
                id: row.operation_id,
                type: row.operation_type,
                holdingId: row.holding_id,
                deviceId: row.device_id ?? "",
                occurredAt: row.occurred_at,
                ...(row.client_synced_at
                  ? { syncedAt: row.client_synced_at }
                  : {}),
              },
              JSON.parse(row.operation_json) as JsonObject,
              row.card_snapshot_json
                ? (JSON.parse(row.card_snapshot_json) as JsonObject)
                : null,
              row.quote_snapshot_json
                ? (JSON.parse(row.quote_snapshot_json) as JsonObject)
                : null,
            )
          : (JSON.parse(row.operation_json) as SyncOperation);
      const event = {
        ...operation,
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
