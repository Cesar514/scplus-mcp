#!/usr/bin/env node
// summary: Executes the built human CLI binary from the npm-linked launcher entrypoint.
// FEATURE: Global npm-linked entrypoint for the Bubble Tea terminal app.
// inputs: Process arguments, packaged binary locations, and launcher environment state.
// outputs: Spawned human CLI process execution and propagated exit status.

import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function main(): Promise<void> {
  const buildDir = dirname(fileURLToPath(import.meta.url));
  const binaryName = process.platform === "win32" ? "contextplusplus-cli.exe" : "contextplusplus-cli";
  const binaryPath = resolve(buildDir, binaryName);
  await access(binaryPath, constants.X_OK);
  const child = spawn(binaryPath, process.argv.slice(2), {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
  child.on("error", (error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
