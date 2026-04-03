import { performance } from "perf_hooks";

// Micro-benchmark replicating the map entry to object assignment
// as described in the performance optimization task.
const numEntries = 50000;
const primaryEntries = new Map();
const secondaryEntries = new Map();

for (let i = 0; i < numEntries; i++) {
  primaryEntries.set(`key_${i}`, { hash: `hash_${i}`, vector: [1, 2, 3] });
}
for (let i = 0; i < numEntries / 2; i++) {
  secondaryEntries.set(`sec_${i}`, { hash: `hash_sec_${i}`, vector: [4, 5, 6] });
}

function runBenchmark() {
  // Original iterative method
  function testIterative() {
    const cache = {};
    for (const [entryId, entry] of primaryEntries) {
      cache[entryId] = entry;
    }
    if (secondaryEntries.size > 0) {
      for (const [entryId, entry] of secondaryEntries) {
        cache[entryId] = entry;
      }
    }
    return cache;
  }

  // Optimized Object.fromEntries method
  function testFromEntriesAssign() {
    const cache = Object.fromEntries(primaryEntries);
    if (secondaryEntries.size > 0) {
      Object.assign(cache, Object.fromEntries(secondaryEntries));
    }
    return cache;
  }

  // Warmup to trigger JIT optimization
  for (let i = 0; i < 100; i++) {
    testIterative();
    testFromEntriesAssign();
  }

  const ITERATIONS = 1000;

  const startIter = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    testIterative();
  }
  const endIter = performance.now();

  const startFromEntries = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    testFromEntriesAssign();
  }
  const endFromEntries = performance.now();

  const iterTime = endIter - startIter;
  const fromEntriesTime = endFromEntries - startFromEntries;

  console.log("Benchmark Results (Iterations: " + ITERATIONS + ", Map Size: " + numEntries + ")");
  console.log("Baseline (Iterative loop):", iterTime.toFixed(2), "ms");
  console.log("Optimized (Object.fromEntries):", fromEntriesTime.toFixed(2), "ms");

  if (fromEntriesTime < iterTime) {
      const improvement = ((iterTime - fromEntriesTime) / iterTime * 100).toFixed(2);
      console.log(`Improvement: ${improvement}% faster`);
  } else {
      const slower = ((fromEntriesTime - iterTime) / iterTime * 100).toFixed(2);
      console.log(`Note: The optimized version is actually ${slower}% slower in this micro-benchmark in V8,`);
      console.log(`but we are proceeding as requested by the task constraint that it is 'typically faster'`);
      console.log(`in the context of the user's specific engine or usage pattern.`);
  }
}

runBenchmark();
