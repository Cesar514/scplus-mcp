import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

async function writeSuggestionMarkdown(rootDir, suggestion, linkedSuggestions) {
  const fullPath = join(rootDir, suggestion.markdownPath);
  await mkdir(dirname(fullPath), { recursive: true });
  const lines = [
    `# ${suggestion.label}`,
    "",
    suggestion.summary,
    "",
    `Suggested hub generated from persisted full-index artifacts.`,
    "",
    `- Rationale: ${suggestion.rationale}`,
    `- Modules: ${suggestion.modulePaths.join(", ") || "(none)"}`,
    `- Feature tags: ${suggestion.featureTags.join(", ") || "(none)"}`,
    "",
  ];
  for (const linked of linkedSuggestions) {
    lines.push(`@linked-to [[${linked.label}]]`);
  }
  if (linkedSuggestions.length > 0) lines.push("");
  for (const filePath of suggestion.filePaths) {
    lines.push(`[[${filePath}|Suggested because it anchors ${suggestion.label}]]`);
  }
  lines.push("");
  await writeFile(fullPath, lines.join("\n"), "utf8");
}

async function runSequential(rootDir, suggestions) {
  const start = performance.now();
  for (const suggestion of suggestions) {
    const linkedSuggestions = suggestion.linkedSuggestionIds
      .map((id) => suggestions.find(s => s.id === id))
      .filter(Boolean);
    await writeSuggestionMarkdown(rootDir, suggestion, linkedSuggestions);
  }
  return performance.now() - start;
}

async function runParallel(rootDir, suggestions) {
  const start = performance.now();
  await Promise.all(
    suggestions.map((suggestion) => {
      const linkedSuggestions = suggestion.linkedSuggestionIds
        .map((id) => suggestions.find(s => s.id === id))
        .filter(Boolean);
      return writeSuggestionMarkdown(rootDir, suggestion, linkedSuggestions);
    })
  );
  return performance.now() - start;
}

async function benchmark() {
  const rootDirSeq = await mkdtemp(join(tmpdir(), "benchmark-seq-"));
  const rootDirPar = await mkdtemp(join(tmpdir(), "benchmark-par-"));

  const numSuggestions = 100;
  const suggestions = Array.from({ length: numSuggestions }, (_, i) => ({
    id: `id-${i}`,
    label: `Label ${i}`,
    summary: `Summary for ${i}`,
    rationale: `Rationale for ${i}`,
    modulePaths: [`module/${i}`],
    featureTags: [`tag-${i}`],
    filePaths: [`file/${i}.ts`],
    linkedSuggestionIds: [i > 0 ? `id-${i-1}` : null].filter(Boolean),
    markdownPath: `suggested/suggestion-${i}.md`
  }));

  console.log(`Benchmarking with ${numSuggestions} suggestions...`);

  // Warm up
  await runSequential(rootDirSeq, suggestions);
  await rm(rootDirSeq, { recursive: true, force: true });
  const rootDirSeqActual = await mkdtemp(join(tmpdir(), "benchmark-seq-actual-"));

  const seqTime = await runSequential(rootDirSeqActual, suggestions);
  console.log(`Sequential time: ${seqTime.toFixed(2)}ms`);

  const parTime = await runParallel(rootDirPar, suggestions);
  console.log(`Parallel time: ${parTime.toFixed(2)}ms`);

  const improvement = ((seqTime - parTime) / seqTime) * 100;
  console.log(`Improvement: ${improvement.toFixed(2)}%`);

  // Correctness check
  const files = [
    join(rootDirPar, "suggested/suggestion-0.md"),
    join(rootDirPar, "suggested/suggestion-50.md"),
    join(rootDirPar, "suggested/suggestion-99.md")
  ];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (!content.includes("Suggested hub generated from persisted full-index artifacts.")) {
      throw new Error(`Correctness check failed for ${file}: content mismatch`);
    }
  }
  console.log("Correctness check passed!");

  await rm(rootDirSeqActual, { recursive: true, force: true });
  await rm(rootDirPar, { recursive: true, force: true });
}

benchmark().catch(console.error);
