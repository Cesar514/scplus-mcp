// summary: Provides helpers for process shutdown, idle monitoring, and broken-pipe handling.
// FEATURE: Runtime process lifecycle and broken-pipe detection utilities.
// inputs: Process signals, stdio lifecycle events, and idle timeout configuration.
// outputs: Lifecycle guards, idle monitor behavior, and shutdown control signals.

interface ErrorWithCode {
  code?: string;
}

const BROKEN_PIPE_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "ECONNRESET"]);
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_IDLE_TIMEOUT_MS = 60 * 1000;
const DEFAULT_PARENT_POLL_MS = 5 * 1000;
const MIN_PARENT_POLL_MS = 1 * 1000;

export interface CleanupOptions {
  cancelEmbeddings?: () => void;
  stopTracker: () => void;
  closeServer: () => Promise<void> | void;
  closeTransport: () => Promise<void> | void;
  stopMonitors?: () => void;
}

export interface IdleMonitor {
  touch: () => void;
  stop: () => void;
}

export interface IdleMonitorOptions {
  timeoutMs: number;
  onIdle: () => void;
  isTransportAlive?: () => boolean;
}

export interface ParentMonitorOptions {
  parentPid: number;
  pollIntervalMs?: number;
  onParentExit: () => void;
  isProcessAlive?: (pid: number) => boolean;
}

// Purpose: Parse an integer-like environment value while falling back to a required default.
// Inputs: The optional raw string value plus the numeric fallback to use when parsing fails.
// Returns/Effects: Returns a finite integer-compatible number chosen from the parsed value or fallback.
function toIntegerOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Purpose: Safely call `unref` on timers or handles that optionally support it.
// Inputs: A timer-like handle that may expose an `unref` method.
// Returns/Effects: Invokes `unref` when available to avoid keeping the process alive.
function unrefHandle(handle: { unref?: () => void } | null): void {
  handle?.unref?.();
}

// Purpose: Detect whether an unknown runtime error corresponds to a broken pipe condition.
// Inputs: An unknown error value caught from process or stream operations.
// Returns/Effects: Returns true when the error exposes a known broken-pipe code.
export function isBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code } = error as ErrorWithCode;
  return typeof code === "string" && BROKEN_PIPE_CODES.has(code);
}

// Purpose: Normalize idle-timeout configuration from environment or CLI-style string inputs.
// Inputs: The optional idle-timeout string value.
// Returns/Effects: Returns zero for disabled settings or a timeout clamped to the minimum allowed duration.
export function getIdleShutdownMs(value: string | undefined): number {
  const normalized = value?.trim().toLowerCase();
  if (normalized && ["0", "false", "off", "disabled", "none"].includes(normalized)) return 0;
  return Math.max(MIN_IDLE_TIMEOUT_MS, toIntegerOr(value, DEFAULT_IDLE_TIMEOUT_MS));
}

// Purpose: Normalize the parent-process poll interval from environment or CLI-style string inputs.
// Inputs: The optional poll-interval string value.
// Returns/Effects: Returns a poll interval clamped to the minimum allowed duration.
export function getParentPollMs(value: string | undefined): number {
  return Math.max(MIN_PARENT_POLL_MS, toIntegerOr(value, DEFAULT_PARENT_POLL_MS));
}

// Purpose: Check whether a process id is currently alive using a configurable kill-based probe.
// Inputs: The target pid plus an optional kill-check implementation for testing.
// Returns/Effects: Returns true when the process appears alive and false when it is invalid or missing.
export function isProcessAlive(pid: number, killCheck: (pid: number, signal: number) => void = process.kill): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;

  try {
    killCheck(pid, 0);
    return true;
  } catch (error) {
    if (!error || typeof error !== "object") return false;
    const { code } = error as ErrorWithCode;
    return code !== "ESRCH";
  }
}

// Purpose: Build an idle monitor that triggers shutdown logic after a period of inactivity.
// Inputs: Idle timeout options including the timeout duration, idle callback, and transport-alive probe.
// Returns/Effects: Returns monitor controls that reschedule or stop the idle timeout timer.
export function createIdleMonitor(options: IdleMonitorOptions): IdleMonitor {
  if (options.timeoutMs <= 0) {
    return {
      touch: () => { },
      stop: () => { },
    };
  }

  let timer: NodeJS.Timeout | null = null;

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (options.isTransportAlive && options.isTransportAlive()) {
        schedule();
        return;
      }
      options.onIdle();
    }, options.timeoutMs);
    unrefHandle(timer);
  };

  schedule();

  return {
    touch: schedule,
    stop: () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
    },
  };
}

// Purpose: Start a parent-process monitor that shuts down when the supervising process disappears.
// Inputs: Parent-process monitoring options including the parent pid, poll interval, and exit callback.
// Returns/Effects: Starts interval-based monitoring and returns a stop function for the monitor.
export function startParentMonitor(options: ParentMonitorOptions): () => void {
  if (!Number.isFinite(options.parentPid) || options.parentPid <= 1 || options.parentPid === process.pid) {
    return () => { };
  }

  const pollIntervalMs = Math.max(MIN_PARENT_POLL_MS, Math.floor(options.pollIntervalMs ?? DEFAULT_PARENT_POLL_MS));
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
  };

  const interval = setInterval(() => {
    if (stopped) return;
    if (process.ppid !== options.parentPid || !isAlive(options.parentPid)) {
      stop();
      options.onParentExit();
    }
  }, pollIntervalMs);

  unrefHandle(interval);
  return stop;
}

// Purpose: Run coordinated process cleanup for embeddings, trackers, servers, and transports.
// Inputs: Cleanup callbacks for embeddings, trackers, monitors, servers, and transports.
// Returns/Effects: Stops local services and waits for the close operations to settle.
export async function runCleanup(options: CleanupOptions): Promise<void> {
  options.cancelEmbeddings?.();
  options.stopMonitors?.();
  options.stopTracker();
  await Promise.allSettled([
    Promise.resolve(options.closeServer()),
    Promise.resolve(options.closeTransport()),
  ]);
}
