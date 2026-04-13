// summary: Defines repo-local filesystem paths for scplus durable state and generated assets.
// FEATURE: Project state paths for sqlite storage and generated hubs.
// inputs: Project root paths, storage mode rules, and generated artifact naming conventions.
// outputs: Canonical layout paths for sqlite state, exports, and suggested hubs.

import { mkdir } from "fs/promises";
import { join } from "path";

export const SCPLUS_DIR = ".scplus";
export const SCPLUS_HUBS_DIR = join(SCPLUS_DIR, "hubs");
export const SCPLUS_EMBEDDINGS_DIR = join(SCPLUS_DIR, "embeddings");
export const SCPLUS_CONFIG_DIR = join(SCPLUS_DIR, "config");
export const SCPLUS_CHECKPOINTS_DIR = join(SCPLUS_DIR, "checkpoints");
export const SCPLUS_DERIVED_DIR = join(SCPLUS_DIR, "derived");
export const SCPLUS_STATE_DIR = join(SCPLUS_DIR, "state");
export const SCPLUS_INDEX_DB_FILE = join(SCPLUS_STATE_DIR, "index.sqlite");

export interface ScplusLayout {
  root: string;
  hubs: string;
  embeddings: string;
  config: string;
  checkpoints: string;
  derived: string;
  state: string;
}

// Purpose: Build the canonical `.scplus` directory layout for a repository root.
// Inputs: The repository root directory whose Context+ storage paths should be resolved.
// Returns/Effects: Returns the full set of repo-local storage and artifact paths.
export function getScplusLayout(rootDir: string): ScplusLayout {
  return {
    root: join(rootDir, SCPLUS_DIR),
    hubs: join(rootDir, SCPLUS_HUBS_DIR),
    embeddings: join(rootDir, SCPLUS_EMBEDDINGS_DIR),
    config: join(rootDir, SCPLUS_CONFIG_DIR),
    checkpoints: join(rootDir, SCPLUS_CHECKPOINTS_DIR),
    derived: join(rootDir, SCPLUS_DERIVED_DIR),
    state: join(rootDir, SCPLUS_STATE_DIR),
  };
}

// Purpose: Ensure the minimal `.scplus` directory structure exists before stateful operations run.
// Inputs: The repository root directory whose Context+ layout should be created.
// Returns/Effects: Creates required directories on disk and returns the resolved layout paths.
export async function ensureScplusLayout(rootDir: string): Promise<ScplusLayout> {
  const layout = getScplusLayout(rootDir);
  await mkdir(layout.root, { recursive: true });
  await mkdir(layout.state, { recursive: true });
  return layout;
}
