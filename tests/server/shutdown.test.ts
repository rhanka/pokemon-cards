import { afterEach, describe, expect, it, vi } from "vitest";

import { createShutdownHandler } from "../../server/shutdown.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("server shutdown", () => {
  it("should force process exit before the Kubernetes grace period", async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const closeAllConnections = vi.fn();
    const closeRuntime = vi.fn(() => new Promise<void>(() => undefined));
    const exit = vi.fn();
    const processControl = { exitCode: undefined, exit };
    const shutdown = createShutdownHandler({
      server: { close, closeAllConnections },
      closeRuntime,
      processControl,
      logger: { info: vi.fn(), error: vi.fn() },
      forceConnectionsAfterMs: 15_000,
      forceExitAfterMs: 18_000,
    });

    shutdown("SIGTERM");
    shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(17_999);

    expect(close).toHaveBeenCalledOnce();
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(closeAllConnections).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(closeAllConnections).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
