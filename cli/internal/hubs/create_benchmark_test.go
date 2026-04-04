// summary: Benchmarks alternative string-building strategies for hub markdown generation.
// FEATURE: measures concat versus fmt.Sprintf hub line construction on large file lists.
// inputs: Synthetic hub titles, summaries, and repeated dummy file paths.
// outputs: Benchmark timing for old and new hub markdown builders.

package hubs

import (
	"fmt"
	"strings"
	"testing"
)

var dummyFiles []string

func init() {
	for i := 0; i < 1000; i++ {
		dummyFiles = append(dummyFiles, fmt.Sprintf("path/to/dummy/file_%d.ts", i))
	}
}

func BuildHubMarkdownOld(title, summary string, files []string) string {
	lines := []string{
		fmt.Sprintf("# %s", strings.TrimSpace(title)),
		"",
		strings.TrimSpace(summary),
		"",
		"Human-authored hub created from the scplus-cli.",
		"",
	}
	for _, filePath := range files {
		lines = append(lines, fmt.Sprintf("- [[%s]]", filePath))
	}
	lines = append(lines, "")
	return strings.Join(lines, "\n")
}

func BuildHubMarkdownNew(title, summary string, files []string) string {
	lines := []string{
		fmt.Sprintf("# %s", strings.TrimSpace(title)),
		"",
		strings.TrimSpace(summary),
		"",
		"Human-authored hub created from the scplus-cli.",
		"",
	}
	for _, filePath := range files {
		lines = append(lines, "- [["+filePath+"]]")
	}
	lines = append(lines, "")
	return strings.Join(lines, "\n")
}

func BenchmarkBuildHubMarkdown_Sprintf(b *testing.B) {
	title := "My title"
	summary := "My summary"
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		BuildHubMarkdownOld(title, summary, dummyFiles)
	}
}

func BenchmarkBuildHubMarkdown_Concat(b *testing.B) {
	title := "My title"
	summary := "My summary"
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		BuildHubMarkdownNew(title, summary, dummyFiles)
	}
}
