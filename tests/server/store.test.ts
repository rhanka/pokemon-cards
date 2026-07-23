import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  SqliteStore,
  SyncOperationTooLargeError,
  SyncStorageLimitError,
} from "../../server/store.js";
import { FIXED_NOW, testOperation } from "./fixtures.js";

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

  it("should append sync operations once per user and resume from an opaque cursor", () => {
    const store = new SqliteStore(":memory:");
    const operation = testOperation();

    try {
      const first = store.sync(
        "user-a",
        { cursor: null, operations: [operation] },
        { retentionDays: 1_826, now: FIXED_NOW },
      );
      const duplicate = store.sync(
        "user-a",
        { cursor: first.cursor, operations: [operation] },
        {
          retentionDays: 1_826,
          now: new Date(FIXED_NOW.getTime() + 86_400_000),
        },
      );
      const sameIdForAnotherUser = store.sync(
        "user-b",
        { cursor: null, operations: [operation] },
        { retentionDays: 1_826, now: FIXED_NOW },
      );

      expect(first.acceptedOperationIds).toEqual([operation.id]);
      expect(first.events).toHaveLength(1);
      expect(first.events[0]).toMatchObject({
        id: operation.id,
        sequence: 1,
        receivedAt: FIXED_NOW.toISOString(),
      });
      expect(first.retentionUntil).toBe("2031-07-22T12:00:00.000Z");
      expect(duplicate.acceptedOperationIds).toEqual([]);
      expect(duplicate.events).toEqual([]);
      // Retention is anchored on first activation, not silently renewed on every sync.
      expect(duplicate.retentionUntil).toBe(first.retentionUntil);
      expect(sameIdForAnotherUser.acceptedOperationIds).toEqual([operation.id]);
      expect(sameIdForAnotherUser.events).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("should page events without losing the cursor when there are more results", () => {
    const store = new SqliteStore(":memory:");
    const firstOperation = testOperation({ id: "operation-1" });
    const secondOperation = testOperation({ id: "operation-2" });

    try {
      const firstPage = store.sync(
        "user-a",
        { operations: [firstOperation, secondOperation] },
        { retentionDays: 1_826, eventLimit: 1, now: FIXED_NOW },
      );
      const secondPage = store.sync(
        "user-a",
        { cursor: firstPage.cursor, operations: [] },
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
        store.sync(
          "user-a",
          { operations: [operation] },
          { retentionDays: 1_826, maxOperationBytes: 512, now: FIXED_NOW },
        ),
      ).toThrow(SyncOperationTooLargeError);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_accounts")
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("should preserve prior events when the account byte quota rejects a new operation", () => {
    const store = new SqliteStore(":memory:");
    const first = testOperation({ id: "operation-1" });
    const second = testOperation({ id: "operation-2" });
    const firstBytes = Buffer.byteLength(JSON.stringify(first), "utf8");

    try {
      store.sync(
        "user-a",
        { operations: [first] },
        {
          retentionDays: 1_826,
          maxAccountBytes: firstBytes + 10,
          now: FIXED_NOW,
        },
      );
      expect(() =>
        store.sync(
          "user-a",
          { operations: [second] },
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
    const operations = Array.from({ length: 5 }, (_, index) =>
      testOperation({
        id: `operation-${index}`,
        type: "holding.updated",
        payload: { notes: "x".repeat(1_000), index },
      }),
    );

    try {
      const response = store.sync(
        "user-a",
        { operations },
        {
          retentionDays: 1_826,
          maxOperationBytes: 2_048,
          maxPullBytes: 3_000,
          now: FIXED_NOW,
        },
      );

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

  it("should transactionally delete an account and its event history", () => {
    const store = new SqliteStore(":memory:");
    const operation = testOperation();

    try {
      store.sync(
        "user-a",
        { operations: [operation] },
        { retentionDays: 1_826, now: FIXED_NOW },
      );
      store.sync(
        "user-b",
        { operations: [operation] },
        { retentionDays: 1_826, now: FIXED_NOW },
      );

      expect(store.deleteAccount("user-a")).toBe(true);
      expect(store.deleteAccount("user-a")).toBe(false);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_accounts")
          .get(),
      ).toMatchObject({ count: 1 });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toMatchObject({ count: 1 });
      expect(
        store.database
          .prepare("SELECT user_id FROM sync_accounts ORDER BY user_id")
          .all(),
      ).toEqual([{ user_id: "user-b" }]);
    } finally {
      store.close();
    }
  });

  it("should prune expired accounts and events in bounded batches", () => {
    const store = new SqliteStore(":memory:");
    const operation = testOperation();
    const afterTwoDays = new Date(FIXED_NOW.getTime() + 2 * 86_400_000);

    try {
      store.sync(
        "expired-a",
        { operations: [operation] },
        { retentionDays: 1, now: FIXED_NOW },
      );
      store.sync(
        "expired-b",
        { operations: [operation] },
        { retentionDays: 1, now: FIXED_NOW },
      );
      store.sync(
        "active-user",
        { operations: [operation] },
        { retentionDays: 10, now: FIXED_NOW },
      );

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
});
