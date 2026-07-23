import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError, SyncProtocolError } from "../../src/lib/api";
import { CollectionSyncGenerationFenceError } from "../../src/lib/db";
import {
  SyncCoordinator,
  type SyncAvailability,
  type SyncCoordinatorOptions,
  type SyncCoordinatorTimers,
  type SyncState,
} from "../../src/lib/sync-coordinator";

const fakeTimers: SyncCoordinatorTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function coordinator(overrides: Partial<SyncCoordinatorOptions> = {}): {
  instance: SyncCoordinator;
  sync: ReturnType<typeof vi.fn<() => Promise<void>>>;
  states: SyncState[];
} {
  const sync = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const states: SyncState[] = [];
  const instance = new SyncCoordinator({
    run: sync,
    availability: () => "ready",
    onState: (state) => states.push(state),
    debounceMs: 100,
    initialBackoffMs: 1_000,
    maxBackoffMs: 10_000,
    jitterRatio: 0,
    random: () => 0.5,
    timers: fakeTimers,
    ...overrides,
  });
  return { instance, sync, states };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SyncCoordinator", () => {
  it("should debounce and coalesce pending requests", async () => {
    const { instance, sync, states } = coordinator();

    instance.request();
    await vi.advanceTimersByTimeAsync(75);
    instance.request();
    await vi.advanceTimersByTimeAsync(99);

    expect(instance.state).toBe("pending");
    expect(sync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(instance.state).toBe("synced");
    expect(states).toEqual(["pending", "syncing", "synced"]);
  });

  it("should run immediately when requested", async () => {
    const { instance, sync } = coordinator();

    instance.request();
    instance.request({ immediate: true });

    expect(sync).toHaveBeenCalledTimes(1);
    expect(instance.state).toBe("syncing");
    await flushPromises();
    expect(instance.state).toBe("synced");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("should keep one flight and rerun once when requested during it", async () => {
    const first = deferred();
    const second = deferred();
    const sync = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { instance } = coordinator({ run: sync });

    instance.request({ immediate: true });
    instance.request();
    instance.request({ immediate: true });

    expect(sync).toHaveBeenCalledTimes(1);

    first.resolve();
    await flushPromises();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(instance.state).toBe("syncing");

    second.resolve();
    await flushPromises();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(instance.state).toBe("synced");
  });

  it("should expose availability states without starting sync", async () => {
    let availability: SyncAvailability = "offline";
    const { instance, sync } = coordinator({
      availability: () => availability,
    });

    instance.request({ immediate: true });
    expect(instance.state).toBe("offline");

    availability = "auth-required";
    instance.request({ immediate: true });
    expect(instance.state).toBe("auth-required");

    availability = "disabled";
    instance.request({ immediate: true });
    expect(instance.state).toBe("idle");

    availability = "ready";
    instance.request({ immediate: true });
    await flushPromises();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(instance.state).toBe("synced");
  });

  it("should apply exponential jitter and honor a longer Retry-After", async () => {
    const sync = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new TypeError("temporary transport failure"))
      .mockRejectedValueOnce(
        new ApiRequestError(429, "rate_limited", 5, "Slow down"),
      )
      .mockResolvedValueOnce(undefined);
    const { instance } = coordinator({
      run: sync,
      jitterRatio: 0.5,
      random: () => 1,
    });

    instance.request({ immediate: true });
    await flushPromises();
    expect(instance.state).toBe("error");

    await vi.advanceTimersByTimeAsync(1_499);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(sync).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(sync).toHaveBeenCalledTimes(3);
    expect(instance.state).toBe("synced");
  });

  it("should retry a cross-tab generation fence as transient contention", async () => {
    const sync = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new CollectionSyncGenerationFenceError())
      .mockResolvedValueOnce(undefined);
    const { instance } = coordinator({ run: sync });

    instance.request({ immediate: true });
    await flushPromises();
    expect(instance.state).toBe("error");
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(sync).toHaveBeenCalledTimes(2);
    expect(instance.state).toBe("synced");
  });

  it("should enter auth-required and never retry a 401", async () => {
    const sync = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(
        new ApiRequestError(401, "unauthorized", undefined, "Sign in"),
      );
    const { instance } = coordinator({ run: sync });

    instance.request({ immediate: true });
    await flushPromises();

    expect(instance.state).toBe("auth-required");
    expect(instance.error).toBeInstanceOf(ApiRequestError);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("should surface permanent HTTP and protocol failures without retrying", async () => {
    const httpRun = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(
        new ApiRequestError(413, "payload_too_large", undefined, "Too large"),
      );
    const http = coordinator({
      run: httpRun,
    });
    http.instance.request({ immediate: true });
    await flushPromises();

    expect(http.instance.state).toBe("error");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(httpRun).toHaveBeenCalledTimes(1);

    const protocolRun = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new SyncProtocolError("Invalid response"));
    const protocol = coordinator({
      run: protocolRun,
    });
    protocol.instance.request({ immediate: true });
    await flushPromises();

    expect(protocol.instance.state).toBe("error");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(protocolRun).toHaveBeenCalledTimes(1);

    const exhaustedStorageRun = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(
        new ApiRequestError(507, "storage_limit", undefined, "Account is full"),
      );
    const exhaustedStorage = coordinator({ run: exhaustedStorageRun });
    exhaustedStorage.instance.request({ immediate: true });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exhaustedStorageRun).toHaveBeenCalledTimes(1);

    const applicationRun = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("Local invariant failed"));
    const application = coordinator({ run: applicationRun });
    application.instance.request({ immediate: true });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(applicationRun).toHaveBeenCalledTimes(1);
  });

  it("should not retry an intentional cancellation", async () => {
    const cancelled = new DOMException("Cancelled", "AbortError");
    const sync = vi.fn<() => Promise<void>>().mockRejectedValue(cancelled);
    const { instance } = coordinator({ run: sync });

    instance.request({ immediate: true });
    await flushPromises();
    expect(instance.state).toBe("error");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("should clear scheduled work and ignore an in-flight rerun after stop", async () => {
    const clearTimeout = vi.fn(fakeTimers.clearTimeout);
    const scheduled = coordinator({
      timers: { ...fakeTimers, clearTimeout },
    });
    scheduled.instance.request();
    scheduled.instance.stop();

    expect(clearTimeout).toHaveBeenCalledTimes(1);
    expect(scheduled.instance.state).toBe("idle");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scheduled.sync).not.toHaveBeenCalled();

    const active = deferred();
    const sync = vi.fn<() => Promise<void>>().mockReturnValue(active.promise);
    const running = coordinator({ run: sync });
    running.instance.request({ immediate: true });
    running.instance.request();
    running.instance.stop();
    active.resolve();
    await flushPromises();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(running.instance.state).toBe("idle");
  });
});
