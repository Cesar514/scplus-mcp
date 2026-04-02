package ui

import (
	"strings"
	"testing"

	"contextplus/cli/internal/backend"
)

func TestRenderDoctorPlainIncludesCoreSections(t *testing.T) {
	report := backend.DoctorReport{
		Root: "/tmp/contextplus",
		RepoStatus: backend.RepoStatusSummary{
			Branch:         "main",
			UnstagedCount:  2,
			UntrackedCount: 1,
		},
		IndexValidation:   backend.IndexValidationReport{OK: true},
		RestorePointCount: 3,
	}
	report.HubSummary.SuggestionCount = 4
	report.Ollama.OK = true
	report.Ollama.Models = []backend.OllamaRuntimeModel{{Name: "qwen3-embedding:0.6b-32k"}}
	report.TreeSitter.TotalParseFailures = 2
	report.HybridVectors.Chunk.VectorCoverage.LoadedVectorCount = 3
	report.HybridVectors.Chunk.VectorCoverage.RequestedVectorCount = 3
	report.HybridVectors.Chunk.VectorCoverage.State = "complete"
	report.HybridVectors.Identifier.VectorCoverage.LoadedVectorCount = 2
	report.HybridVectors.Identifier.VectorCoverage.RequestedVectorCount = 2
	report.HybridVectors.Identifier.VectorCoverage.State = "complete"

	rendered := RenderDoctorPlain(report)
	for _, needle := range []string{
		"Context+ CLI doctor for /tmp/contextplus",
		"Branch: main",
		"Prepared index: OK",
		"Ollama: 1 running models",
		"Hub suggestions: 4",
		"Restore points: 3",
		"Hybrid vectors: chunk 3/3 complete | identifier 2/2 complete",
		"Tree-sitter parse failures: 2",
	} {
		if !strings.Contains(rendered, needle) {
			t.Fatalf("expected %q in rendered doctor output: %s", needle, rendered)
		}
	}
}
