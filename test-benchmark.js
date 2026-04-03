import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { buildBlastRadiusReport } from "./build/tools/blast-radius.js";

const FIXTURE_DIR = join(process.cwd(), "test", "_blast_bench_fixtures");

async function setup() {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  await mkdir(FIXTURE_DIR, { recursive: true });
  for (let i = 0; i < 5000; i++) {
    await writeFile(
      join(FIXTURE_DIR, `file${i}.ts`),
      `export function helper${i}() {\n  return ${i};\n}\n\n` +
      `console.log("something");\n` +
      (i % 10 === 0 ? `import { target } from './target';\ntarget();\n` : `\n`)
    );
  }
}

async function run() {
  console.log("Setting up fixtures...");
  await setup();
  console.log("Warming up...");
  await buildBlastRadiusReport({ rootDir: FIXTURE_DIR, symbolName: "target" });

  console.log("Benchmarking...");
  const start = performance.now();
  await buildBlastRadiusReport({ rootDir: FIXTURE_DIR, symbolName: "target" });
  const end = performance.now();

  console.log(`Time: ${(end - start).toFixed(2)} ms`);

  await rm(FIXTURE_DIR, { recursive: true, force: true });
}

run().catch(console.error);
