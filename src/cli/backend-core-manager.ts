// summary: Owns the public backend core facade that hands out per-root backend sessions.
// FEATURE: Shared backend manager for doctor, tree, hubs, cluster, index, and watcher operations.
// inputs: Repository roots, backend event sink functions, and backend control actions.
// outputs: Session-backed tool results, watcher state transitions, and per-root backend lifecycle control.

import { resolve } from "node:path";
import { listRestorePoints } from "../git/shadow.js";
import { getContextTree } from "../tools/context-tree.js";
import { getFeatureHub } from "../tools/feature-hub.js";
import { semanticNavigate } from "../tools/semantic-navigate.js";
import { buildDoctorReport } from "./reports.js";
import { BackendRootSession } from "./backend-core-session.js";
import type {
  BackendJobControlAction,
  EventSink,
  JobControlPayload,
  ManualIndexMode,
  TextPayload,
  WatchStatePayload,
} from "./backend-core-shared.js";

export class BackendCore {
  private readonly sessions = new Map<string, BackendRootSession>();

  constructor(private readonly eventSink: EventSink = () => { }) { }

  // Purpose: Close every cached backend session and release their watcher resources.
  // Inputs: No direct inputs beyond the currently cached per-root backend sessions.
  // Returns/Effects: Closes active sessions and clears the in-memory session cache.
  async close(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.close();
    }
    this.sessions.clear();
  }

  async doctor(rootDir: string): Promise<Awaited<ReturnType<typeof buildDoctorReport>>> {
    return buildDoctorReport(rootDir);
  }

  // Purpose: Render the structural tree view for the requested repository root.
  // Inputs: The repository root directory requested by the caller.
  // Returns/Effects: Returns the formatted tree payload for that repository root.
  async tree(rootDir: string): Promise<TextPayload> {
    return {
      root: rootDir,
      text: await getContextTree({
        rootDir,
        includeSymbols: true,
        maxTokens: 50000,
      }),
    };
  }

  // Purpose: Render the feature hub view for the requested repository root.
  // Inputs: The repository root directory requested by the caller.
  // Returns/Effects: Returns the formatted hub payload for that repository root.
  async hubs(rootDir: string): Promise<TextPayload> {
    return {
      root: rootDir,
      text: await getFeatureHub({ rootDir }),
    };
  }

  // Purpose: Render the semantic cluster view for the requested repository root.
  // Inputs: The repository root directory requested by the caller.
  // Returns/Effects: Returns the formatted cluster payload for that repository root.
  async cluster(rootDir: string): Promise<TextPayload> {
    return {
      root: rootDir,
      text: await semanticNavigate({
        rootDir,
        maxDepth: 3,
        maxClusters: 20,
      }),
    };
  }

  async refreshClusters(rootDir: string): Promise<TextPayload> {
    return this.getSession(rootDir).runManualCluster();
  }

  async restorePoints(rootDir: string): Promise<Awaited<ReturnType<typeof listRestorePoints>>> {
    return listRestorePoints(rootDir);
  }

  async index(rootDir: string, mode: ManualIndexMode = "auto"): Promise<string> {
    return this.getSession(rootDir).runManualIndex(mode);
  }

  async setWatchEnabled(rootDir: string, enabled: boolean, debounceMs?: number): Promise<WatchStatePayload> {
    return this.getSession(rootDir).setWatchEnabled(enabled, debounceMs);
  }

  // Purpose: Control the current backend job state for the requested repository root.
  // Inputs: The repository root directory and the requested backend job control action.
  // Returns/Effects: Returns the resulting job-control payload after applying the action.
  async controlJob(rootDir: string, action: BackendJobControlAction): Promise<JobControlPayload> {
    const session = this.getSession(rootDir);
    if (action === "cancel-pending") {
      return session.cancelPendingJob();
    }
    if (action === "supersede-pending") {
      return session.supersedePendingJob();
    }
    return session.retryLastIndex();
  }

  // Purpose: Resolve or create the cached backend session for one repository root.
  // Inputs: The repository root directory that should map to a backend session.
  // Returns/Effects: Returns the cached or newly created backend root session instance.
  private getSession(rootDir: string): BackendRootSession {
    const normalizedRoot = resolve(rootDir);
    let session = this.sessions.get(normalizedRoot);
    if (!session) {
      session = new BackendRootSession(normalizedRoot, this.eventSink);
      this.sessions.set(normalizedRoot, session);
    }
    return session;
  }
}

export function createBackendCore(eventSink?: EventSink): BackendCore {
  return new BackendCore(eventSink);
}
