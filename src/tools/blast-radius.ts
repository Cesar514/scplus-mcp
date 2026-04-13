// summary: Traces direct and reverse symbol usage across indexed and on-disk repository files.
// FEATURE: Symbol usage tracing across indexed and on-disk repository files.
// inputs: Target symbol names, repository files, and prepared index dependency data.
// outputs: Usage locations, dependency traces, and blast-radius summaries for a symbol.

import { walkDirectory } from "../core/walker.js";
import { isSupportedFile } from "../core/parser.js";
import { readFile } from "fs/promises";

const BLAST_RADIUS_READ_BATCH_SIZE = 32;

export interface BlastRadiusOptions {
  rootDir: string;
  symbolName: string;
  fileContext?: string;
}

export interface BlastRadiusUsage {
  file: string;
  line: number;
  context: string;
}

export interface BlastRadiusFileUsage {
  file: string;
  usages: BlastRadiusUsage[];
}

export interface BlastRadiusReport {
  symbolName: string;
  fileContext?: string;
  usageCount: number;
  fileCount: number;
  lowUsageWarning: boolean;
  files: BlastRadiusFileUsage[];
}

// Purpose: Render the blast-radius report into the terminal-facing summary format.
// Inputs: The structured blast-radius report for one symbol query.
// Returns/Effects: Returns the formatted human-readable blast-radius summary text.
export function formatBlastRadiusReport(report: BlastRadiusReport): string {
  if (report.usageCount === 0) return `Symbol "${report.symbolName}" is not used anywhere in the codebase.`;

  const lines: string[] = [
    `Blast radius for "${report.symbolName}": ${report.usageCount} usages in ${report.fileCount} files\n`,
  ];

  for (const fileUsage of report.files) {
    lines.push(`  ${fileUsage.file}:`);
    for (const usage of fileUsage.usages) {
      lines.push(`    L${usage.line}: ${usage.context}`);
    }
  }

  if (report.lowUsageWarning) {
    lines.push(`\n⚠ LOW USAGE: This symbol is used only ${report.usageCount} time(s). Consider inlining if it's under 20 lines.`);
  }

  return lines.join("\n");
}

// Purpose: Scan the repository for usages of one symbol and group them by file.
// Inputs: Blast-radius options including the root directory, symbol name, and optional definition file.
// Returns/Effects: Walks supported files, records symbol usages, and returns the grouped report.
export async function buildBlastRadiusReport(options: BlastRadiusOptions): Promise<BlastRadiusReport> {
  const entries = await walkDirectory({ rootDir: options.rootDir, depthLimit: 0 });
  const files = entries.filter((e) => !e.isDirectory && isSupportedFile(e.path));
  const usages: BlastRadiusUsage[] = [];

  for (let index = 0; index < files.length; index += BLAST_RADIUS_READ_BATCH_SIZE) {
    const batch = files.slice(index, index + BLAST_RADIUS_READ_BATCH_SIZE);
    const batchUsages = await Promise.all(
      batch.map(async (file) => {
        const fileUsages: BlastRadiusUsage[] = [];
        const content = await readFile(file.path, "utf-8");
        const lines = content.split("\n");
        const symbolPattern = new RegExp(`\\b${escapeRegex(options.symbolName)}\\b`, "g");

        for (let i = 0; i < lines.length; i++) {
          if (symbolPattern.test(lines[i])) {
            const isDefinition = options.fileContext && file.relativePath === options.fileContext && isDefinitionLine(lines[i], options.symbolName);
            if (!isDefinition) {
              fileUsages.push({
                file: file.relativePath,
                line: i + 1,
                context: lines[i].trim().substring(0, 120),
              });
            }
            symbolPattern.lastIndex = 0;
          }
        }

        return fileUsages;
      }),
    );
    usages.push(...batchUsages.flat());
  }

  const byFile = new Map<string, BlastRadiusUsage[]>();
  for (const u of usages) {
    const existing = byFile.get(u.file) ?? [];
    existing.push(u);
    byFile.set(u.file, existing);
  }

  return {
    symbolName: options.symbolName,
    fileContext: options.fileContext,
    usageCount: usages.length,
    fileCount: byFile.size,
    lowUsageWarning: usages.length <= 1,
    files: Array.from(byFile.entries()).map(([file, fileUsages]) => ({
      file,
      usages: fileUsages,
    })),
  };
}

// Purpose: Produce the formatted blast-radius output for a symbol query.
// Inputs: Blast-radius options including the root directory, symbol name, and optional definition file.
// Returns/Effects: Builds the structured report and returns its formatted text.
export async function getBlastRadius(options: BlastRadiusOptions): Promise<string> {
  return formatBlastRadiusReport(await buildBlastRadiusReport(options));
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Purpose: Detect whether a line appears to declare the queried symbol instead of using it.
// Inputs: One source line plus the symbol name being searched.
// Returns/Effects: Returns true when the line matches one of the supported definition patterns.
function isDefinitionLine(line: string, symbolName: string): boolean {
  const definitionPatterns = [
    new RegExp(`(?:function|class|enum|interface|struct|type|trait|fn|def|func)\\s+${escapeRegex(symbolName)}`),
    new RegExp(`(?:const|let|var|pub|export)\\s+(?:async\\s+)?(?:function\\s+)?${escapeRegex(symbolName)}`),
  ];
  return definitionPatterns.some((p) => p.test(line));
}
