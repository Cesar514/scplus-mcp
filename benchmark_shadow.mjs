import { createRestorePoint } from "./build/git/shadow.js";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";

const FIXTURE_DIR = join(process.cwd(), "test", "_shadow_benchmark_fixtures");

async function setup(numFiles) {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  await mkdir(FIXTURE_DIR, { recursive: true });
  const files = [];
  for (let i = 0; i < numFiles; i++) {
    const fileName = `file${i}.txt`;
    await writeFile(join(FIXTURE_DIR, fileName), `content ${i}`);
    files.push(fileName);
  }
  return files;
}

async function runBenchmark() {
  const numFiles = 1000;
  const files = await setup(numFiles);

  const start = performance.now();
  await createRestorePoint(FIXTURE_DIR, files, "benchmark backup");
  const end = performance.now();

  console.log(`createRestorePoint with ${numFiles} files took ${(end - start).toFixed(2)} ms`);

  await rm(FIXTURE_DIR, { recursive: true, force: true });
}

runBenchmark().catch(console.error);
