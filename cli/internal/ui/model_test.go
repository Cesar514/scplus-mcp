// Regression coverage for the human CLI operator console.
// FEATURE: verifies doctor output, pane layout, status lines, and overview navigation.
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
	report.Observability.Caches.Embeddings.ProcessNamespaceHits = 4
	report.Observability.Caches.Embeddings.ProcessVectorHits = 6
	report.Observability.Indexing.Stages = map[string]struct {
		DurationMs      int            `json:"durationMs"`
		PhaseDurations  map[string]int `json:"phaseDurationsMs"`
		ProcessedFiles  *int           `json:"processedFiles"`
		IndexedChunks   *int           `json:"indexedChunks"`
		EmbeddedCount   *int           `json:"embeddedCount"`
		FilesPerSecond  *float64       `json:"filesPerSecond"`
		ChunksPerSecond *float64       `json:"chunksPerSecond"`
		EmbedsPerSecond *float64       `json:"embedsPerSecond"`
	}{
		"file-search": {
			DurationMs:      120,
			FilesPerSecond:  floatPtr(12.5),
			EmbedsPerSecond: floatPtr(8.5),
		},
	}
	report.Observability.Integrity.ParseFailuresByLanguage = map[string]int{"typescript": 2}
	report.Observability.Integrity.FallbackMarkerCount = 0
	report.Observability.Scheduler.QueueDepth = 1
	report.Observability.Scheduler.MaxQueueDepth = 2
	report.Observability.Scheduler.BatchCount = 5
	report.Observability.Scheduler.DedupedPathEvents = 3
	report.Observability.Scheduler.CanceledJobs = 2
	report.Observability.Scheduler.SupersededJobs = 1

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
		"Embedding cache hits: namespace 4 | vector 6",
		"Stage metrics: file-search 120ms (files/s 12.50 | embeds/s 8.50)",
		"Parse failures by language: typescript:2",
		"Fallback markers: 0",
		"Scheduler: queue depth 1 | max 2 | batches 5 | deduped 3 | canceled 2 | superseded 1",
	} {
		if !strings.Contains(rendered, needle) {
			t.Fatalf("expected %q in rendered doctor output: %s", needle, rendered)
		}
	}
}

func floatPtr(value float64) *float64 {
	return &value
}

func TestViewRendersOperatorConsolePanes(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 160
	model.height = 40
	model.doctorLoaded = true
	model.doctor = backend.DoctorReport{
		Root: "/tmp/contextplus",
		Serving: struct {
			ActiveGeneration              int    `json:"activeGeneration"`
			PendingGeneration             *int   `json:"pendingGeneration"`
			LatestGeneration              int    `json:"latestGeneration"`
			ActiveGenerationValidatedAt   string `json:"activeGenerationValidatedAt"`
			ActiveGenerationFreshness     string `json:"activeGenerationFreshness"`
			ActiveGenerationBlockedReason string `json:"activeGenerationBlockedReason"`
		}{
			ActiveGeneration: 7,
		},
		RepoStatus: backend.RepoStatusSummary{
			Branch:         "main",
			UnstagedCount:  1,
			UntrackedCount: 0,
		},
		IndexValidation: backend.IndexValidationReport{OK: true},
	}
	model.watchEnabled = true
	model.jobPhase = "identifier-search"
	model.refreshOverviewSection()
	model.refreshSidebar()
	model.syncDetailViewport()

	rendered := model.View()
	for _, needle := range []string{
		"Operator console with navigation, detail, and job layers",
		"Navigation",
		"Overview",
		"Detail",
		"Jobs",
		"Refresh data",
		"Run full index",
		"Disable watcher",
		"watcher: on",
		"stage: identifier-search",
		"backend: connected",
		"repo: /tmp/contextplus",
		"generation: 7",
	} {
		if !strings.Contains(rendered, needle) {
			t.Fatalf("expected %q in operator console view: %s", needle, rendered)
		}
	}
}

func TestViewUsesStackedLayoutForNarrowWidth(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 90
	model.height = 26
	model.doctorLoaded = true
	model.doctor = backend.DoctorReport{
		Root: "/tmp/contextplus",
		RepoStatus: backend.RepoStatusSummary{
			Branch:         "main",
			UnstagedCount:  1,
			UntrackedCount: 0,
		},
		IndexValidation: backend.IndexValidationReport{OK: true},
	}
	model.refreshOverviewSection()
	model.refreshSidebar()
	model.syncDetailViewport()

	rendered := model.View()
	for _, needle := range []string{
		"Stacked operator console for narrow terminals",
		"Navigation",
		"Jobs",
	} {
		if !strings.Contains(rendered, needle) {
			t.Fatalf("expected %q in stacked operator console view: %s", needle, rendered)
		}
	}
}

func TestOverviewContentWindowShowsHiddenRowsWhenScrolled(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 120
	model.height = 10
	model.doctorLoaded = true
	model.doctor = backend.DoctorReport{
		Root:        "/tmp/contextplus",
		GeneratedAt: "2026-04-02T08:00:00Z",
		Serving: struct {
			ActiveGeneration              int    `json:"activeGeneration"`
			PendingGeneration             *int   `json:"pendingGeneration"`
			LatestGeneration              int    `json:"latestGeneration"`
			ActiveGenerationValidatedAt   string `json:"activeGenerationValidatedAt"`
			ActiveGenerationFreshness     string `json:"activeGenerationFreshness"`
			ActiveGenerationBlockedReason string `json:"activeGenerationBlockedReason"`
		}{
			ActiveGeneration:          3,
			ActiveGenerationFreshness: "fresh",
		},
		RepoStatus: backend.RepoStatusSummary{
			Branch:         "main",
			UnstagedCount:  1,
			UntrackedCount: 0,
		},
		Ollama: backend.OllamaRuntimeStatus{
			OK: true,
			Models: []backend.OllamaRuntimeModel{
				{Name: "qwen3-embedding"},
			},
		},
		IndexValidation:   backend.IndexValidationReport{OK: true},
		RestorePointCount: 4,
	}
	model.refreshOverviewSection()
	section := model.sections[viewOverview]
	section.Selected = len(section.Items) - 1

	rendered := model.renderContentPanel(56)
	for _, needle := range []string{
		"Selected 8/8",
		"... 2 earlier items hidden",
		"Scheduler",
	} {
		if !strings.Contains(rendered, needle) {
			t.Fatalf("expected %q in overview content panel: %s", needle, rendered)
		}
	}
	if strings.Contains(rendered, "Repository") {
		t.Fatalf("expected earliest overview row to be scrolled out of the visible window: %s", rendered)
	}
}
