// Context+ project layout definitions for durable repo-local state
// FEATURE: Project state paths for config, embeddings, memories, checkpoints

import { mkdir } from "fs/promises";
import { join } from "path";

export const CONTEXTPLUS_DIR = ".contextplus";
export const CONTEXTPLUS_HUBS_DIR = join(CONTEXTPLUS_DIR, "hubs");
export const CONTEXTPLUS_EMBEDDINGS_DIR = join(CONTEXTPLUS_DIR, "embeddings");
export const CONTEXTPLUS_MEMORIES_DIR = join(CONTEXTPLUS_DIR, "memories");
export const CONTEXTPLUS_CONFIG_DIR = join(CONTEXTPLUS_DIR, "config");
export const CONTEXTPLUS_CHECKPOINTS_DIR = join(CONTEXTPLUS_DIR, "checkpoints");

export interface ContextplusLayout {
  root: string;
  hubs: string;
  embeddings: string;
  memories: string;
  config: string;
  checkpoints: string;
}

export function getContextplusLayout(rootDir: string): ContextplusLayout {
  return {
    root: join(rootDir, CONTEXTPLUS_DIR),
    hubs: join(rootDir, CONTEXTPLUS_HUBS_DIR),
    embeddings: join(rootDir, CONTEXTPLUS_EMBEDDINGS_DIR),
    memories: join(rootDir, CONTEXTPLUS_MEMORIES_DIR),
    config: join(rootDir, CONTEXTPLUS_CONFIG_DIR),
    checkpoints: join(rootDir, CONTEXTPLUS_CHECKPOINTS_DIR),
  };
}

export async function ensureContextplusLayout(rootDir: string): Promise<ContextplusLayout> {
  const layout = getContextplusLayout(rootDir);
  await mkdir(layout.root, { recursive: true });
  await mkdir(layout.hubs, { recursive: true });
  await mkdir(layout.embeddings, { recursive: true });
  await mkdir(layout.memories, { recursive: true });
  await mkdir(layout.config, { recursive: true });
  await mkdir(layout.checkpoints, { recursive: true });
  return layout;
}
