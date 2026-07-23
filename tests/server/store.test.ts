import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  SqliteStore,
  SyncEnrollmentConflictError,
  SyncGenerationMismatchError,
  SyncOperationConflictError,
  SyncOperationInvalidError,
  SyncOperationTooLargeError,
  SyncStorageLimitError,
} from "../../server/store.js";
import { FIXED_NOW, testOperation } from "./fixtures.js";

const SYNC_OPTIONS = { retentionDays: 1_826, now: FIXED_NOW } as const;

function syncOperations(
  store: SqliteStore,
  userId: string,
  operations: Parameters<SqliteStore["sync"]>[1]["operations"],
  options: Parameters<SqliteStore["sync"]>[2] = SYNC_OPTIONS,
) {
  const bootstrap = store.sync(
    userId,
    { generation: null, operations: [] },
    options,
  );
  return store.sync(
    userId,
    { generation: bootstrap.generation, operations },
    options,
  );
}

function richAddedOperation(id = "operation-rich") {
  const quote = {
    source: "tcgdex",
    market: "cardmarket",
    currency: "EUR",
    sku: "base1-58:reverse:near-mint",
    finish: "reverse",
    condition: "near-mint",
    low: 18.5,
    marketPrice: 22,
    high: 27,
    volume: 12,
    observedAt: "2026-07-22T10:00:00.000Z",
    staleAfter: "2026-07-23T10:00:00.000Z",
  };
  return testOperation({
    id,
    holdingId: `holding-${id}`,
    payload: {
      holding: {
        id: `holding-${id}`,
        cardId: "pokemon-card:en:base1:58:pikachu",
        card: {
          id: "pokemon-card:en:base1:58:pikachu",
          name: "Pikachu",
          number: "58",
          printedNumber: "58",
          setId: "base1",
          setName: "Base Set",
          language: "en",
          rarity: "Common",
          images: {
            small: "https://images.example/pikachu-small.webp",
            large: "https://images.example/pikachu-large.webp",
          },
          externalIds: { tcgdex: "base1-58" },
          quote,
          quotes: [quote],
        },
        quantity: 1,
        finish: "reverse",
        condition: "near-mint",
        unitCost: { amount: 4.5, currency: "EUR" },
        quote,
        acquiredAt: "2025-12-24T00:00:00.000Z",
        addedAt: FIXED_NOW.toISOString(),
        updatedAt: FIXED_NOW.toISOString(),
      },
    },
  });
}

function distinctAddedOperation(id: string, holdingId: string) {
  const operation = testOperation({ id });
  return testOperation({
    id,
    holdingId,
    payload: {
      holding: {
        ...(operation.payload as { holding: Record<string, unknown> }).holding,
        id: holdingId,
      },
    },
  });
}

function largeSharedObjectOperation(id: string) {
  const operation = richAddedOperation(id);
  const holding = (
    operation.payload as {
      holding: { card: { name: string } };
    }
  ).holding;
  holding.card.name = "P".repeat(4_000);
  return operation;
}

function seedReferencedSharedObjects(
  store: SqliteStore,
  userId: string,
  count: number,
  retentionUntil: string,
): void {
  const insertObject = store.database.prepare(
    `INSERT INTO sync_shared_objects (
       object_kind, content_hash, payload_json
     ) VALUES ('card', ?, ?)`,
  );
  const insertEvent = store.database.prepare(
    `INSERT INTO sync_events (
       user_id, operation_id, operation_type, holding_id, operation_json,
       storage_version, device_id, card_snapshot_id, stored_bytes,
       occurred_at, received_at
     ) VALUES (?, ?, 'holding.updated', ?, '{}', 1, 'seed-device', ?, 100, ?, ?)`,
  );

  store.database.exec("BEGIN IMMEDIATE");
  try {
    store.database
      .prepare(
        `INSERT INTO sync_accounts (user_id, retention_until, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(userId, retentionUntil, FIXED_NOW.toISOString());
    for (let index = 0; index < count; index += 1) {
      const object = insertObject.run(
        `seed-hash-${index}`,
        JSON.stringify({ id: index }),
      );
      insertEvent.run(
        userId,
        `seed-operation-${index}`,
        `seed-holding-${index}`,
        Number(object.lastInsertRowid),
        FIXED_NOW.toISOString(),
        FIXED_NOW.toISOString(),
      );
    }
    store.database.exec("COMMIT");
  } catch (error) {
    store.database.exec("ROLLBACK");
    throw error;
  }
}

describe("SQLite store", () => {
  it("should enable WAL for a file-backed database", () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "cardscope-store-"),
    );
    const store = new SqliteStore(path.join(temporaryDirectory, "test.sqlite"));

    try {
      expect(store.journalMode()).toBe("wal");
      expect(store.ping()).toBe(true);
    } finally {
      store.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("should expose cache entries as fresh, stale and expired at the configured times", () => {
    const store = new SqliteStore(":memory:");
    const fetchedAt = FIXED_NOW.toISOString();
    const staleAfter = new Date(FIXED_NOW.getTime() + 1_000).toISOString();
    const expiresAt = new Date(FIXED_NOW.getTime() + 5_000).toISOString();

    try {
      store.putCache({
        key: "catalogue:test",
        value: { cards: 1 },
        source: "tcgdex",
        fetchedAt,
        staleAfter,
        expiresAt,
      });

      expect(store.getCache("catalogue:test", FIXED_NOW)).toMatchObject({
        value: { cards: 1 },
        status: "fresh",
      });
      expect(
        store.getCache("catalogue:test", new Date(FIXED_NOW.getTime() + 2_000)),
      ).toMatchObject({ status: "stale" });
      expect(
        store.getCache("catalogue:test", new Date(FIXED_NOW.getTime() + 5_000)),
      ).toBeNull();
    } finally {
      store.close();
    }
  });

  it("should persist expired-cache pruning and enforce cache cardinality", () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "cardscope-cache-"),
    );
    const filename = path.join(temporaryDirectory, "cache.sqlite");
    const first = new SqliteStore(filename, { catalogueCacheMaxEntries: 3 });
    const entry = (key: string, fetchedAt: Date, expiresAt: Date) => ({
      key,
      value: { key },
      source: "tcgdex" as const,
      fetchedAt: fetchedAt.toISOString(),
      staleAfter: expiresAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });

    try {
      first.putCache(
        entry("expired", FIXED_NOW, new Date(FIXED_NOW.getTime() + 1_000)),
      );
      first.putCache(
        entry(
          "active-a",
          new Date(FIXED_NOW.getTime() + 10),
          new Date(FIXED_NOW.getTime() + 10_000),
        ),
      );
      first.putCache(
        entry(
          "active-b",
          new Date(FIXED_NOW.getTime() + 20),
          new Date(FIXED_NOW.getTime() + 10_000),
        ),
      );
      first.close();

      const second = new SqliteStore(filename, { catalogueCacheMaxEntries: 2 });
      expect(
        second.pruneCatalogueCache(new Date(FIXED_NOW.getTime() + 2_000)),
      ).toEqual({
        expired: 1,
        evicted: 0,
      });
      expect(
        second.database
          .prepare("SELECT cache_key FROM catalogue_cache ORDER BY cache_key")
          .all(),
      ).toEqual([{ cache_key: "active-a" }, { cache_key: "active-b" }]);
      second.close();

      const reopened = new SqliteStore(filename, {
        catalogueCacheMaxEntries: 2,
      });
      expect(
        reopened.database
          .prepare("SELECT COUNT(*) AS count FROM catalogue_cache")
          .get(),
      ).toMatchObject({ count: 2 });
      reopened.close();
    } finally {
      first.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("should evict the oldest cache entry when cardinality is exceeded", () => {
    const store = new SqliteStore(":memory:", { catalogueCacheMaxEntries: 2 });
    try {
      for (let index = 0; index < 3; index += 1) {
        const fetchedAt = new Date(FIXED_NOW.getTime() + index * 1_000);
        store.putCache({
          key: `entry-${index}`,
          value: { index },
          source: "tcgdex",
          fetchedAt: fetchedAt.toISOString(),
          staleAfter: new Date(fetchedAt.getTime() + 10_000).toISOString(),
          expiresAt: new Date(fetchedAt.getTime() + 20_000).toISOString(),
        });
      }

      expect(
        store.database
          .prepare("SELECT cache_key FROM catalogue_cache ORDER BY cache_key")
          .all(),
      ).toEqual([{ cache_key: "entry-1" }, { cache_key: "entry-2" }]);
    } finally {
      store.close();
    }
  });

  it("should cap catalogue cache bytes independently from entry count", () => {
    const store = new SqliteStore(":memory:", {
      catalogueCacheMaxEntries: 100,
      catalogueCacheMaxBytes: 800,
    });
    try {
      for (let index = 0; index < 3; index += 1) {
        const fetchedAt = new Date(FIXED_NOW.getTime() + index * 1_000);
        store.putCache({
          key: `sized-entry-${index}`,
          value: { payload: "x".repeat(180), index },
          source: "tcgdex",
          fetchedAt: fetchedAt.toISOString(),
          staleAfter: new Date(fetchedAt.getTime() + 10_000).toISOString(),
          expiresAt: new Date(fetchedAt.getTime() + 20_000).toISOString(),
        });
      }

      expect(store.catalogueCacheBytes()).toBeLessThanOrEqual(800);
      expect(
        store.database
          .prepare("SELECT cache_key FROM catalogue_cache ORDER BY cache_key")
          .all(),
      ).toEqual([
        { cache_key: "sized-entry-1" },
        { cache_key: "sized-entry-2" },
      ]);
    } finally {
      store.close();
    }
  });

  it("should reject invalid catalogue cache byte caps", () => {
    expect(
      () =>
        new SqliteStore(":memory:", {
          catalogueCacheMaxBytes: 0,
        }),
    ).toThrow("Catalogue cache byte limit");
  });

  it("should append sync operations once per user and resume from an opaque cursor", () => {
    const store = new SqliteStore(":memory:");
    const operation = testOperation();

    try {
      const first = syncOperations(store, "user-a", [operation], {
        retentionDays: 1_826,
        now: FIXED_NOW,
      });
      const duplicate = store.sync(
        "user-a",
        {
          cursor: first.cursor,
          generation: first.generation,
          operations: [operation],
        },
        {
          retentionDays: 1_826,
          now: new Date(FIXED_NOW.getTime() + 86_400_000),
        },
      );
      const sameIdForAnotherUser = syncOperations(
        store,
        "user-b",
        [operation],
        { retentionDays: 1_826, now: FIXED_NOW },
      );

      expect(first.acceptedOperationIds).toEqual([operation.id]);
      expect(first.generation).toBe("1");
      expect(first.events).toHaveLength(1);
      expect(first.events[0]).toMatchObject({
        id: operation.id,
        sequence: 1,
        receivedAt: FIXED_NOW.toISOString(),
      });
      expect(first.retentionUntil).toBe("2031-07-22T12:00:00.000Z");
      expect(duplicate.acceptedOperationIds).toEqual([operation.id]);
      expect(duplicate.generation).toBe("1");
      expect(duplicate.events).toEqual([]);
      // Retention is anchored on first activation, not silently renewed on every sync.
      expect(duplicate.retentionUntil).toBe(first.retentionUntil);
      expect(sameIdForAnotherUser.acceptedOperationIds).toEqual([operation.id]);
      expect(sameIdForAnotherUser.generation).toBe("2");
      expect(sameIdForAnotherUser.events).toHaveLength(1);
      expect(
        store.database
          .prepare(
            `SELECT user_id, generation
             FROM sync_accounts
             ORDER BY user_id`,
          )
          .all(),
      ).toEqual([
        { user_id: "user-a", generation: 1 },
        { user_id: "user-b", generation: 2 },
      ]);
    } finally {
      store.close();
    }
  });

  it("should reject an operation-id collision without mutating the stored operation", () => {
    const store = new SqliteStore(":memory:");
    const original = testOperation();
    const conflicting = testOperation({
      payload: {
        holding: {
          ...(original.payload as { holding: Record<string, unknown> }).holding,
          quantity: 2,
        },
      },
    });

    try {
      const initial = syncOperations(store, "user-a", [original]);
      expect(() =>
        store.sync(
          "user-a",
          {
            generation: initial.generation,
            operations: [conflicting],
          },
          SYNC_OPTIONS,
        ),
      ).toThrow(SyncOperationConflictError);

      const stored = store.sync(
        "user-a",
        { generation: initial.generation, operations: [] },
        SYNC_OPTIONS,
      );
      expect(stored.events).toHaveLength(1);
      expect(stored.events[0]?.payload).toEqual(original.payload);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      store.close();
    }
  });

  it("should allow an exact enrollment retry after later operations exist", () => {
    const store = new SqliteStore(":memory:");
    const adopted = testOperation({ id: "operation-adopted" });
    const adoptedSecond = distinctAddedOperation(
      "operation-adopted-second",
      "holding-adopted-second",
    );
    const unrelated = distinctAddedOperation(
      "operation-unrelated",
      "holding-unrelated",
    );
    const newEnrollment = distinctAddedOperation(
      "operation-new-enrollment",
      "holding-new-enrollment",
    );

    try {
      const bootstrap = store.sync(
        "user-a",
        { generation: null, operations: [] },
        SYNC_OPTIONS,
      );
      const first = store.sync(
        "user-a",
        {
          generation: bootstrap.generation,
          requireEmpty: true,
          operations: [adopted, adoptedSecond],
        },
        SYNC_OPTIONS,
      );
      const later = store.sync(
        "user-a",
        {
          cursor: first.cursor,
          generation: bootstrap.generation,
          operations: [unrelated],
        },
        SYNC_OPTIONS,
      );
      const retry = store.sync(
        "user-a",
        {
          cursor: later.cursor,
          generation: bootstrap.generation,
          requireEmpty: true,
          operations: [adopted, adoptedSecond],
        },
        SYNC_OPTIONS,
      );

      expect(retry.acceptedOperationIds).toEqual([
        adopted.id,
        adoptedSecond.id,
      ]);
      expect(retry.events).toEqual([]);
      expect(() =>
        store.sync(
          "user-a",
          {
            generation: bootstrap.generation,
            requireEmpty: true,
            operations: [newEnrollment],
          },
          SYNC_OPTIONS,
        ),
      ).toThrow(SyncEnrollmentConflictError);
      expect(
        store.database
          .prepare(
            `SELECT operation_id
             FROM sync_events
             ORDER BY sequence`,
          )
          .all(),
      ).toEqual([
        { operation_id: adopted.id },
        { operation_id: adoptedSecond.id },
        { operation_id: unrelated.id },
      ]);
    } finally {
      store.close();
    }
  });

  it("should reject non-canonical or unsafe sync generation strings", () => {
    const store = new SqliteStore(":memory:");

    try {
      for (const generation of ["0", "01", "9007199254740992"]) {
        expect(() =>
          store.sync("user-a", { generation, operations: [] }, SYNC_OPTIONS),
        ).toThrow(/generation/i);
      }
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_accounts")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("should allocate an absent-account epoch only from trusted server state", () => {
    const store = new SqliteStore(":memory:");

    try {
      let mismatch: unknown;
      try {
        store.sync(
          "poison-attempt",
          {
            generation: "9007199254740990",
            operations: [],
          },
          SYNC_OPTIONS,
        );
      } catch (error) {
        mismatch = error;
      }
      expect(mismatch).toBeInstanceOf(SyncGenerationMismatchError);
      expect((mismatch as SyncGenerationMismatchError).currentGeneration).toBe(
        "1",
      );
      expect(
        store.database
          .prepare(
            `SELECT integer_value
             FROM sync_metadata
             WHERE metadata_key = 'last_generation'`,
          )
          .get(),
      ).toEqual({ integer_value: 1 });

      const healthy = store.sync(
        "healthy-user",
        { generation: null, operations: [] },
        SYNC_OPTIONS,
      );
      expect(healthy.generation).toBe("2");
    } finally {
      store.close();
    }
  });

  it("should enforce the account cap on bootstrap, stale tombstones, and deletion", () => {
    const store = new SqliteStore(":memory:");
    const capped = { ...SYNC_OPTIONS, maxAccounts: 1 };

    try {
      store.sync(
        "capacity-owner",
        { generation: null, operations: [] },
        capped,
      );
      expect(() =>
        store.sync(
          "bootstrap-over-capacity",
          { generation: null, operations: [] },
          capped,
        ),
      ).toThrow(SyncStorageLimitError);
      expect(() =>
        store.sync(
          "stale-over-capacity",
          { generation: "999999", operations: [] },
          capped,
        ),
      ).toThrow(SyncStorageLimitError);
      expect(() => store.deleteAccount("delete-over-capacity", capped)).toThrow(
        SyncStorageLimitError,
      );
      expect(
        store.database.prepare("SELECT user_id FROM sync_accounts").all(),
      ).toEqual([{ user_id: "capacity-owner" }]);
      expect(
        store.database
          .prepare(
            `SELECT integer_value
             FROM sync_metadata
             WHERE metadata_key = 'last_generation'`,
          )
          .get(),
      ).toEqual({ integer_value: 1 });
    } finally {
      store.close();
    }
  });

  it("should reject quantity operations that exceed the authoritative holding bounds", () => {
    const store = new SqliteStore(":memory:");
    const added = testOperation();
    const overflow = testOperation({
      id: "operation-overflow",
      type: "holding.quantity-adjusted",
      payload: { delta: 100_000 },
    });

    try {
      const initial = syncOperations(store, "user-a", [added]);
      expect(() =>
        store.sync(
          "user-a",
          {
            generation: initial.generation,
            operations: [overflow],
          },
          SYNC_OPTIONS,
        ),
      ).toThrow(SyncOperationInvalidError);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      store.close();
    }
  });

  it("should reject updates and removals for unknown holdings", () => {
    const store = new SqliteStore(":memory:");
    const bootstrap = store.sync(
      "user-a",
      { generation: null, operations: [] },
      SYNC_OPTIONS,
    );
    const unknownUpdate = testOperation({
      id: "operation-update-unknown",
      type: "holding.updated",
      holdingId: "holding-unknown",
      payload: { note: "unknown" },
    });
    const unknownRemoval = testOperation({
      id: "operation-remove-unknown",
      type: "holding.removed",
      holdingId: "holding-unknown",
      payload: {},
    });

    try {
      for (const operation of [unknownUpdate, unknownRemoval]) {
        expect(() =>
          store.sync(
            "user-a",
            {
              generation: bootstrap.generation,
              operations: [operation],
            },
            SYNC_OPTIONS,
          ),
        ).toThrow(SyncOperationInvalidError);
      }
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("should never reuse a holding identifier after removal", () => {
    const store = new SqliteStore(":memory:");
    const added = testOperation();
    const removed = testOperation({
      id: "operation-remove",
      type: "holding.removed",
      payload: {},
    });
    const readded = testOperation({ id: "operation-readd" });

    try {
      const initial = syncOperations(store, "user-a", [added, removed]);
      expect(() =>
        store.sync(
          "user-a",
          {
            generation: initial.generation,
            operations: [readded],
          },
          SYNC_OPTIONS,
        ),
      ).toThrow(SyncOperationInvalidError);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      store.close();
    }
  });

  it("should store a rich holding add below 700 account bytes and rehydrate the client contract", () => {
    const store = new SqliteStore(":memory:");
    const operation = richAddedOperation();

    try {
      const response = syncOperations(store, "user-a", [operation], {
        retentionDays: 1_826,
        now: FIXED_NOW,
      });
      const stored = store.database
        .prepare(
          `SELECT operation_json, stored_bytes, card_snapshot_id, quote_snapshot_id
           FROM sync_events
           WHERE user_id = ?`,
        )
        .get("user-a") as {
        operation_json: string;
        stored_bytes: number;
        card_snapshot_id: number | null;
        quote_snapshot_id: number | null;
      };
      const holding = (
        response.events[0].payload as {
          holding: Record<string, unknown>;
        }
      ).holding;

      expect(stored.stored_bytes).toBeLessThanOrEqual(700);
      expect(stored.operation_json).not.toContain('"card"');
      expect(stored.operation_json).not.toContain('"quote"');
      expect(stored.card_snapshot_id).not.toBeNull();
      expect(stored.quote_snapshot_id).not.toBeNull();
      expect(response.events[0].payload).toEqual(operation.payload);
      expect(
        store.sync(
          "user-a",
          {
            cursor: response.cursor,
            generation: response.generation,
            operations: [{ ...operation, syncedAt: FIXED_NOW.toISOString() }],
          },
          SYNC_OPTIONS,
        ).acceptedOperationIds,
      ).toEqual([operation.id]);
      expect(holding).toMatchObject({
        id: operation.holdingId,
        cardId: "pokemon-card:en:base1:58:pikachu",
        quantity: 1,
        finish: "reverse",
        condition: "near-mint",
        card: {
          id: "pokemon-card:en:base1:58:pikachu",
          name: "Pikachu",
          quote: { marketPrice: 22, currency: "EUR" },
          quotes: [{ marketPrice: 22, currency: "EUR" }],
        },
        quote: { marketPrice: 22, currency: "EUR" },
      });
    } finally {
      store.close();
    }
  });

  it("should keep measured SQLite growth below 700 bytes per rich holding add", () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "cardscope-sync-density-"),
    );
    const filename = path.join(temporaryDirectory, "density.sqlite");
    const store = new SqliteStore(filename);
    const pageSize = Number(
      (
        store.database.prepare("PRAGMA page_size").get() as {
          page_size: number;
        }
      ).page_size,
    );
    const usedBytes = () => {
      const pages = Number(
        (
          store.database.prepare("PRAGMA page_count").get() as {
            page_count: number;
          }
        ).page_count,
      );
      const free = Number(
        (
          store.database.prepare("PRAGMA freelist_count").get() as {
            freelist_count: number;
          }
        ).freelist_count,
      );
      return (pages - free) * pageSize;
    };

    try {
      const before = usedBytes();
      for (let batch = 0; batch < 10; batch += 1) {
        const operations = Array.from({ length: 100 }, (_, offset) =>
          richAddedOperation(
            `density-${String(batch * 100 + offset).padStart(4, "0")}`,
          ),
        );
        syncOperations(store, "density-user", operations, {
          retentionDays: 1_826,
          maxPullBytes: 1,
          now: FIXED_NOW,
        });
      }
      store.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      const bytesPerAdd = (usedBytes() - before) / 1_000;

      expect(bytesPerAdd).toBeLessThanOrEqual(700);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_shared_objects")
          .get(),
      ).toMatchObject({ count: 2 });
    } finally {
      store.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("should deduplicate card and quote snapshots across accounts", () => {
    const store = new SqliteStore(":memory:");
    const operation = richAddedOperation();

    try {
      syncOperations(store, "user-a", [operation], {
        retentionDays: 1_826,
        now: FIXED_NOW,
      });
      syncOperations(store, "user-b", [operation], {
        retentionDays: 1_826,
        now: FIXED_NOW,
      });

      expect(
        store.database
          .prepare(
            `SELECT object_kind, COUNT(*) AS count
             FROM sync_shared_objects
             GROUP BY object_kind
             ORDER BY object_kind`,
          )
          .all(),
      ).toEqual([
        { object_kind: "card", count: 1 },
        { object_kind: "quote", count: 1 },
      ]);
      expect(
        store.database
          .prepare(
            `SELECT COUNT(DISTINCT card_snapshot_id) AS cards,
                    COUNT(DISTINCT quote_snapshot_id) AS quotes
             FROM sync_events`,
          )
          .get(),
      ).toMatchObject({ cards: 1, quotes: 1 });

      store.deleteAccount("user-a", SYNC_OPTIONS);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_shared_objects")
          .get(),
      ).toMatchObject({ count: 2 });
      store.deleteAccount("user-b", SYNC_OPTIONS);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_shared_objects")
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("should include distinct shared-object bytes in the account quota", () => {
    const store = new SqliteStore(":memory:");
    const operation = largeSharedObjectOperation("quota-large-object");

    try {
      expect(() =>
        syncOperations(store, "quota-user", [operation], {
          retentionDays: 1_826,
          maxAccountBytes: 1_000,
          now: FIXED_NOW,
        }),
      ).toThrow(SyncStorageLimitError);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_accounts")
          .get(),
      ).toMatchObject({ count: 1 });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_shared_objects")
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("should charge one shared object once per account instead of once per event", () => {
    const store = new SqliteStore(":memory:");
    const first = largeSharedObjectOperation("shared-quota-a");
    const second = largeSharedObjectOperation("shared-quota-b");

    try {
      const response = syncOperations(store, "quota-user", [first, second], {
        retentionDays: 1_826,
        maxAccountBytes: 8_000,
        now: FIXED_NOW,
      });

      expect(response.acceptedOperationIds).toEqual([first.id, second.id]);
      const bytes = store.database
        .prepare(
          `SELECT
             (SELECT SUM(stored_bytes) FROM sync_events) AS event_bytes,
             (SELECT SUM(length(CAST(payload_json AS BLOB)))
              FROM sync_shared_objects) AS shared_payload_bytes`,
        )
        .get() as {
        event_bytes: number;
        shared_payload_bytes: number;
      };
      expect(bytes.event_bytes + bytes.shared_payload_bytes).toBeLessThan(
        8_000,
      );
      expect(
        bytes.event_bytes + bytes.shared_payload_bytes * 2,
      ).toBeGreaterThan(8_000);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_shared_objects")
          .get(),
      ).toMatchObject({ count: 2 });
    } finally {
      store.close();
    }
  });

  it("should charge a referencing account when the object already exists globally", () => {
    const store = new SqliteStore(":memory:");
    const operation = largeSharedObjectOperation("globally-shared-object");

    try {
      syncOperations(store, "first-user", [operation], {
        retentionDays: 1_826,
        maxAccountBytes: 64 * 1024,
        now: FIXED_NOW,
      });

      expect(() =>
        syncOperations(store, "second-user", [operation], {
          retentionDays: 1_826,
          maxAccountBytes: 1_000,
          now: FIXED_NOW,
        }),
      ).toThrow(SyncStorageLimitError);
      expect(
        store.database
          .prepare("SELECT user_id FROM sync_accounts ORDER BY user_id")
          .all(),
      ).toEqual([{ user_id: "first-user" }, { user_id: "second-user" }]);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_shared_objects")
          .get(),
      ).toMatchObject({ count: 2 });
    } finally {
      store.close();
    }
  });

  it("should compact and rehydrate quote update events", () => {
    const store = new SqliteStore(":memory:");
    const quote = {
      source: "tcgdex",
      market: "cardmarket",
      currency: "EUR",
      low: 20,
      marketPrice: 24,
      high: 28,
      observedAt: FIXED_NOW.toISOString(),
      staleAfter: "2026-07-23T12:00:00.000Z",
    };
    const operation = testOperation({
      id: "operation-quote-update",
      type: "holding.updated",
      payload: { quote, note: "repriced" },
    });

    try {
      const response = syncOperations(
        store,
        "user-a",
        [testOperation(), operation],
        {
          retentionDays: 1_826,
          now: FIXED_NOW,
        },
      );
      const stored = store.database
        .prepare(
          `SELECT operation_json, quote_snapshot_id
           FROM sync_events
           WHERE operation_id = ?`,
        )
        .get(operation.id) as {
        operation_json: string;
        quote_snapshot_id: number | null;
      };

      expect(stored.operation_json).toBe('{"note":"repriced"}');
      expect(stored.quote_snapshot_id).not.toBeNull();
      expect(response.events[1].payload).toEqual({
        note: "repriced",
        quote,
      });
    } finally {
      store.close();
    }
  });

  it("should migrate legacy full events to compact storage without changing pulls", () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "cardscope-sync-migration-"),
    );
    const filename = path.join(temporaryDirectory, "legacy.sqlite");
    const legacy = new DatabaseSync(filename);
    const operation = richAddedOperation();
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sync_accounts (
        user_id TEXT PRIMARY KEY,
        retention_until TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE sync_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        holding_id TEXT NOT NULL,
        operation_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE (user_id, operation_id),
        FOREIGN KEY (user_id) REFERENCES sync_accounts (user_id) ON DELETE CASCADE
      ) STRICT;
    `);
    legacy
      .prepare(
        `INSERT INTO sync_accounts (user_id, retention_until, created_at)
         VALUES (?, ?, ?)`,
      )
      .run("legacy-user", "2031-07-22T12:00:00.000Z", FIXED_NOW.toISOString());
    legacy
      .prepare(
        `INSERT INTO sync_events (
           user_id, operation_id, operation_type, holding_id, operation_json,
           occurred_at, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-user",
        operation.id,
        operation.type,
        operation.holdingId,
        JSON.stringify(operation),
        operation.occurredAt,
        FIXED_NOW.toISOString(),
      );
    legacy.close();

    const store = new SqliteStore(filename);
    try {
      const migrated = store.database
        .prepare(
          `SELECT storage_version, stored_bytes, operation_json
           FROM sync_events`,
        )
        .get() as {
        storage_version: number;
        stored_bytes: number;
        operation_json: string;
      };
      const migratedAccount = store.database
        .prepare(
          `SELECT generation
           FROM sync_accounts
           WHERE user_id = ?`,
        )
        .get("legacy-user");
      const response = store.sync(
        "legacy-user",
        { cursor: null, generation: null, operations: [] },
        { retentionDays: 1_826, now: FIXED_NOW },
      );

      expect(migrated.storage_version).toBe(1);
      expect(migratedAccount).toEqual({ generation: 1 });
      expect(response.generation).toBe("1");
      expect(migrated.stored_bytes).toBeLessThanOrEqual(700);
      expect(migrated.operation_json).not.toContain('"card"');
      expect(response.events[0]).toMatchObject({
        id: operation.id,
        deviceId: operation.deviceId,
        type: "holding.added",
        payload: {
          holding: {
            card: { id: "pokemon-card:en:base1:58:pikachu" },
            quote: { marketPrice: 22 },
          },
        },
      });
    } finally {
      store.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("should page events without losing the cursor when there are more results", () => {
    const store = new SqliteStore(":memory:");
    const firstOperation = distinctAddedOperation("operation-1", "holding-1");
    const secondOperation = distinctAddedOperation("operation-2", "holding-2");

    try {
      const firstPage = syncOperations(
        store,
        "user-a",
        [firstOperation, secondOperation],
        { retentionDays: 1_826, eventLimit: 1, now: FIXED_NOW },
      );
      const secondPage = store.sync(
        "user-a",
        {
          cursor: firstPage.cursor,
          generation: firstPage.generation,
          operations: [],
        },
        { retentionDays: 1_826, eventLimit: 1, now: FIXED_NOW },
      );

      expect(firstPage.events.map((event) => event.id)).toEqual([
        "operation-1",
      ]);
      expect(firstPage.hasMore).toBe(true);
      expect(secondPage.events.map((event) => event.id)).toEqual([
        "operation-2",
      ]);
      expect(secondPage.hasMore).toBe(false);
    } finally {
      store.close();
    }
  });

  it("should reject oversized operations before starting account storage", () => {
    const store = new SqliteStore(":memory:");
    const operation = testOperation({
      payload: { holding: { notes: "x".repeat(2_000) } },
    });

    try {
      expect(() =>
        syncOperations(store, "user-a", [operation], {
          retentionDays: 1_826,
          maxOperationBytes: 512,
          now: FIXED_NOW,
        }),
      ).toThrow(SyncOperationTooLargeError);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_accounts")
          .get(),
      ).toMatchObject({ count: 1 });
    } finally {
      store.close();
    }
  });

  it("should preserve prior events when the account byte quota rejects a new operation", () => {
    const store = new SqliteStore(":memory:");
    const first = distinctAddedOperation("operation-1", "holding-1");
    const second = distinctAddedOperation("operation-2", "holding-2");

    try {
      const initial = syncOperations(store, "user-a", [first], {
        retentionDays: 1_826,
        maxAccountBytes: 64 * 1024,
        now: FIXED_NOW,
      });
      const firstBytes = Number(
        (
          store.database
            .prepare(
              `SELECT stored_bytes
               FROM sync_events
               WHERE operation_id = ?`,
            )
            .get(first.id) as { stored_bytes: number }
        ).stored_bytes,
      );
      expect(() =>
        store.sync(
          "user-a",
          { generation: initial.generation, operations: [second] },
          {
            retentionDays: 1_826,
            maxAccountBytes: firstBytes + 10,
            now: FIXED_NOW,
          },
        ),
      ).toThrow(SyncStorageLimitError);
      expect(
        store.database.prepare("SELECT operation_id FROM sync_events").all(),
      ).toEqual([{ operation_id: "operation-1" }]);
    } finally {
      store.close();
    }
  });

  it("should keep a sync pull response below its byte budget", () => {
    const store = new SqliteStore(":memory:");
    const operations = Array.from({ length: 5 }, (_, index) => {
      const operation = testOperation();
      const holdingId = `holding-${index}`;
      return testOperation({
        id: `operation-${index}`,
        holdingId,
        payload: {
          holding: {
            ...(
              operation.payload as {
                holding: Record<string, unknown>;
              }
            ).holding,
            id: holdingId,
            note: "x".repeat(1_000),
          },
        },
      });
    });

    try {
      const response = syncOperations(store, "user-a", operations, {
        retentionDays: 1_826,
        maxOperationBytes: 2_048,
        maxPullBytes: 3_000,
        now: FIXED_NOW,
      });

      expect(
        Buffer.byteLength(JSON.stringify(response), "utf8"),
      ).toBeLessThanOrEqual(3_000);
      expect(response.events.length).toBeGreaterThan(0);
      expect(response.events.length).toBeLessThan(operations.length);
      expect(response.hasMore).toBe(true);
    } finally {
      store.close();
    }
  });

  it("should transactionally delete events and reject stale generations", () => {
    const store = new SqliteStore(":memory:");
    const operation = testOperation();
    const staleOperation = richAddedOperation("operation-stale");

    try {
      const userA = syncOperations(store, "user-a", [operation], {
        retentionDays: 1_826,
        now: FIXED_NOW,
      });
      const userB = syncOperations(store, "user-b", [operation], {
        retentionDays: 1_826,
        now: FIXED_NOW,
      });

      const firstDeletion = store.deleteAccount("user-a", SYNC_OPTIONS);
      expect(firstDeletion).toEqual({
        accountExisted: true,
        generation: "3",
      });

      let mismatch: unknown;
      try {
        store.sync(
          "user-a",
          { generation: userA.generation, operations: [staleOperation] },
          SYNC_OPTIONS,
        );
      } catch (error) {
        mismatch = error;
      }
      expect(mismatch).toBeInstanceOf(SyncGenerationMismatchError);
      expect((mismatch as SyncGenerationMismatchError).currentGeneration).toBe(
        "3",
      );
      expect(() =>
        store.sync(
          "user-a",
          { generation: null, operations: [staleOperation] },
          SYNC_OPTIONS,
        ),
      ).toThrow(/empty bootstrap/i);

      const current = store.sync(
        "user-a",
        { generation: firstDeletion.generation, operations: [] },
        SYNC_OPTIONS,
      );
      expect(current.generation).toBe("3");
      expect(current.events).toEqual([]);

      const secondDeletion = store.deleteAccount("user-a", SYNC_OPTIONS);
      expect(secondDeletion).toEqual({
        accountExisted: true,
        generation: "4",
      });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_accounts")
          .get(),
      ).toMatchObject({ count: 2 });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toMatchObject({ count: 1 });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_shared_objects")
          .get(),
      ).toMatchObject({ count: 1 });
      expect(
        store.database
          .prepare(
            `SELECT user_id, generation
             FROM sync_accounts
             ORDER BY user_id`,
          )
          .all(),
      ).toEqual([
        { user_id: "user-a", generation: 4 },
        { user_id: "user-b", generation: Number(userB.generation) },
      ]);
    } finally {
      store.close();
    }
  });

  it("should create a generation-two tombstone when deleting a missing account", () => {
    const store = new SqliteStore(":memory:");

    try {
      expect(store.deleteAccount("missing-user", SYNC_OPTIONS)).toEqual({
        accountExisted: false,
        generation: "2",
      });
      expect(
        store.database
          .prepare(
            `SELECT generation, retention_until
             FROM sync_accounts
             WHERE user_id = ?`,
          )
          .get("missing-user"),
      ).toEqual({
        generation: 2,
        retention_until: "2031-07-22T12:00:00.000Z",
      });
      expect(() =>
        store.sync(
          "missing-user",
          { generation: "1", operations: [testOperation()] },
          SYNC_OPTIONS,
        ),
      ).toThrow(SyncGenerationMismatchError);
    } finally {
      store.close();
    }
  });

  it("should leave data intact when generation can no longer increment safely", () => {
    const store = new SqliteStore(":memory:");

    try {
      syncOperations(
        store,
        "max-generation-user",
        [testOperation()],
        SYNC_OPTIONS,
      );
      store.database
        .prepare(
          `UPDATE sync_accounts
           SET generation = ?
           WHERE user_id = ?`,
        )
        .run(Number.MAX_SAFE_INTEGER, "max-generation-user");

      expect(() =>
        store.deleteAccount("max-generation-user", SYNC_OPTIONS),
      ).toThrow(/generation/i);
      expect(
        store.database
          .prepare(
            `SELECT generation,
                    (SELECT COUNT(*) FROM sync_events) AS event_count
             FROM sync_accounts
             WHERE user_id = ?`,
          )
          .get("max-generation-user"),
      ).toEqual({
        generation: Number.MAX_SAFE_INTEGER,
        event_count: 1,
      });
    } finally {
      store.close();
    }
  });

  it("should delete more than ten thousand orphaned objects with an account", () => {
    const store = new SqliteStore(":memory:");

    try {
      seedReferencedSharedObjects(
        store,
        "large-account",
        10_001,
        "2031-07-22T12:00:00.000Z",
      );

      expect(store.deleteAccount("large-account", SYNC_OPTIONS)).toEqual({
        accountExisted: true,
        generation: "2",
      });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_shared_objects")
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("should prune expired accounts and events in bounded batches", () => {
    const store = new SqliteStore(":memory:");
    const operation = testOperation();
    const afterTwoDays = new Date(FIXED_NOW.getTime() + 2 * 86_400_000);

    try {
      syncOperations(store, "expired-a", [operation], {
        retentionDays: 1,
        now: FIXED_NOW,
      });
      syncOperations(store, "expired-b", [operation], {
        retentionDays: 1,
        now: FIXED_NOW,
      });
      syncOperations(store, "active-user", [operation], {
        retentionDays: 10,
        now: FIXED_NOW,
      });

      expect(store.pruneExpiredAccounts(afterTwoDays, 1)).toBe(1);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_accounts")
          .get(),
      ).toMatchObject({ count: 2 });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toMatchObject({ count: 2 });

      expect(store.pruneExpiredAccounts(afterTwoDays, 1)).toBe(1);
      expect(store.pruneExpiredAccounts(afterTwoDays, 1)).toBe(0);
      expect(
        store.database.prepare("SELECT user_id FROM sync_accounts").all(),
      ).toEqual([{ user_id: "active-user" }]);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toMatchObject({ count: 1 });
    } finally {
      store.close();
    }
  });

  it("should allocate a new epoch after expiry and reject the old offline queue", () => {
    const store = new SqliteStore(":memory:");
    const afterTwoDays = new Date(FIXED_NOW.getTime() + 2 * 86_400_000);
    const oldOperation = testOperation({ id: "operation-before-expiry" });
    const staleOperation = testOperation({ id: "operation-from-stale-device" });

    try {
      const initial = syncOperations(store, "expired-user", [oldOperation], {
        retentionDays: 1,
        now: FIXED_NOW,
      });
      expect(store.pruneExpiredAccounts(afterTwoDays, 1)).toBe(1);

      let mismatch: unknown;
      try {
        store.sync(
          "expired-user",
          {
            generation: initial.generation,
            operations: [staleOperation],
          },
          { retentionDays: 1_826, now: afterTwoDays },
        );
      } catch (error) {
        mismatch = error;
      }

      expect(mismatch).toBeInstanceOf(SyncGenerationMismatchError);
      const currentGeneration = Number(
        (mismatch as SyncGenerationMismatchError).currentGeneration,
      );
      expect(currentGeneration).toBeGreaterThan(Number(initial.generation));
      expect(
        store.database
          .prepare(
            `SELECT generation,
                    (SELECT COUNT(*) FROM sync_events) AS event_count
             FROM sync_accounts
             WHERE user_id = ?`,
          )
          .get("expired-user"),
      ).toEqual({ generation: currentGeneration, event_count: 0 });

      const bootstrap = store.sync(
        "expired-user",
        { generation: null, operations: [] },
        { retentionDays: 1_826, now: afterTwoDays },
      );
      expect(bootstrap).toMatchObject({
        generation: String(currentGeneration),
        events: [],
      });
    } finally {
      store.close();
    }
  });

  it("should expire the subject atomically even behind the bounded prune backlog", () => {
    const store = new SqliteStore(":memory:");
    const initialOptions = {
      retentionDays: 1,
      maxAccounts: 100,
      now: FIXED_NOW,
    } as const;
    const afterTwoDays = new Date(FIXED_NOW.getTime() + 2 * 86_400_000);
    const staleOptions = {
      ...initialOptions,
      now: afterTwoDays,
    };
    const targetUser = "expired-backlog-29";
    let targetGeneration = "";
    let targetHoldingId = "";

    try {
      for (let index = 0; index < 30; index += 1) {
        const userId = `expired-backlog-${String(index).padStart(2, "0")}`;
        const operation = testOperation();
        const holdingId = `holding-backlog-${index}`;
        const added = testOperation({
          id: `operation-backlog-${index}`,
          holdingId,
          payload: {
            holding: {
              ...(
                operation.payload as {
                  holding: Record<string, unknown>;
                }
              ).holding,
              id: holdingId,
            },
          },
        });
        const initial = syncOperations(store, userId, [added], initialOptions);
        if (userId === targetUser) {
          targetGeneration = initial.generation;
          targetHoldingId = holdingId;
        }
      }

      let mismatch: unknown;
      try {
        store.sync(
          targetUser,
          {
            generation: targetGeneration,
            operations: [
              testOperation({
                id: "operation-after-expiry",
                type: "holding.quantity-adjusted",
                holdingId: targetHoldingId,
                payload: { delta: 1 },
              }),
            ],
          },
          staleOptions,
        );
      } catch (error) {
        mismatch = error;
      }

      expect(mismatch).toBeInstanceOf(SyncGenerationMismatchError);
      const currentGeneration = (mismatch as SyncGenerationMismatchError)
        .currentGeneration;
      expect(Number(currentGeneration)).toBeGreaterThan(
        Number(targetGeneration),
      );
      expect(
        store.database
          .prepare(
            `SELECT generation, retention_until
             FROM sync_accounts
             WHERE user_id = ?`,
          )
          .get(targetUser),
      ).toEqual({
        generation: Number(currentGeneration),
        retention_until: new Date(
          afterTwoDays.getTime() + 86_400_000,
        ).toISOString(),
      });
      expect(
        store.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM sync_events
             WHERE user_id = ?`,
          )
          .get(targetUser),
      ).toEqual({ count: 0 });
      expect(
        store.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM sync_events
             WHERE operation_id = ?`,
          )
          .get("operation-after-expiry"),
      ).toEqual({ count: 0 });

      const bootstrap = store.sync(
        targetUser,
        { generation: null, operations: [] },
        staleOptions,
      );
      expect(bootstrap).toMatchObject({
        generation: currentGeneration,
        events: [],
      });
    } finally {
      store.close();
    }
  });

  it("should never reuse an expired epoch when a fresh device bootstraps first", () => {
    const store = new SqliteStore(":memory:");
    const afterTwoDays = new Date(FIXED_NOW.getTime() + 2 * 86_400_000);

    try {
      const initial = syncOperations(
        store,
        "fresh-after-expiry",
        [testOperation()],
        { retentionDays: 1, now: FIXED_NOW },
      );
      expect(store.pruneExpiredAccounts(afterTwoDays, 1)).toBe(1);

      const fresh = store.sync(
        "fresh-after-expiry",
        { generation: null, operations: [] },
        { retentionDays: 1_826, now: afterTwoDays },
      );
      expect(Number(fresh.generation)).toBeGreaterThan(
        Number(initial.generation),
      );
      expect(() =>
        store.sync(
          "fresh-after-expiry",
          {
            generation: initial.generation,
            operations: [testOperation({ id: "stale-after-fresh-bootstrap" })],
          },
          { retentionDays: 1_826, now: afterTwoDays },
        ),
      ).toThrow(SyncGenerationMismatchError);
    } finally {
      store.close();
    }
  });

  it("should leave no orphaned object after pruning a large expired account", () => {
    const store = new SqliteStore(":memory:");
    const afterTwoDays = new Date(FIXED_NOW.getTime() + 2 * 86_400_000);

    try {
      seedReferencedSharedObjects(
        store,
        "large-expired-account",
        11_001,
        new Date(FIXED_NOW.getTime() + 86_400_000).toISOString(),
      );

      expect(store.pruneExpiredAccounts(afterTwoDays, 1)).toBe(1);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_shared_objects")
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      store.close();
    }
  });
});
