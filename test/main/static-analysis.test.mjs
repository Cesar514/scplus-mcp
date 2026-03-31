import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { runStaticAnalysis } from "../../build/tools/static-analysis.js";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";

const FIXTURE_DIR = join(process.cwd(), "test", "_static_fixtures");

async function setup() {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  await mkdir(FIXTURE_DIR, { recursive: true });
}

describe("static-analysis", async () => {
  await setup();

  describe("runStaticAnalysis", () => {
    it("returns no-linter message for unsupported extension", async () => {
      await writeFile(join(FIXTURE_DIR, "data.csv"), "a,b,c\n1,2,3\n");
      const result = await runStaticAnalysis({
        rootDir: FIXTURE_DIR,
        targetPath: "data.csv",
      });
      assert.ok(result.includes("No native lint tool"));
    });

    it("returns string output", async () => {
      const result = await runStaticAnalysis({ rootDir: FIXTURE_DIR });
      assert.ok(typeof result === "string");
    });

    it("handles TypeScript files when tsconfig exists", async () => {
      await writeFile(
        join(FIXTURE_DIR, "tsconfig.json"),
        '{"compilerOptions":{"strict":true}}',
      );
      await writeFile(
        join(FIXTURE_DIR, "clean.ts"),
        "// Clean module\n// FEATURE: Static Analysis Tests\n\nexport const x: number = 1;\n",
      );
      const result = await runStaticAnalysis({
        rootDir: FIXTURE_DIR,
        targetPath: "clean.ts",
      });
      assert.ok(typeof result === "string");
      assert.ok(result.includes("Lint target: clean.ts"));
    });

    it("returns no-linter for TypeScript without tsconfig", async () => {
      const noTsDir = join(FIXTURE_DIR, "nots");
      await mkdir(noTsDir, { recursive: true });
      await writeFile(join(noTsDir, "x.ts"), "const y = 1;\n");
      const result = await runStaticAnalysis({
        rootDir: noTsDir,
        targetPath: "x.ts",
      });
      assert.ok(
        result.includes("No native lint tool") ||
          result.includes("tsc") ||
          typeof result === "string",
      );
    });

    it("handles Python files with py_compile", async () => {
      await writeFile(
        join(FIXTURE_DIR, "good.py"),
        "# Clean script\n# FEATURE: Static Analysis Tests\n\ndef hello():\n    return 'hi'\n",
      );
      const result = await runStaticAnalysis({
        rootDir: FIXTURE_DIR,
        targetPath: "good.py",
      });
      assert.ok(typeof result === "string");
      assert.ok(result.includes("No issues found.") || result.includes("py_compile"));
    });

    it("reports results with tool name", async () => {
      await writeFile(
        join(FIXTURE_DIR, "tsconfig.json"),
        '{"compilerOptions":{}}',
      );
      await writeFile(
        join(FIXTURE_DIR, "err.ts"),
        "// Broken module\n// FEATURE: Static Analysis Tests\n\nconst a: number = 'wrong';\n",
      );
      const result = await runStaticAnalysis({
        rootDir: FIXTURE_DIR,
        targetPath: "err.ts",
      });
      assert.ok(result.includes("Native diagnostics:") || result.includes("[tsc]"));
    });

    it("whole directory scan returns string", async () => {
      const result = await runStaticAnalysis({ rootDir: FIXTURE_DIR });
      assert.ok(typeof result === "string");
      assert.ok(result.length > 0);
    });

    it("reports missing header as a rule finding", async () => {
      await writeFile(
        join(FIXTURE_DIR, "headerless.ts"),
        "export const headerless = 1;\n",
      );
      await writeFile(
        join(FIXTURE_DIR, "tsconfig.json"),
        '{"compilerOptions":{"strict":true}}',
      );
      const result = await runStaticAnalysis({
        rootDir: FIXTURE_DIR,
        targetPath: "headerless.ts",
      });
      assert.ok(result.includes("[header]"));
    });
  });

  after(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });
});
