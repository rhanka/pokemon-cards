import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { CollectionRepository, isCollectionEvent } from "../../src/lib/db";
import { eventsFromJson, eventsToJson } from "../../src/lib/import-export";
import { formatMoney } from "../../src/lib/i18n";
import { collectionTotals } from "../../src/lib/value";
import type {
  CatalogCard,
  CollectionEvent,
  Holding,
  PriceQuote,
} from "../../src/lib/types";

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

function quote(overrides: Partial<PriceQuote> = {}): PriceQuote {
  return {
    source: "licensed-feed",
    market: "tcgplayer",
    currency: "USD",
    low: 1,
    marketPrice: 2,
    high: 3,
    observedAt: "2026-07-22T00:00:00.000Z",
    staleAfter: "2026-07-23T00:00:00.000Z",
    ...overrides,
  };
}

function svelteLikeProxy<T>(value: T): T {
  const proxies = new WeakMap<object, object>();
  const proxify = (item: unknown): unknown => {
    if (!item || typeof item !== "object") return item;
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== Array.prototype)
      return item;
    const existing = proxies.get(item);
    if (existing) return existing;
    const proxied = new Proxy(item, {
      get(target, key, receiver) {
        return proxify(Reflect.get(target, key, receiver));
      },
    });
    proxies.set(item, proxied);
    return proxied;
  };
  return proxify(value) as T;
}

afterEach(() => {
  for (const instance of opened.splice(0)) instance.close();
});

describe("collection event runtime integrity", () => {
  it("should persist a Svelte-proxied valued card without leaking transient fields", async () => {
    const repo = repository();
    await repo.init();
    const selectedQuote = {
      ...quote(),
      transientRank: 0.99,
    };
    const recognized = svelteLikeProxy({
      id: "pokemon-card:en:base1:58:pikachu",
      name: "Pikachu",
      number: "58",
      setName: "Base Set",
      language: "en",
      quote: selectedQuote,
      quotes: [selectedQuote],
      score: 1,
      scoreParts: { number: 1, name: 1, visual: null, catalogue: 1 },
      matchReasons: ["number", "name"],
    }) as unknown as CatalogCard & {
      score: number;
      scoreParts: Record<string, number | null>;
      matchReasons: string[];
    };

    await repo.add({
      card: { ...recognized, quote: recognized.quote },
      finish: "normal",
      condition: "near-mint",
      quote: recognized.quotes?.[0],
    });

    const persisted = currentSnapshot(repo).holdings[0];
    const card = persisted.card;
    expect(card).toMatchObject({ name: "Pikachu", number: "58" });
    expect(card).not.toHaveProperty("score");
    expect(card).not.toHaveProperty("scoreParts");
    expect(card).not.toHaveProperty("matchReasons");
    expect(card.quote).not.toHaveProperty("transientRank");
    expect(card.quotes?.[0]).not.toHaveProperty("transientRank");
    expect(persisted.quote).not.toHaveProperty("transientRank");
  });

  it("should persist a Svelte-proxied quote update without leaking transient fields", async () => {
    const repo = repository();
    await repo.init();
    await repo.add({
      card: { id: "card-quote-update", name: "Pikachu" },
      finish: "normal",
      condition: "near-mint",
    });
    const holdingId = currentSnapshot(repo).holdings[0].id;
    const proxied = svelteLikeProxy({ ...quote(), transientRank: 0.99 });

    await repo.update(holdingId, {
      quote: proxied as unknown as PriceQuote,
    });

    const persisted = currentSnapshot(repo).holdings[0].quote;
    expect(persisted).toMatchObject({ source: "licensed-feed", low: 1 });
    expect(persisted).not.toHaveProperty("transientRank");
  });

  it("should reject non-finite numbers in proxied card quotes", async () => {
    const repo = repository();
    await repo.init();
    const card = svelteLikeProxy({
      id: "card-invalid-quote",
      name: "Pikachu",
      quotes: [quote({ marketPrice: Number.POSITIVE_INFINITY })],
    });

    await expect(
      repo.add({
        card,
        finish: "normal",
        condition: "near-mint",
      }),
    ).rejects.toThrow();
    expect(await repo.allEvents()).toEqual([]);
  });

  it("should reject non-finite numbers in a proxied quote update", async () => {
    const repo = repository();
    await repo.init();
    await repo.add({
      card: { id: "card-invalid-update", name: "Pikachu" },
      finish: "normal",
      condition: "near-mint",
    });
    const holdingId = currentSnapshot(repo).holdings[0].id;

    await expect(
      repo.update(holdingId, {
        quote: svelteLikeProxy(
          quote({ low: Number.NaN }),
        ) as unknown as PriceQuote,
      }),
    ).rejects.toThrow();
    expect(await repo.allEvents()).toHaveLength(1);
  });

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

  it("should atomically reject a concurrent mutation that targets an inactive holding", async () => {
    const repo = repository();
    await repo.init();
    await repo.add({
      card: { id: "single-card", name: "Single card" },
      finish: "normal",
      condition: "good",
    });
    const holdingId = currentSnapshot(repo).holdings[0].id;

    const results = await Promise.allSettled([
      repo.adjustQuantity(holdingId, -1),
      repo.adjustQuantity(holdingId, -1),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(currentSnapshot(repo).holdings).toEqual([]);
    expect(await repo.allEvents()).toHaveLength(2);
  });

  it("should atomically group concurrent adds of the same card", async () => {
    const repo = repository();
    await repo.init();
    const input = {
      card: { id: "double-tap-card", name: "Double tap card" },
      finish: "normal" as const,
      condition: "good" as const,
    };

    await Promise.all([repo.add(input), repo.add(input)]);

    expect(currentSnapshot(repo).holdings).toHaveLength(1);
    expect(currentSnapshot(repo).holdings[0].quantity).toBe(2);
    expect((await repo.allEvents()).map((event) => event.type)).toEqual([
      "holding.added",
      "holding.quantity-adjusted",
    ]);
  });

  it("should reject a structurally valid import that violates the holding state machine", async () => {
    const repo = repository();
    await repo.init();
    const updateWithoutHolding: CollectionEvent = {
      id: "orphan-update",
      type: "holding.updated",
      holdingId: "missing-holding",
      occurredAt: "2026-01-02T00:00:00.000Z",
      deviceId: "device-1",
      payload: { note: "orphan" },
    };

    await expect(
      repo.importEvents([updateWithoutHolding], {
        source: "restore",
        mode: "merge",
      }),
    ).rejects.toThrow(/active holding/i);
    expect(await repo.allEvents()).toEqual([]);
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

  it("should reject an individually oversized restore before it can poison the sync queue", async () => {
    const repo = repository();
    await repo.init();
    repo.setSyncOperationByteLimit(512);
    const oversized = addedEvent("oversized-event", {
      ...holding,
      note: "x".repeat(1_000),
    });

    await expect(
      repo.importEvents([oversized], {
        source: "restore",
        mode: "merge",
      }),
    ).rejects.toThrow(/sync limit/i);
    expect(await repo.allEvents()).toEqual([]);
  });

  it("should exclude transport metadata from backups without resetting an authenticated epoch", async () => {
    const repo = repository();
    await repo.init();
    await repo.setSyncSubject("account-a");
    await repo.importEvents([addedEvent()], {
      source: "restore",
      mode: "merge",
    });
    await repo.markSynced("account-a", ["event-1"], "2026-07-22T00:00:00.000Z");
    await repo.setSyncCursor("account-a", "12");
    await repo.setSyncGeneration("account-a", "7");

    const eventsForBackup = await repo.allEvents();
    eventsForBackup[0].serverSequence = 99;
    const backup = eventsToJson(eventsForBackup);
    expect(backup).not.toContain("syncedAt");
    expect(backup).not.toContain("serverSequence");
    await repo.importEvents(eventsFromJson(backup), {
      source: "restore",
      mode: "merge",
    });

    expect(await repo.getSyncCursor("account-a")).toBe("12");
    expect(await repo.getSyncGeneration("account-a")).toBe("7");
    expect(await repo.unsyncedEvents("account-a")).toEqual([]);
    expect((await repo.allEvents())[0].syncedAt).toBe(
      "2026-07-22T00:00:00.000Z",
    );

    const secondHolding = {
      ...holding,
      id: "holding-restored",
      cardId: "card-restored",
      card: { id: "card-restored", name: "Restored" },
    };
    await repo.importEvents([addedEvent("event-restored", secondHolding)], {
      source: "restore",
      mode: "merge",
    });
    expect(
      (await repo.unsyncedEvents("account-a")).map((event) => event.id),
    ).toEqual(["event-restored"]);
    expect(await repo.getSyncGeneration("account-a")).toBe("7");
  });

  it("should support explicit atomic merge and confirmed replace restore modes", async () => {
    const repo = repository();
    await repo.init();
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
  it("should preserve acknowledged server ordering when an older backup repeats the same IDs", async () => {
    const repo = repository();
    await repo.init();
    await repo.setSyncSubject("account-a");
    const remoteAdded = {
      ...addedEvent(),
      occurredAt: "2026-12-31T00:00:00.000Z",
      serverSequence: 11,
    };
    const remoteAdjustment: CollectionEvent = {
      id: "event-adjust",
      type: "holding.quantity-adjusted",
      holdingId: holding.id,
      occurredAt: "2026-01-01T00:00:00.000Z",
      deviceId: "device-2",
      payload: { delta: 1 },
      serverSequence: 12,
    };
    await repo.setSyncGeneration("account-a", "1");
    await repo.importEvents([remoteAdded, remoteAdjustment], {
      source: "remote",
      subject: "account-a",
      generation: "1",
    });
    expect(currentSnapshot(repo).holdings[0].quantity).toBe(2);

    const oldBackup = [remoteAdded, remoteAdjustment].map((event) => {
      const copy = structuredClone(event);
      delete copy.serverSequence;
      delete copy.syncedAt;
      return copy;
    });
    await repo.importEvents(oldBackup, {
      source: "restore",
      mode: "merge",
    });

    expect(currentSnapshot(repo).holdings[0].quantity).toBe(2);
    expect(await repo.unsyncedEvents("account-a")).toEqual([]);
    expect(
      Object.fromEntries(
        (await repo.allEvents()).map((event) => [
          event.id,
          event.serverSequence,
        ]),
      ),
    ).toEqual({ "event-1": 11, "event-adjust": 12 });

    await expect(
      repo.importEvents([{ ...oldBackup[1], payload: { delta: 2 } }], {
        source: "restore",
        mode: "merge",
      }),
    ).rejects.toThrow(/conflicting content/i);
    expect(currentSnapshot(repo).holdings[0].quantity).toBe(2);
  });

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
    await expect(
      repo.importEvents([addedEvent("a-replacement-event", replacement)], {
        source: "restore",
        mode: "replace",
        confirmed: true,
      }),
    ).rejects.toThrow(/generation change/i);
    expect(currentSnapshot(repo).holdings.map((item) => item.cardId)).toEqual([
      "a-card",
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
    await repo.setSyncGeneration("account-a", "1");
    await repo.importEvents([addedEvent()], {
      source: "remote",
      subject: "account-a",
      generation: "1",
    });

    expect(await repo.unsyncedEvents("account-a")).toEqual([]);
    await repo.setSyncSubject("account-b");
    expect(await repo.unsyncedEvents("account-b")).toEqual([]);
  });

  it("should atomically adopt anonymous events into the signed-in account exactly once", async () => {
    const repo = repository();
    await repo.init();
    await repo.add({
      card: { id: "anonymous-card", name: "Anonymous card" },
      finish: "normal",
      condition: "good",
    });
    expect(await repo.eventCountForSubject(null)).toBe(1);

    await repo.setSyncSubject("account-a");
    await repo.setSyncGeneration("account-a", "1");
    await repo.importEvents(
      [
        addedEvent("remote-event", {
          ...holding,
          id: "remote-holding",
          cardId: "remote-card",
          card: { id: "remote-card", name: "Remote card" },
        }),
      ],
      { source: "remote", subject: "account-a", generation: "1" },
    );

    expect(await repo.claimAnonymousEvents("account-a")).toBe(1);
    expect(await repo.claimAnonymousEvents("account-a")).toBe(0);
    expect(await repo.eventCountForSubject(null)).toBe(0);
    expect(await repo.eventCountForSubject("account-a")).toBe(2);
    expect(
      currentSnapshot(repo)
        .holdings.map((item) => item.cardId)
        .sort(),
    ).toEqual(["anonymous-card", "remote-card"]);
    expect(await repo.unsyncedEvents("account-a")).toHaveLength(1);

    await repo.setSyncSubject(null);
    expect(currentSnapshot(repo).holdings).toEqual([]);
  });

  it("should roll only the rejected enrollment events back to anonymous ownership", async () => {
    const repo = repository();
    await repo.init();
    await repo.add({
      card: { id: "anonymous-card", name: "Anonymous card" },
      finish: "normal",
      condition: "good",
    });
    const anonymousIds = (await repo.eventsForSubject(null)).map(
      (event) => event.id,
    );
    await repo.setSyncSubject("account-a");
    await repo.setSyncGeneration("account-a", "1");
    await repo.importEvents(
      [
        addedEvent("account-event", {
          ...holding,
          id: "account-holding",
          cardId: "account-card",
          card: { id: "account-card", name: "Account card" },
        }),
      ],
      { source: "remote", subject: "account-a", generation: "1" },
    );
    await repo.claimAnonymousEvents("account-a", { trackEnrollment: true });
    expect(await repo.getPendingEnrollment("account-a")).toEqual({
      claimedIds: anonymousIds,
      attemptedIds: [],
    });
    await repo.setPendingEnrollmentAttempt("account-a", anonymousIds);
    expect(await repo.getPendingEnrollment("account-a")).toEqual({
      claimedIds: anonymousIds,
      attemptedIds: anonymousIds,
    });

    expect(
      await repo.returnClaimedEventsToAnonymous("account-a", anonymousIds),
    ).toBe(1);
    expect(await repo.eventCountForSubject(null)).toBe(1);
    expect(await repo.eventCountForSubject("account-a")).toBe(1);
    expect(await repo.getPendingEnrollment("account-a")).toBeNull();
    expect(currentSnapshot(repo).holdings.map((item) => item.cardId)).toEqual([
      "account-card",
    ]);
  });

  it("should block every account-domain user mutation across tabs until enrollment resolves", async () => {
    const databaseName = `cardscope-enrollment-${crypto.randomUUID()}`;
    const first = new CollectionRepository(databaseName);
    const second = new CollectionRepository(databaseName);
    opened.push(first, second);
    await first.init();
    await second.init();
    await first.add({
      card: { id: "anonymous-card", name: "Anonymous card" },
      finish: "normal",
      condition: "good",
    });
    await first.setSyncSubject("account-a");
    await second.setSyncSubject("account-a");
    await first.setSyncGeneration("account-a", "1");
    await first.claimAnonymousEvents("account-a", { trackEnrollment: true });

    await expect(
      second.add({
        card: { id: "late-card", name: "Late card" },
        finish: "normal",
        condition: "good",
      }),
    ).rejects.toThrow(/enrollment/i);
    await expect(
      second.importHoldings([
        {
          card: { id: "imported-card", name: "Imported card" },
          finish: "normal",
          condition: "good",
        },
      ]),
    ).rejects.toThrow(/enrollment/i);
    await expect(
      second.importEvents([addedEvent("restore-during-enrollment")], {
        source: "restore",
        mode: "merge",
      }),
    ).rejects.toThrow(/enrollment/i);

    const claimedIds = (await first.getPendingEnrollment("account-a"))!
      .claimedIds;
    await first.setPendingEnrollmentAttempt("account-a", claimedIds);
    await first.completePendingEnrollment("account-a");
    await second.add({
      card: { id: "after-enrollment", name: "After enrollment" },
      finish: "normal",
      condition: "good",
    });
    expect(await second.eventCountForSubject("account-a")).toBe(2);
  });

  it("should fail closed when pending enrollment metadata is corrupt", async () => {
    const databaseName = `cardscope-corrupt-enrollment-${crypto.randomUUID()}`;
    const repo = new CollectionRepository(databaseName);
    opened.push(repo);
    await repo.init();
    await repo.add({
      card: { id: "anonymous-card", name: "Anonymous card" },
      finish: "normal",
      condition: "good",
    });
    await repo.setSyncSubject("account-a");
    await repo.setSyncGeneration("account-a", "1");
    await repo.claimAnonymousEvents("account-a", { trackEnrollment: true });

    const raw = new Dexie(databaseName);
    raw.version(1).stores({
      events: "&id, occurredAt, holdingId, type, syncedAt",
      meta: "&key",
    });
    await raw.open();
    await raw
      .table("meta")
      .put({ key: "sync:account-a:enrollment", value: '{"claimedIds":42}' });
    raw.close();

    await expect(repo.getPendingEnrollment("account-a")).rejects.toThrow(
      /metadata is invalid/i,
    );
    await expect(
      repo.add({
        card: { id: "blocked-card", name: "Blocked card" },
        finish: "normal",
        condition: "good",
      }),
    ).rejects.toThrow(/enrollment/i);
  });

  it("should invalidate peer snapshots and block cross-tab mutations during deletion", async () => {
    const databaseName = `cardscope-shared-${crypto.randomUUID()}`;
    const first = new CollectionRepository(databaseName);
    const second = new CollectionRepository(databaseName);
    opened.push(first, second);
    await first.init();
    await second.init();
    await first.setSyncSubject("account-a");
    await second.setSyncSubject("account-a");

    await first.add({
      card: { id: "shared-card", name: "Shared card" },
      finish: "normal",
      condition: "good",
    });
    for (
      let attempt = 0;
      attempt < 20 && currentSnapshot(second).eventCount === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(currentSnapshot(second).holdings.map((item) => item.cardId)).toEqual(
      ["shared-card"],
    );

    const release = await first.lockAccountMutations("account-a");
    await expect(
      second.add({
        card: { id: "blocked-card", name: "Blocked card" },
        finish: "normal",
        condition: "good",
      }),
    ).rejects.toThrow(/deletion/i);
    await expect(
      second.clearAccountData("account-a", { confirmed: true }),
    ).rejects.toThrow(/deletion/i);
    await expect(
      second.add({
        card: { id: "still-blocked", name: "Still blocked" },
        finish: "normal",
        condition: "good",
      }),
    ).rejects.toThrow(/deletion/i);
    await first.clearAccountData("account-a", {
      confirmed: true,
      preserveMutationLock: true,
    });
    await first.setSyncGeneration("account-a", "9");
    for (
      let attempt = 0;
      attempt < 20 && currentSnapshot(second).eventCount !== 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(currentSnapshot(second).holdings).toEqual([]);
    await release();
    await second.add({
      card: { id: "after-delete", name: "After delete" },
      finish: "normal",
      condition: "good",
    });
    expect(currentSnapshot(second).holdings).toHaveLength(1);
    expect(await second.getSyncGeneration("account-a")).toBe("9");
  });

  it("should roll enrollment back if the merged event log is invalid", async () => {
    const repo = repository();
    await repo.init();
    await repo.importEvents(
      [
        addedEvent("anonymous-added", {
          ...holding,
          id: "shared-holding",
        }),
      ],
      { source: "restore", mode: "merge" },
    );

    await repo.setSyncSubject("account-a");
    await repo.importEvents(
      [
        addedEvent("account-added", {
          ...holding,
          id: "shared-holding",
        }),
      ],
      { source: "restore", mode: "merge" },
    );

    await expect(repo.claimAnonymousEvents("account-a")).rejects.toThrow(
      /identifier/i,
    );
    expect(await repo.eventCountForSubject(null)).toBe(1);
    expect(await repo.eventCountForSubject("account-a")).toBe(1);
  });

  it("should erase the acknowledged account cache without affecting anonymous or other-account data", async () => {
    const repo = repository();
    await repo.init();
    await repo.add({
      card: { id: "anonymous-card", name: "Anonymous card" },
      finish: "normal",
      condition: "good",
    });
    await repo.setSyncSubject("account-a");
    await repo.setSyncGeneration("account-a", "3");
    await repo.importEvents([addedEvent()], {
      source: "remote",
      subject: "account-a",
      generation: "3",
    });
    await repo.setSyncCursor("account-a", "12");
    await repo.setSyncSubject("account-b");
    await repo.add({
      card: { id: "other-card", name: "Other account card" },
      finish: "normal",
      condition: "good",
    });
    await repo.setSyncSubject("account-a");

    await expect(
      repo.clearAccountData("account-a", {
        confirmed: false as true,
      }),
    ).rejects.toThrow(/explicit confirmation/i);
    expect(await repo.clearAccountData("account-a", { confirmed: true })).toBe(
      1,
    );
    expect(currentSnapshot(repo).holdings).toEqual([]);
    expect(await repo.getSyncCursor("account-a")).toBeNull();
    expect(await repo.getSyncGeneration("account-a")).toBeNull();
    expect(await repo.unsyncedEvents("account-a")).toEqual([]);
    expect(await repo.eventCountForSubject(null)).toBe(1);
    expect(await repo.eventCountForSubject("account-b")).toBe(1);
  });

  it("should isolate and validate server generations per account", async () => {
    const repo = repository();
    await repo.init();

    await repo.setSyncGeneration("account-a", "7");
    expect(await repo.getSyncGeneration("account-a")).toBe("7");
    expect(await repo.getSyncGeneration("account-b")).toBeNull();
    await expect(repo.setSyncGeneration("account-a", "0")).rejects.toThrow(
      /generation/i,
    );
    await expect(
      repo.setSyncGeneration("account-a", "9007199254740992"),
    ).rejects.toThrow(/generation/i);
    await expect(repo.setSyncGeneration("account-a", "6")).rejects.toThrow(
      /generation changed/i,
    );
  });

  it("should fence a delayed stale-generation recovery from new account mutations", async () => {
    const databaseName = `cardscope-generation-fence-${crypto.randomUUID()}`;
    const first = new CollectionRepository(databaseName);
    const second = new CollectionRepository(databaseName);
    opened.push(first, second);
    await first.init();
    await second.init();
    await first.setSyncSubject("account-a");
    await second.setSyncSubject("account-a");
    await first.setSyncGeneration("account-a", "1");
    await first.add({
      card: { id: "stale-card", name: "Stale card" },
      finish: "normal",
      condition: "good",
    });

    expect(
      await first.clearAccountData("account-a", {
        confirmed: true,
        expectedGeneration: "1",
        replacementGeneration: "2",
      }),
    ).toBe(1);
    await second.add({
      card: { id: "new-epoch-card", name: "New epoch card" },
      finish: "normal",
      condition: "good",
    });

    expect(
      await second.clearAccountData("account-a", {
        confirmed: true,
        expectedGeneration: "1",
        replacementGeneration: "2",
      }),
    ).toBeNull();
    expect(await second.getSyncGeneration("account-a")).toBe("2");
    expect(
      (await second.eventsForSubject("account-a")).map(
        (event) => event.payload,
      ),
    ).toHaveLength(1);
    await expect(
      second.importEvents([addedEvent("late-remote-event")], {
        source: "remote",
        subject: "account-a",
        generation: "1",
      }),
    ).rejects.toThrow(/generation changed/i);
  });
});
