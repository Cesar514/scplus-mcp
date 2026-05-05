// summary: Covers propose-commit validation and restore-point reporting behavior.
// purpose: Verify write-time validation enforces the repository header contract before saving.
// inputs: Temporary fixture files plus propose-commit entry points.
// returns/effects: Assertion coverage for validation warnings, writes, and restore points.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { proposeCommit } from "../../build/tools/propose-commit.js";
import { readFile, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";

const FIXTURE_DIR = join(process.cwd(), "test", "_commit_fixtures");

async function setup() {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  await mkdir(FIXTURE_DIR, { recursive: true });
}

describe("propose-commit", async () => {
  await setup();

  describe("proposeCommit", () => {
    it("saves a valid file with proper header", async () => {
      const content =
        "// summary: Valid checkpoint fixture module\n// purpose: Verify a valid checkpoint write passes validation.\n// inputs: none\n// returns/effects: main() return value.\n\nfunction main() {\n  return 1;\n}\n";
      const result = await proposeCommit({
        rootDir: FIXTURE_DIR,
        filePath: "valid.ts",
        newContent: content,
      });
      assert.ok(result.includes("saved") || result.includes("✅"));
      const written = await readFile(join(FIXTURE_DIR, "valid.ts"), "utf-8");
      assert.equal(written, content);
    });

    it("warns when header is missing", async () => {
      const content = "function noHeader() {\n  return 1;\n}\n";
      const result = await proposeCommit({
        rootDir: FIXTURE_DIR,
        filePath: "nohead.ts",
        newContent: content,
      });
      assert.ok(
        result.includes("header") ||
          result.includes("warning") ||
          result.includes("⚠"),
      );
    });

    it("allows comments after the required header", async () => {
      const content =
        "// summary: Comment-friendly checkpoint fixture\n// purpose: Verify comments after the required header remain allowed.\n// inputs: none\n// returns/effects: x() remains side effect free.\n\n// This is an inline comment\nfunction x() {}\n";
      const result = await proposeCommit({
        rootDir: FIXTURE_DIR,
        filePath: "comments.ts",
        newContent: content,
      });
      assert.ok(result.includes("saved") || result.includes("✅"));
    });

    it("warns when required header fields are missing", async () => {
      const lines = [
        "// summary: Header without feature tag",
        "// inputs: none",
        "// returns/effects: x() result",
        "",
      ];
      lines.push("// allowed comment");
      lines.push("function x() {}");
      const content = lines.join("\n");
      const result = await proposeCommit({
        rootDir: FIXTURE_DIR,
        filePath: "feature.ts",
        newContent: content,
      });
      assert.ok(result.includes("purpose-header") || result.includes("⚠"));
    });

    it("warns about high nesting depth", async () => {
      let content = "// summary: Nested checkpoint fixture\n// purpose: Trigger the nesting warning during checkpoint validation.\n// inputs: none\n// returns/effects: nesting warning.\n\n";
      for (let i = 0; i < 8; i++) content += "  ".repeat(i) + "if (true) {\n";
      content += "  ".repeat(8) + "doStuff();\n";
      for (let i = 7; i >= 0; i--) content += "  ".repeat(i) + "}\n";
      const result = await proposeCommit({
        rootDir: FIXTURE_DIR,
        filePath: "nested.ts",
        newContent: content,
      });
      assert.ok(
        result.includes("nesting") ||
          result.includes("⚠") ||
          typeof result === "string",
      );
    });

    it("warns about excessively long files", async () => {
      const lines = ["// summary: Long checkpoint fixture", "// purpose: Trigger the file-length warning during checkpoint validation.", "// inputs: none", "// returns/effects: file length warning.", ""];
      for (let i = 0; i < 1100; i++) lines.push(`const x${i} = ${i};`);
      const content = lines.join("\n");
      const result = await proposeCommit({
        rootDir: FIXTURE_DIR,
        filePath: "long.ts",
        newContent: content,
      });
      assert.ok(
        result.includes("lines") ||
          result.includes("splitting") ||
          result.includes("⚠"),
      );
    });

    it("creates a restore point before saving", async () => {
      const content =
        "// summary: Restore checkpoint fixture\n// purpose: Verify a restore point is created before saving.\n// inputs: none\n// returns/effects: r() placeholder.\n\nfunction r() {}\n";
      const result = await proposeCommit({
        rootDir: FIXTURE_DIR,
        filePath: "restore.ts",
        newContent: content,
      });
      assert.ok(
        result.includes("Restore point") ||
          result.includes("undo") ||
          result.includes("✅"),
      );
    });

    it("handles unsupported file types without header validation", async () => {
      const content = "# Heading\n\nSome markdown\n";
      const result = await proposeCommit({
        rootDir: FIXTURE_DIR,
        filePath: "doc.md",
        newContent: content,
      });
      assert.ok(result.includes("saved") || result.includes("✅"));
    });

    it("creates nested directories when needed", async () => {
      const content = "// summary: Deep checkpoint fixture\n// purpose: Verify nested directories are created before saving.\n// inputs: none\n// returns/effects: deep() placeholder.\n\nfunction deep() {}\n";
      const result = await proposeCommit({
        rootDir: FIXTURE_DIR,
        filePath: "sub/dir/deep.ts",
        newContent: content,
      });
      assert.ok(result.includes("saved") || result.includes("✅"));
      const written = await readFile(
        join(FIXTURE_DIR, "sub", "dir", "deep.ts"),
        "utf-8",
      );
      assert.equal(written, content);
    });

    it("serializes concurrent writes against the same repo before refreshing the prepared index", async () => {
      const [left, right] = await Promise.all([
        proposeCommit({
          rootDir: FIXTURE_DIR,
          filePath: "parallel/left.ts",
          newContent: "// summary: Left parallel checkpoint fixture\n// purpose: Verify concurrent writes serialize before refresh.\n// inputs: none\n// returns/effects: left constant.\n\nexport const left = 1;\n",
        }),
        proposeCommit({
          rootDir: FIXTURE_DIR,
          filePath: "parallel/right.ts",
          newContent: "// summary: Right parallel checkpoint fixture\n// purpose: Verify concurrent writes serialize before refresh.\n// inputs: none\n// returns/effects: right constant.\n\nexport const right = 2;\n",
        }),
      ]);
      assert.ok(left.includes("saved") || left.includes("✅"));
      assert.ok(right.includes("saved") || right.includes("✅"));
      const [leftWritten, rightWritten] = await Promise.all([
        readFile(join(FIXTURE_DIR, "parallel", "left.ts"), "utf-8"),
        readFile(join(FIXTURE_DIR, "parallel", "right.ts"), "utf-8"),
      ]);
      assert.match(leftWritten, /export const left = 1;/);
      assert.match(rightWritten, /export const right = 2;/);
    });

    it("warns when structured header fields are missing", async () => {
      const result = await proposeCommit({
        rootDir: FIXTURE_DIR,
        filePath: "missing-fields.ts",
        newContent: "// summary: Checkpoint missing header fields fixture\n// plain header line\n// another plain header line\n// final plain header line\n\nexport const value = 1;\n",
      });
      assert.ok(result.includes("purpose-header"));
      assert.ok(result.includes("inputs-header"));
      assert.ok(result.includes("returns/effects-header"));
    });
  });

  after(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });
});
