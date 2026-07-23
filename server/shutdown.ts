import type { Server as HttpServer } from "node:http";

interface ProcessControl {
  exitCode: string | number | undefined;
  exit: (code?: number) => void;
}

export interface ShutdownHandlerOptions {
  server: Pick<HttpServer, "close" | "closeAllConnections">;
  closeRuntime: () => Promise<void>;
  processControl?: ProcessControl;
  logger?: Pick<Console, "error" | "info">;
  forceConnectionsAfterMs?: number;
  forceExitAfterMs?: number;
}

export function createShutdownHandler(
  options: ShutdownHandlerOptions,
): (signal: NodeJS.Signals) => void {
  const processControl = options.processControl ?? process;
  const logger = options.logger ?? console;
  const forceConnectionsAfterMs = options.forceConnectionsAfterMs ?? 15_000;
  const forceExitAfterMs = options.forceExitAfterMs ?? 18_000;
  let shuttingDown = false;

  return (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down CardScope API`);
    options.server.close();
    const forceClose = setTimeout(
      () => options.server.closeAllConnections(),
      forceConnectionsAfterMs,
    );
    forceClose.unref();
    // createWorker() does not expose its worker-thread handle until bootstrap
    // finishes. If bootstrap itself stalls, process exit is the only hard
    // bound that completes before Kubernetes' 20-second pod grace period.
    const forceExit = setTimeout(() => {
      logger.error("CardScope shutdown exceeded its deadline; forcing exit");
      options.server.closeAllConnections();
      processControl.exit(0);
    }, forceExitAfterMs);
    forceExit.unref();
    void Promise.resolve()
      .then(options.closeRuntime)
      .finally(() => {
        clearTimeout(forceClose);
        options.server.closeAllConnections();
        processControl.exitCode = 0;
      });
  };
}
