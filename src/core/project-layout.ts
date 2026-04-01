// Context+ project layout definitions for durable repo-local state
// FEATURE: Project state paths for config, embeddings, checkpoints, and index

import { mkdir } from "fs/promises";
import { join } from "path";

export const CONTEXTPLUS_DIR = ".contextplus";
export const CONTEXTPLUS_HUBS_DIR = join(CONTEXTPLUS_DIR, "hubs");
export const CONTEXTPLUS_EMBEDDINGS_DIR = join(CONTEXTPLUS_DIR, "embeddings");
export const CONTEXTPLUS_CONFIG_DIR = join(CONTEXTPLUS_DIR, "config");
export const CONTEXTPLUS_CHECKPOINTS_DIR = join(CONTEXTPLUS_DIR, "checkpoints");
export const CONTEXTPLUS_DERIVED_DIR = join(CONTEXTPLUS_DIR, "derived");
export const CONTEXTPLUS_STATE_DIR = join(CONTEXTPLUS_DIR, "state");
export const CONTEXTPLUS_INDEX_DB_FILE = join(CONTEXTPLUS_STATE_DIR, "index.sqlite");

export interface ContextplusLayout {
  root: string;
  hubs: string;
  embeddings: string;
  config: string;
  checkpoints: string;
  derived: string;
  state: string;
}

export function getContextplusLayout(rootDir: string): ContextplusLayout {
  return {
    root: join(rootDir, CONTEXTPLUS_DIR),
    hubs: join(rootDir, CONTEXTPLUS_HUBS_DIR),
    embeddings: join(rootDir, CONTEXTPLUS_EMBEDDINGS_DIR),
    config: join(rootDir, CONTEXTPLUS_CONFIG_DIR),
    checkpoints: join(rootDir, CONTEXTPLUS_CHECKPOINTS_DIR),
    derived: join(rootDir, CONTEXTPLUS_DERIVED_DIR),
    state: join(rootDir, CONTEXTPLUS_STATE_DIR),
  };
}

export async function ensureContextplusLayout(rootDir: string): Promise<ContextplusLayout> {
  const layout = getContextplusLayout(rootDir);
  await mkdir(layout.root, { recursive: true });
  await mkdir(layout.hubs, { recursive: true });
  await mkdir(layout.embeddings, { recursive: true });
  await mkdir(layout.config, { recursive: true });
  await mkdir(layout.checkpoints, { recursive: true });
  await mkdir(layout.derived, { recursive: true });
  await mkdir(layout.state, { recursive: true });
  return layout;
}
