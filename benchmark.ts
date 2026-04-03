import { walkDirectory } from "./build/core/walker.js";
import { performance } from "perf_hooks";

async function runBenchmark() {
  let totalTime = 0;
  const iterations = 50;

  // Warmup
  await walkDirectory({ rootDir: "/tmp/test_dir" });

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await walkDirectory({ rootDir: "/tmp/test_dir" });
    const end = performance.now();
    totalTime += (end - start);
  }
  console.log(`Average time taken: ${totalTime / iterations} ms`);
}

runBenchmark();
