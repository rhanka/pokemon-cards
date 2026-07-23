import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { CollectionRepository, isCollectionEvent } from "../../src/lib/db";
import { eventsFromJson, eventsToJson } from "../../src/lib/import-export";
import { formatMoney } from "../../src/lib/i18n";
import { collectionTotals } from "../../src/lib/value";
import type { CollectionEvent, Holding } from "../../src/lib/types";

const opened: CollectionRepository[] = [];

function repository(): CollectionRepository {
  const instance = new CollectionRepository(
    `cardscope-test-${crypto.randomUUID()}`,
  );
  opened.push(instance);
  return instance;
}

const holding: Holding = {
  id: "holding-1",
  cardId: "sv3pt5-025",
  card: {
    id: "sv3pt5-025",
    name: "Pikachu",
    printedNumber: "025",
    setName: "151",
  },
  quantity: 1,
  finish: "normal",
  condition: "near-mint",
  addedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function addedEvent(id = "event-1", value = holding): CollectionEvent {
  return {
    id,
    type: "holding.added",
    holdingId: value.id,
    occurredAt: value.addedAt,
    deviceId: "device-1",
    payload: { holding: value },
  };
}

function currentSnapshot(repo: CollectionRepository) {
  let current = { holdings: [], activities: [], eventCount: 0 } as ReturnType<
    typeof import("../../src/lib/collection").replayCollection
  >;
  const unsubscribe = repo.snapshot.subscribe((value) => (current = value));
  unsubscribe();
  return current;
}

afterEach(() => {
  for (const instance of opened.splice(0)) instance.close();
});

describe("collection event runtime integrity", () => {
  it("should preserve real acquisition cost by keeping differently priced copies separate", async () => {
    const repo = repository();
    await repo.init();
    const card = { id: "card-1", name: "Pikachu" };
    await repo.add({
      card,
      finish: "normal",
      condition: "near-mint",
      unitCost: { amount: 1, currency: "USD" },
    });
    await repo.add({
      card,
      finish: "normal",
      condition: "near-mint",
      unitCost: { amount: 100, currency: "USD" },
    });

    const snapshot = currentSnapshot(repo);
    expect(snapshot.holdings).toHaveLength(2);
    expect(collectionTotals(snapshot.holdings).currencies).toContainEqual(
      expect.objectContaining({ currency: "USD", cost: 101 }),
    );
  });

  it("should validate locally appended events before persistence", async () => {
    const repo = repository();
    await repo.init();

    await expect(
      repo.add({
        card: { id: "card-1", name: "Pikachu" },
        finish: "normal",
        condition: "near-mint",
        unitCost: { amount: -1, currency: "USD" },
      }),
    ).rejects.toThrow();
    expect(await repo.allEvents()).toEqual([]);
  });

  it("should bound local and cumulative holding quantities", async () => {
    const repo = repository();
    await repo.init();
    const card = { id: "card-quantity", name: "Pikachu" };

    await expect(
      repo.add({
        card,
        finish: "normal",
        condition: "good",
        quantity: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toThrow(/quantity/i);
    await repo.add({
      card,
      finish: "normal",
      condition: "good",
      quantity: 100_000,
    });
    const holdingId = currentSnapshot(repo).holdings[0].id;
    await expect(repo.adjustQuantity(holdingId, 1)).rejects.toThrow(
      /quantity/i,
    );
    expect(currentSnapshot(repo).holdings[0].quantity).toBe(100_000);
  });

  it("should validate an entire CSV holding batch before any row persists", async () => {
    const repo = repository();
    await repo.init();

    await expect(
      repo.importHoldings([
        {
          card: { id: "valid", name: "Valid" },
          finish: "normal",
          condition: "good",
        },
        {
          card: { id: "invalid", name: "Invalid" },
          finish: "normal",
          condition: "good",
          unitCost: { amount: 2, currency: "ZZZ" },
        },
      ]),
    ).rejects.toThrow();
    expect(await repo.allEvents()).toEqual([]);
  });

  it("should never throw while formatting an invalid external currency", () => {
    expect(() => formatMoney("en", 12.5, "NOT_A_CURRENCY")).not.toThrow();
    expect(formatMoney("en", 12.5, "NOT_A_CURRENCY")).toContain("12.50");
  });

  it("should reject malformed nested holding data instead of accepting a shallow event shape", () => {
    const malformed = {
      ...addedEvent(),
      payload: { holding: { ...holding, quantity: "1000" } },
    };
    const envelope = JSON.stringify({
      format: "cardscope-collection",
      version: 1,
      exportedAt: "2026-07-22T00:00:00.000Z",
      events: [malformed],
    });

    expect(isCollectionEvent(malformed)).toBe(false);
    expect(() => eventsFromJson(envelope)).toThrow(
      "Invalid collection event at index 0",
    );
  });

  it("should validate and replay the complete import before writing any event", async () => {
    const repo = repository();
    await repo.init();
    await repo.importEvents([addedEvent()], {
      source: "restore",
      mode: "merge",
    });
    const secondHolding = { ...holding, id: "holding-2" };
    const malformed = {
      ...addedEvent("event-bad", secondHolding),
      payload: {
        holding: { ...secondHolding, card: { id: secondHolding.cardId } },
      },
    };

    await expect(
      repo.importEvents([addedEvent("event-2", secondHolding), malformed], {
        source: "restore",
        mode: "merge",
      }),
    ).rejects.toThrow("Invalid collection event at index 1");
    expect((await repo.allEvents()).map((event) => event.id)).toEqual([
      "event-1",
    ]);
  });

  it("should exclude acknowledgements from backups and reset them on JSON restore", async () => {
    const repo = repository();
    await repo.init();
    await repo.setSyncSubject("account-a");
    await repo.importEvents([addedEvent()], {
      source: "restore",
      mode: "merge",
    });
    await repo.markSynced("account-a", ["event-1"], "2026-07-22T00:00:00.000Z");
    await repo.setSyncCursor("account-a", "12");

    const backup = eventsToJson(await repo.allEvents());
    expect(backup).not.toContain("syncedAt");
    await repo.importEvents(eventsFromJson(backup), {
      source: "restore",
      mode: "merge",
    });

    expect(await repo.getSyncCursor("account-a")).toBeNull();
    expect(await repo.unsyncedEvents("account-a")).toHaveLength(1);
    expect((await repo.allEvents())[0].syncedAt).toBeUndefined();
  });

  it("should support explicit atomic merge and confirmed replace restore modes", async () => {
    const repo = repository();
    await repo.init();
    await repo.setSyncSubject("account-a");
    await repo.importEvents([addedEvent()], {
      source: "restore",
      mode: "merge",
    });
    const second = {
      ...holding,
      id: "holding-2",
      cardId: "card-2",
      card: { id: "card-2", name: "Second" },
    };
    await repo.importEvents([addedEvent("event-2", second)], {
      source: "restore",
      mode: "merge",
    });
    expect(
      currentSnapshot(repo)
        .holdings.map((item) => item.cardId)
        .sort(),
    ).toEqual(["card-2", holding.cardId].sort());

    await expect(
      repo.importEvents([addedEvent()], {
        source: "restore",
        mode: "replace",
        confirmed: false,
      } as unknown as Parameters<CollectionRepository["importEvents"]>[1]),
    ).rejects.toThrow(/confirmation/i);

    const malformed = {
      ...addedEvent("bad", second),
      payload: { holding: { ...second, quantity: -1 } },
    };
    await expect(
      repo.importEvents([malformed], {
        source: "restore",
        mode: "replace",
        confirmed: true,
      }),
    ).rejects.toThrow();
    expect(currentSnapshot(repo).holdings).toHaveLength(2);

    const replacement = {
      ...holding,
      id: "holding-replacement",
      cardId: "replacement",
      card: { id: "replacement", name: "Replacement" },
    };
    await repo.importEvents([addedEvent("event-replacement", replacement)], {
      source: "restore",
      mode: "replace",
      confirmed: true,
    });
    expect(currentSnapshot(repo).holdings.map((item) => item.cardId)).toEqual([
      "replacement",
    ]);
  });
});

describe("account-scoped synchronization state", () => {
  it("should migrate legacy events without ownership into the anonymous domain", async () => {
    const databaseName = `cardscope-legacy-${crypto.randomUUID()}`;
    const legacy = new Dexie(databaseName);
    legacy.version(1).stores({
      events: "&id, occurredAt, holdingId, type, syncedAt",
      meta: "&key",
    });
    await legacy.open();
    await legacy.table("events").add(addedEvent());
    legacy.close();

    const repo = new CollectionRepository(databaseName);
    opened.push(repo);
    await repo.init();
    expect(currentSnapshot(repo).holdings.map((item) => item.cardId)).toEqual([
      holding.cardId,
    ]);
    await repo.setSyncSubject("account-a");
    expect(currentSnapshot(repo).holdings).toEqual([]);
    expect(await repo.unsyncedEvents("account-a")).toEqual([]);
  });

  it("should isolate anonymous, account A, and account B snapshots, exports, and upload queues", async () => {
    const repo = repository();
    await repo.init();
    await repo.add({
      card: { id: "anon-card", name: "Anonymous" },
      finish: "normal",
      condition: "good",
    });
    expect(currentSnapshot(repo).holdings.map((item) => item.cardId)).toEqual([
      "anon-card",
    ]);
    const anonymousHoldingId = currentSnapshot(repo).holdings[0].id;

    await repo.setSyncSubject("account-a");
    expect(currentSnapshot(repo).holdings).toEqual([]);
    expect(await repo.allEvents()).toEqual([]);
    expect(await repo.unsyncedEvents("account-a")).toEqual([]);
    await repo.add({
      card: { id: "a-card", name: "Account A" },
      finish: "holo",
      condition: "good",
    });
    expect(currentSnapshot(repo).holdings.map((item) => item.cardId)).toEqual([
      "a-card",
    ]);
    expect(
      (await repo.unsyncedEvents("account-a")).map((event) => event.payload),
    ).toHaveLength(1);

    await repo.setSyncSubject(null);
    expect(currentSnapshot(repo).holdings.map((item) => item.cardId)).toEqual([
      "anon-card",
    ]);
    expect((await repo.allEvents()).map((event) => event.holdingId)).toEqual([
      anonymousHoldingId,
    ]);
    expect(await repo.unsyncedEvents("account-a")).toEqual([]);

    await repo.setSyncSubject("account-b");
    expect(currentSnapshot(repo).holdings).toEqual([]);
    expect(await repo.allEvents()).toEqual([]);
    await repo.add({
      card: { id: "b-card", name: "Account B" },
      finish: "normal",
      condition: "good",
    });

    await repo.setSyncSubject("account-a");
    expect(currentSnapshot(repo).holdings.map((item) => item.cardId)).toEqual([
      "a-card",
    ]);
    const replacement = {
      ...holding,
      id: "a-replacement-holding",
      cardId: "a-replacement",
      card: { id: "a-replacement", name: "A replacement" },
    };
    await repo.importEvents([addedEvent("a-replacement-event", replacement)], {
      source: "restore",
      mode: "replace",
      confirmed: true,
    });
    expect(currentSnapshot(repo).holdings.map((item) => item.cardId)).toEqual([
      "a-replacement",
    ]);
    await repo.setSyncSubject("account-b");
    expect(currentSnapshot(repo).holdings.map((item) => item.cardId)).toEqual([
      "b-card",
    ]);
  });

  it("should not expose one account events as unsynced uploads to another account", async () => {
    const repo = repository();
    await repo.init();
    expect(await repo.setSyncSubject("account-a")).toBe(false);
    await repo.importEvents([addedEvent()], {
      source: "restore",
      mode: "merge",
    });
    await repo.markSynced("account-a", ["event-1"]);
    await repo.setSyncCursor("account-a", "7");

    await repo.setSyncSubject(null);
    expect(await repo.setSyncSubject("account-b")).toBe(false);
    expect(await repo.unsyncedEvents("account-b")).toEqual([]);
    expect(await repo.getSyncCursor("account-b")).toBeNull();
    expect(await repo.getSyncCursor("account-a")).toBe("7");

    await expect(repo.adjustQuantity("holding-1", 1)).rejects.toThrow(
      /active collection domain/i,
    );
    expect(await repo.unsyncedEvents("account-b")).toEqual([]);

    await repo.add({
      card: { id: "base1-001", name: "Alakazam" },
      finish: "holo",
      condition: "good",
    });
    expect(await repo.unsyncedEvents("account-b")).toHaveLength(1);
    await repo.setSyncSubject("account-a");
    expect(await repo.unsyncedEvents("account-a")).toEqual([]);
  });

  it("should reset deletion state for a deliberate same-account reseed without releasing ownership", async () => {
    const repo = repository();
    await repo.init();
    await repo.setSyncSubject("account-a");
    await repo.importEvents([addedEvent()], {
      source: "restore",
      mode: "merge",
    });
    await repo.markSynced("account-a", ["event-1"]);
    await repo.setSyncCursor("account-a", "9");

    await repo.resetSyncState("account-a");

    expect(await repo.getSyncCursor("account-a")).toBeNull();
    expect(
      (await repo.unsyncedEvents("account-a")).map((event) => event.id),
    ).toEqual(["event-1"]);
    await repo.setSyncSubject("account-b");
    expect(await repo.unsyncedEvents("account-b")).toEqual([]);
  });

  it("should treat remote events as acknowledged only for their authenticated subject", async () => {
    const repo = repository();
    await repo.init();
    await repo.setSyncSubject("account-a");
    await repo.importEvents([addedEvent()], {
      source: "remote",
      subject: "account-a",
    });

    expect(await repo.unsyncedEvents("account-a")).toEqual([]);
    await repo.setSyncSubject("account-b");
    expect(await repo.unsyncedEvents("account-b")).toEqual([]);
  });
});
