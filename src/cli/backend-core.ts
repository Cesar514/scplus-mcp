// summary: Re-exports the public backend core surface from split manager and shared modules.
// FEATURE: Stable backend-core import path for session-backed backend operations.
// inputs: Backend manager consumers and typed backend event payload imports.
// outputs: Public backend core factory, manager class, and backend event or payload types.

export { BackendCore, createBackendCore } from "./backend-core-manager.js";
export type {
  BackendEvent,
  BackendEventKind,
  BackendJobControlAction,
  BackendJobName,
  BackendJobState,
} from "./backend-core-shared.js";
