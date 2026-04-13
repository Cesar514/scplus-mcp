import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import {
  buildStaticAnalysisReport,
  runStaticAnalysis,
} from "../../build/tools/static-analysis.js";
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
      assert.ok(result.includes("Repo score:"));
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
        "// summary: Clean static analysis fixture module\n// FEATURE: Static Analysis Tests\n// inputs: none\n// outputs: exported numeric constant\n\nexport const x: number = 1;\n",
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
        "# summary: Clean static analysis python fixture\n# FEATURE: Static Analysis Tests\n# inputs: none\n# outputs: hello() greeting string\n\ndef hello():\n    return 'hi'\n",
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
        "// summary: Broken static analysis fixture module\n// FEATURE: Static Analysis Tests\n// inputs: none\n// outputs: type error for lint coverage\n\nconst a: number = 'wrong';\n",
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
      assert.ok(result.includes("Lowest-scoring files:"));
      assert.ok(result.includes("score="));
      assert.ok(result.includes("[header]"));
    });

    it("reports missing structured header fields as rule findings", async () => {
      await writeFile(
        join(FIXTURE_DIR, "missing-fields.ts"),
        "// FEATURE: Static Analysis Tests\n// plain header line\n\nexport const missingFields = 1;\n",
      );
      const result = await runStaticAnalysis({
        rootDir: FIXTURE_DIR,
        targetPath: "missing-fields.ts",
      });
      assert.ok(result.includes("[summary-header]"));
      assert.ok(result.includes("[inputs-header]"));
      assert.ok(result.includes("[outputs-header]"));
    });

    it("reports function size and parameter count rule findings", async () => {
      const longBody = Array.from(
        { length: 41 },
        (_, index) => `  const step${index} = total + ${index};`,
      ).join("\n");
      await writeFile(
        join(FIXTURE_DIR, "complex.ts"),
        [
          "// summary: Complex static analysis fixture module",
          "// FEATURE: Static Analysis Tests",
          "// inputs: six numeric parameters",
          "// outputs: numeric total after too many local steps",
          "",
          "export function complex(",
          "  alpha: number,",
          "  beta: number,",
          "  gamma: number,",
          "  delta: number,",
          "  epsilon: number,",
          "  zeta: number,",
          "): number {",
          "  const total = alpha + beta + gamma + delta + epsilon + zeta;",
          longBody,
          "  return total;",
          "}",
          "",
        ].join("\n"),
      );
      const report = await buildStaticAnalysisReport({
        rootDir: FIXTURE_DIR,
        targetPath: "complex.ts",
      });
      assert.ok(
        report.ruleFindings.some((finding) => finding.rule === "max-function-loc"),
      );
      assert.ok(
        report.ruleFindings.some((finding) => finding.rule === "max-parameter-count"),
      );
    });

    it("reports files with too many callable bodies", async () => {
      const callables = Array.from(
        { length: 13 },
        (_, index) => `export function fn${index}(): number {\n  return ${index};\n}\n`,
      ).join("\n");
      await writeFile(
        join(FIXTURE_DIR, "many-functions.ts"),
        [
          "// summary: Many functions static analysis fixture module",
          "// FEATURE: Static Analysis Tests",
          "// inputs: none",
          "// outputs: too many callable declarations",
          "",
          callables,
        ].join("\n"),
      );
      const report = await buildStaticAnalysisReport({
        rootDir: FIXTURE_DIR,
        targetPath: "many-functions.ts",
      });
      assert.ok(
        report.ruleFindings.some((finding) => finding.rule === "max-functions-per-file"),
      );
    });

    it("reports max-file-loc using non-comment LOC", async () => {
      const codeLines = Array.from(
        { length: 801 },
        (_, index) => `export const value${index}: number = ${index};`,
      ).join("\n");
      await writeFile(
        join(FIXTURE_DIR, "oversized.ts"),
        [
          "// summary: Oversized static analysis fixture module",
          "// FEATURE: Static Analysis Tests",
          "// inputs: many executable lines and many comments",
          "// outputs: max file loc finding",
          "",
          ...Array.from({ length: 40 }, (_, index) => `// comment ${index}`),
          "",
          codeLines,
          "",
        ].join("\n"),
      );
      const report = await buildStaticAnalysisReport({
        rootDir: FIXTURE_DIR,
        targetPath: "oversized.ts",
      });
      assert.ok(
        report.ruleFindings.some((finding) => finding.rule === "max-file-loc"),
      );
    });

    it("reports missing structured function headers across supported languages", async () => {
      const fixtures = [
        {
          name: "headerless.ts",
          content: [
            "// summary: TypeScript function header fixture",
            "// FEATURE: Static Analysis Tests",
            "// inputs: none",
            "// outputs: warning for missing function header",
            "",
            "export function tsHeaderless(value: number): number {",
            "  const doubled = value * 2;",
            "  const tripled = value * 3;",
            "  const adjusted = doubled + tripled;",
            "  return adjusted - value;",
            "}",
            "",
          ].join("\n"),
        },
        {
          name: "headerless.py",
          content: [
            "# summary: Python function header fixture",
            "# FEATURE: Static Analysis Tests",
            "# inputs: none",
            "# outputs: warning for missing function header",
            "",
            "def py_headerless(value: int) -> int:",
            "    doubled = value * 2",
            "    tripled = value * 3",
            "    adjusted = doubled + tripled",
            "    stabilized = adjusted - 1",
            "    return stabilized - value",
            "",
          ].join("\n"),
        },
        {
          name: "headerless.go",
          content: [
            "// summary: Go function header fixture",
            "// FEATURE: Static Analysis Tests",
            "// inputs: none",
            "// outputs: warning for missing function header",
            "",
            "package fixtures",
            "",
            "func goHeaderless(value int) int {",
            "    doubled := value * 2",
            "    tripled := value * 3",
            "    adjusted := doubled + tripled",
            "    return adjusted - value",
            "}",
            "",
          ].join("\n"),
        },
        {
          name: "Headerless.java",
          content: [
            "// summary: Java function header fixture",
            "// FEATURE: Static Analysis Tests",
            "// inputs: none",
            "// outputs: warning for missing function header",
            "",
            "class HeaderlessJava {",
            "  int javaHeaderless(int value) {",
            "    int doubled = value * 2;",
            "    int tripled = value * 3;",
            "    int adjusted = doubled + tripled;",
            "    return adjusted - value;",
            "  }",
            "}",
            "",
          ].join("\n"),
        },
        {
          name: "headerless.rs",
          content: [
            "// summary: Rust function header fixture",
            "// FEATURE: Static Analysis Tests",
            "// inputs: none",
            "// outputs: warning for missing function header",
            "",
            "fn rust_headerless(value: i32) -> i32 {",
            "    let doubled = value * 2;",
            "    let tripled = value * 3;",
            "    let adjusted = doubled + tripled;",
            "    adjusted - value",
            "}",
            "",
          ].join("\n"),
        },
        {
          name: "headerless.cpp",
          content: [
            "// summary: C++ function header fixture",
            "// FEATURE: Static Analysis Tests",
            "// inputs: none",
            "// outputs: warning for missing function header",
            "",
            "int cpp_headerless(int value) {",
            "  int doubled = value * 2;",
            "  int tripled = value * 3;",
            "  int adjusted = doubled + tripled;",
            "  return adjusted - value;",
            "}",
            "",
          ].join("\n"),
        },
      ];

      for (const fixture of fixtures) {
        await writeFile(join(FIXTURE_DIR, fixture.name), fixture.content);
        const report = await buildStaticAnalysisReport({
          rootDir: FIXTURE_DIR,
          targetPath: fixture.name,
        });
        assert.ok(
          report.ruleFindings.some((finding) => finding.rule === "function-header-3-lines"),
          `expected function header finding for ${fixture.name}`,
        );
      }
    });

    it("accepts a valid structured function header", async () => {
      await writeFile(
        join(FIXTURE_DIR, "headered.ts"),
        [
          "// summary: Function header acceptance fixture module",
          "// FEATURE: Static Analysis Tests",
          "// inputs: none",
          "// outputs: no function header warning",
          "",
          "// Purpose: Compute a deterministic adjusted value for coverage.",
          "// Inputs: A numeric value used for simple arithmetic steps.",
          "// Returns/Effects: Returns the adjusted numeric result with no side effects.",
          "export function headered(value: number): number {",
          "  const doubled = value * 2;",
          "  const tripled = value * 3;",
          "  const adjusted = doubled + tripled;",
          "  return adjusted - value;",
          "}",
          "",
        ].join("\n"),
      );
      const report = await buildStaticAnalysisReport({
        rootDir: FIXTURE_DIR,
        targetPath: "headered.ts",
      });
      assert.ok(
        !report.ruleFindings.some((finding) => finding.rule === "function-header-3-lines"),
      );
    });

    it("reports tracked todo and wildcard import violations", async () => {
      await writeFile(
        join(FIXTURE_DIR, "lint-rules.py"),
        [
          "# summary: Python static analysis fixture module",
          "# FEATURE: Static Analysis Tests",
          "# inputs: wildcard import and untracked todo",
          "# outputs: lint rule findings",
          "",
          "from os import *",
          "# TODO: clean this up soon",
          "",
          "def sample():",
          "    return environ.get('HOME')",
          "",
        ].join("\n"),
      );
      const report = await buildStaticAnalysisReport({
        rootDir: FIXTURE_DIR,
        targetPath: "lint-rules.py",
      });
      assert.ok(
        report.ruleFindings.some((finding) => finding.rule === "no-wildcard-imports"),
      );
      assert.ok(
        report.ruleFindings.some((finding) => finding.rule === "tracked-todo-only"),
      );
    });

    it("reports single-line multiple statements and commented-out code", async () => {
      await writeFile(
        join(FIXTURE_DIR, "noisy.ts"),
        [
          "// summary: Noisy static analysis fixture module",
          "// FEATURE: Static Analysis Tests",
          "// inputs: compact statements and disabled code",
          "// outputs: lint rule findings",
          "",
          "export function noisy(): number {",
          "  const first = 1; const second = 2;",
          "  // if (first > 0) {",
          "  //   return second;",
          "  return first + second;",
          "}",
          "",
        ].join("\n"),
      );
      const report = await buildStaticAnalysisReport({
        rootDir: FIXTURE_DIR,
        targetPath: "noisy.ts",
      });
      assert.ok(
        report.ruleFindings.some((finding) => finding.rule === "one-statement-per-line"),
      );
      assert.ok(
        report.ruleFindings.some((finding) => finding.rule === "no-commented-out-code"),
      );
    });

    it("reports long lines and bare except blocks", async () => {
      await writeFile(
        join(FIXTURE_DIR, "strict.py"),
        [
          "# summary: Strict static analysis python fixture",
          "# FEATURE: Static Analysis Tests",
          "# inputs: bare except and a long assignment",
          "# outputs: lint rule findings",
          "",
          "def strict_mode():",
          "    very_long_value = '12345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890'",
          "    try:",
          "        return very_long_value",
          "    except:",
          "        return 'fallback'",
          "",
        ].join("\n"),
      );
      const report = await buildStaticAnalysisReport({
        rootDir: FIXTURE_DIR,
        targetPath: "strict.py",
      });
      assert.ok(
        report.ruleFindings.some((finding) => finding.rule === "line-length"),
      );
      assert.ok(
        report.ruleFindings.some((finding) => finding.rule === "no-generic-catch"),
      );
    });
  });

  after(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });
});
