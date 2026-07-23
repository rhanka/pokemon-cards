export interface CatalogueGuardOptions {
  perClientPerMinute: number;
  globalPerMinute: number;
  maxConcurrent: number;
  clock?: () => number;
}

export type CatalogueGuardLease =
  | {
      allowed: false;
      reason: "concurrency" | "rate";
      retryAfterSeconds: number;
    }
  | {
      allowed: true;
      release: () => void;
      refundClientQuota: () => void;
    };

interface WindowCounter {
  windowStartedAt: number;
  count: number;
  lastSeenAt: number;
}

const WINDOW_MS = 60_000;
const MAX_TRACKED_CLIENTS = 10_000;

/**
 * A small in-process backstop for anonymous catalogue traffic. Traefik remains
 * the right place for distributed throttling; the global counter and
 * concurrency lease still cap provider pressure if client IP headers are
 * missing or spoofed.
 */
export class CatalogueRequestGuard {
  private readonly clock: () => number;
  private readonly clients = new Map<string, WindowCounter>();
  private global: WindowCounter = {
    windowStartedAt: 0,
    count: 0,
    lastSeenAt: 0,
  };
  private active = 0;

  constructor(private readonly options: CatalogueGuardOptions) {
    for (const [name, value] of Object.entries({
      perClientPerMinute: options.perClientPerMinute,
      globalPerMinute: options.globalPerMinute,
      maxConcurrent: options.maxConcurrent,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
    this.clock = options.clock ?? Date.now;
  }

  enter(clientId: string): CatalogueGuardLease {
    const now = this.clock();
    if (this.active >= this.options.maxConcurrent) {
      return {
        allowed: false,
        reason: "concurrency",
        retryAfterSeconds: 1,
      };
    }

    this.global = this.currentWindow(this.global, now);
    const normalizedClient = clientId.trim().slice(0, 200) || "unknown";
    const client = this.currentWindow(this.clients.get(normalizedClient), now);
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((client.windowStartedAt + WINDOW_MS - now) / 1_000),
    );

    if (
      this.global.count >= this.options.globalPerMinute ||
      client.count >= this.options.perClientPerMinute
    ) {
      client.lastSeenAt = now;
      this.rememberClient(normalizedClient, client, now);
      return { allowed: false, reason: "rate", retryAfterSeconds };
    }

    this.global.count += 1;
    this.global.lastSeenAt = now;
    client.count += 1;
    client.lastSeenAt = now;
    this.rememberClient(normalizedClient, client, now);
    this.active += 1;

    let released = false;
    let clientQuotaRefunded = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
      },
      refundClientQuota: () => {
        if (clientQuotaRefunded) return;
        clientQuotaRefunded = true;
        client.count = Math.max(0, client.count - 1);
      },
    };
  }

  private currentWindow(
    counter: WindowCounter | undefined,
    now: number,
  ): WindowCounter {
    if (
      !counter ||
      now - counter.windowStartedAt >= WINDOW_MS ||
      now < counter.windowStartedAt
    ) {
      return { windowStartedAt: now, count: 0, lastSeenAt: now };
    }
    return counter;
  }

  private rememberClient(
    clientId: string,
    counter: WindowCounter,
    now: number,
  ): void {
    this.clients.set(clientId, counter);
    if (this.clients.size <= MAX_TRACKED_CLIENTS) return;

    for (const [key, value] of this.clients) {
      if (now - value.lastSeenAt >= WINDOW_MS) this.clients.delete(key);
      if (this.clients.size <= MAX_TRACKED_CLIENTS) return;
    }

    let oldestKey: string | null = null;
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const [key, value] of this.clients) {
      if (value.lastSeenAt < oldestSeen) {
        oldestKey = key;
        oldestSeen = value.lastSeenAt;
      }
    }
    if (oldestKey) this.clients.delete(oldestKey);
  }
}
