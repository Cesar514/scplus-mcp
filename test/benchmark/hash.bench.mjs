import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { performance } from "perf_hooks";
import { computeFileContentHash } from "../../build/tools/invalidation.js";

const BENCH_DIR = join(process.cwd(), "test_benchmark_files");
const NUM_FILES = 500;

async function setup() {
  await rm(BENCH_DIR, { recursive: true, force: true });
  await mkdir(BENCH_DIR, { recursive: true });

  const promises = [];
  for (let i = 0; i < NUM_FILES; i++) {
    // Write 100KB files
    const content = Buffer.alloc(1024 * 100, Math.random().toString());
    promises.push(writeFile(join(BENCH_DIR, `file_${i}.txt`), content));
  }
  await Promise.all(promises);
}

async function teardown() {
  await rm(BENCH_DIR, { recursive: true, force: true });
}

async function runSequential(files) {
  const contentHashes = {};
  const start = performance.now();
  for (const file of files) {
    contentHashes[file.relativePath] = await computeFileContentHash(file.path);
  }
  return performance.now() - start;
}

async function runConcurrent(files) {
  const contentHashes = {};
  const start = performance.now();
  await Promise.all(
    files.map(async (file) => {
      contentHashes[file.relativePath] = await computeFileContentHash(file.path);
    })
  );
  return performance.now() - start;
}

async function main() {
  console.log("Setting up benchmark...");
  await setup();

  const files = [];
  for (let i = 0; i < NUM_FILES; i++) {
    files.push({
      relativePath: `file_${i}.txt`,
      path: join(BENCH_DIR, `file_${i}.txt`)
    });
  }

  // Warmup
  await runSequential(files);
  await runConcurrent(files);

  console.log("Running Sequential...");
  const seqTime = await runSequential(files);

  console.log("Running Concurrent...");
  const concTime = await runConcurrent(files);

  console.log(`\nResults for ${NUM_FILES} files (100KB each):`);
  console.log(`Sequential: ${seqTime.toFixed(2)} ms`);
  console.log(`Concurrent: ${concTime.toFixed(2)} ms`);
  console.log(`Speedup: ${(seqTime / concTime).toFixed(2)}x`);

  await teardown();
}

main().catch(console.error);
