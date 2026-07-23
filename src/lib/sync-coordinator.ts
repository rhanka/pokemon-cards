import { ApiRequestError, isRetryableSyncError } from "./api";

export type SyncState =
  | "idle"
  | "pending"
  | "syncing"
  | "synced"
  | "offline"
  | "auth-required"
  | "error";

export type SyncAvailability =
  "ready" | "offline" | "auth-required" | "disabled";

export interface SyncCoordinatorTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncCoordinatorOptions {
  run: () => Promise<void>;
  availability: () => SyncAvailability;
  onState?: (state: SyncState, error?: unknown) => void;
  debounceMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  jitterRatio?: number;
  random?: () => number;
  timers?: SyncCoordinatorTimers;
}

export interface SyncRequestOptions {
  immediate?: boolean;
}

const defaultTimers: SyncCoordinatorTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

type ScheduledKind = "debounce" | "retry";

export class SyncCoordinator {
  private readonly performSync: () => Promise<void>;
  private readonly availability: () => SyncAvailability;
  private readonly onState:
    ((state: SyncState, error?: unknown) => void) | undefined;
  private readonly debounceMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private readonly timers: SyncCoordinatorTimers;

  private currentState: SyncState = "idle";
  private currentError: unknown;
  private timer: unknown;
  private scheduledKind: ScheduledKind | null = null;
  private running = false;
  private rerunRequested = false;
  private retryAttempt = 0;
  private stopped = false;

  constructor(options: SyncCoordinatorOptions) {
    this.performSync = options.run;
    this.availability = options.availability;
    this.onState = options.onState;
    this.debounceMs = nonNegative(options.debounceMs ?? 300, "debounceMs");
    this.initialBackoffMs = nonNegative(
      options.initialBackoffMs ?? 1_000,
      "initialBackoffMs",
    );
    this.maxBackoffMs = nonNegative(
      options.maxBackoffMs ?? 60_000,
      "maxBackoffMs",
    );
    if (this.maxBackoffMs < this.initialBackoffMs) {
      throw new RangeError(
        "maxBackoffMs must be greater than or equal to initialBackoffMs",
      );
    }
    this.jitterRatio = bounded(options.jitterRatio ?? 0.2, 0, 1, "jitterRatio");
    this.random = options.random ?? Math.random;
    this.timers = options.timers ?? defaultTimers;
  }

  get state(): SyncState {
    return this.currentState;
  }

  get error(): unknown {
    return this.currentError;
  }

  request(options: SyncRequestOptions = {}): void {
    if (this.stopped) return;

    if (this.running) {
      this.rerunRequested = true;
      return;
    }

    let availability: SyncAvailability;
    try {
      availability = this.availability();
    } catch (error) {
      this.handleFailure(error);
      return;
    }
    if (availability !== "ready") {
      this.rerunRequested = false;
      this.clearScheduledTimer();
      this.applyUnavailableState(availability);
      return;
    }

    if (options.immediate) {
      this.clearScheduledTimer();
      void this.run();
      return;
    }

    if (this.scheduledKind === "retry") return;

    this.clearScheduledTimer();
    this.setState("pending");
    this.schedule("debounce", this.debounceMs);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.rerunRequested = false;
    this.clearScheduledTimer();
    this.setState("idle");
  }

  private applyUnavailableState(availability: SyncAvailability): void {
    if (this.stopped) return;
    switch (availability) {
      case "offline":
        this.setState("offline");
        break;
      case "auth-required":
        this.setState("auth-required");
        break;
      case "disabled":
        this.retryAttempt = 0;
        this.setState("idle");
        break;
      case "ready":
        break;
    }
  }

  private schedule(kind: ScheduledKind, delayMs: number): void {
    if (this.stopped) return;
    this.scheduledKind = kind;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.scheduledKind = null;
      void this.run();
    }, delayMs);
  }

  private clearScheduledTimer(): void {
    if (this.scheduledKind !== null) {
      this.timers.clearTimeout(this.timer);
    }
    this.timer = undefined;
    this.scheduledKind = null;
  }

  private async run(): Promise<void> {
    if (this.stopped || this.running) return;

    let availability: SyncAvailability;
    try {
      availability = this.availability();
    } catch (error) {
      this.handleFailure(error);
      return;
    }
    if (this.stopped || availability !== "ready") {
      this.applyUnavailableState(availability);
      return;
    }

    this.running = true;
    this.rerunRequested = false;
    this.setState("syncing");

    while (!this.stopped) {
      try {
        await this.performSync();
      } catch (error) {
        this.running = false;
        this.rerunRequested = false;
        this.handleFailure(error);
        return;
      }

      if (this.stopped) {
        this.running = false;
        return;
      }

      this.retryAttempt = 0;
      if (!this.rerunRequested) {
        this.running = false;
        this.setState("synced");
        return;
      }

      this.rerunRequested = false;
      let nextAvailability: SyncAvailability;
      try {
        nextAvailability = this.availability();
      } catch (error) {
        this.running = false;
        this.handleFailure(error);
        return;
      }
      if (this.stopped || nextAvailability !== "ready") {
        this.running = false;
        this.applyUnavailableState(nextAvailability);
        return;
      }
    }

    this.running = false;
  }

  private handleFailure(error: unknown): void {
    if (this.stopped) return;

    this.currentError = error;
    if (error instanceof ApiRequestError && error.status === 401) {
      this.clearScheduledTimer();
      this.setState("auth-required", error);
      return;
    }

    this.setState("error", error);
    this.clearScheduledTimer();
    if (!isRetryableSyncError(error)) return;
    this.schedule("retry", this.retryDelay(error));
  }

  private retryDelay(error: unknown): number {
    const exponent = Math.min(this.retryAttempt, 30);
    const backoff = Math.min(
      this.maxBackoffMs,
      this.initialBackoffMs * 2 ** exponent,
    );
    this.retryAttempt += 1;

    const random = bounded(this.random(), 0, 1, "random");
    const jitterFactor = 1 - this.jitterRatio + 2 * this.jitterRatio * random;
    const jitteredBackoff = Math.round(backoff * jitterFactor);
    const retryAfterMs =
      error instanceof ApiRequestError &&
      error.retryAfterSeconds !== undefined &&
      Number.isFinite(error.retryAfterSeconds) &&
      error.retryAfterSeconds > 0
        ? Math.ceil(error.retryAfterSeconds * 1_000)
        : 0;
    return Math.max(jitteredBackoff, retryAfterMs);
  }

  private setState(state: SyncState, error?: unknown): void {
    if (this.stopped && state !== "idle") return;
    const changed = this.currentState !== state || this.currentError !== error;
    this.currentState = state;
    this.currentError = error;
    if (changed) this.onState?.(state, error);
  }
}

export function createSyncCoordinator(
  options: SyncCoordinatorOptions,
): SyncCoordinator {
  return new SyncCoordinator(options);
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
  return value;
}

function bounded(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be a finite number between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
