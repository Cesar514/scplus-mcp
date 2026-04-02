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
	indexJob := model.job("index")
	indexJob.State = "running"
	indexJob.Phase = "identifier-search"
	indexJob.Percent = intPtr(62)
	indexJob.CurrentFile = "src/tools/query-intent.ts"
	indexJob.QueueDepth = 1
	model.queueDepth = 1
	model.refreshJobTable()
	model.refreshOverviewSection()
	model.refreshSidebar()
	model.syncDetailViewport()
	model.appendLog("observability indexing: identifier-search 62%")

	rendered := model.View()
	for _, needle := range []string{
		"Operator console with navigation, detail, and job layers",
		"Navigation",
		"Overview",
		"Status",
		"Changes",
		"Detail",
		"Jobs",
		"Logs",
		"Refresh data",
		"Index running",
		"Retry last index",
		"Cancel pending job",
		"Supersede pending job",
		"Disable watcher",
		"watcher: on",
		"stage: identifier-search",
		"backend: connected",
		"repo: /tmp/contextplus",
		"generation: 7",
		"Index",
		"running",
		"62",
		"observability indexing: identifier-search 62%",
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
		"Logs",
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

	rendered := model.renderContentPanel(56, 10)
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

func TestStatusSectionRendersBubbleTable(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 140
	model.height = 24
	model.setStatusSummary(backend.RepoStatusSummary{
		Branch: "main",
		Files: []backend.RepoStatusFile{
			{Path: "cli/internal/ui/model.go", Index: "M", WorkingTree: " "},
			{Path: "README.md", Index: " ", WorkingTree: "M"},
		},
	})
	model.setActiveView(viewStatus)

	rendered := model.renderContentPanel(72, 16)
	for _, needle := range []string{
		"Git worktree status table",
		"Selected 1/2",
		"Path",
		"Index",
		"Worktree",
		"cli/internal/ui/model.go",
		"README.md",
	} {
		if !strings.Contains(rendered, needle) {
			t.Fatalf("expected %q in status content panel: %s", needle, rendered)
		}
	}
}

func TestChangesSectionRendersBubbleTable(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 140
	model.height = 24
	model.setChangesSummary(backend.RepoChangesSummary{
		ChangedFiles: 1,
		Files: []backend.ChangeEntry{
			{
				Path:      "cli/internal/ui/model.go",
				Staged:    "M",
				Unstaged:  " ",
				Additions: 12,
				Deletions: 4,
				Ranges: []backend.ChangeRange{
					{OldStart: 10, OldLines: 2, NewStart: 10, NewLines: 6},
				},
			},
		},
	})
	model.setActiveView(viewChanges)

	rendered := model.renderContentPanel(72, 16)
	for _, needle := range []string{
		"Git change summary table",
		"Selected 1/1",
		"Path",
		"+/-",
		"State",
		"cli/internal/ui/model.go",
		"+12/-4",
	} {
		if !strings.Contains(rendered, needle) {
			t.Fatalf("expected %q in changes content panel: %s", needle, rendered)
		}
	}
}

func TestLogsViewportRetainsFullHistory(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 120
	model.height = 32
	for i := 0; i < 24; i++ {
		model.appendLog("log line " + titleFromID("entry"))
	}
	rendered := model.renderLogsPanel(72, 12)
	if !strings.Contains(rendered, "Scrollable backend log stream (25 lines)") {
		t.Fatalf("expected full log history to be retained in logs panel: %s", rendered)
	}
}

func TestJobsPanelShowsStructuredJobRows(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 144
	model.height = 36
	indexJob := model.job("index")
	indexJob.State = "progress"
	indexJob.Phase = "file-scan"
	indexJob.Percent = intPtr(40)
	indexJob.CurrentFile = "src/cli/backend-core.ts"
	indexJob.ElapsedMs = 2800
	indexJob.QueueDepth = 2
	indexJob.Message = "file-scan | 40/100 files"
	indexJob.RebuildReason = "watch-triggered full rebuild for src/cli/backend-core.ts"
	indexJob.Pending = true
	model.refreshJobTable()

	rendered := model.renderJobsPanel(84, 14)
	for _, needle := range []string{
		"Structured backend and operator task state",
		"Task",
		"State",
		"Current",
		"Index",
		"progress",
		"file-scan",
		"40",
		"src/cli/backend-core.ts",
		"controls: i run | t retry | x cancel pending | s supersede pending",
	} {
		if !strings.Contains(rendered, needle) {
			t.Fatalf("expected %q in jobs panel: %s", needle, rendered)
		}
	}
}

func TestBuildSearchItemsCoversExactAndRelatedResults(t *testing.T) {
	items := buildSearchItems(backend.SearchResultPayload{
		Query: "runSearchByIntent",
		SymbolHits: []backend.SearchSymbolHit{
			{
				Path:      "src/tools/query-intent.ts",
				Name:      "runSearchByIntent",
				Kind:      "function",
				Line:      182,
				EndLine:   184,
				Signature: "async function runSearchByIntent(options: SearchIntentOptions): Promise<string> {",
				Header:    "Query-intent router",
			},
		},
		PathHits: []string{"src/tools/query-intent.ts"},
		WordHits: []backend.SearchWordHit{
			{
				Kind:    "symbol",
				Token:   "runsearchbyintent",
				Path:    "src/tools/query-intent.ts",
				Line:    182,
				Title:   "runSearchByIntent",
				Snippet: "async function runSearchByIntent(options: SearchIntentOptions): Promise<string> {",
				Score:   1,
			},
		},
		Hits: []backend.SearchRankedHit{
			{
				EntityType: "file",
				Path:       "src/tools/query-intent.ts",
				Title:      "src/tools/query-intent.ts",
				Kind:       "file",
				Line:       1,
				Snippet:    "Query-intent router for exact lookups, related discovery, and research",
				Score:      0.91,
			},
		},
	})
	if len(items) != 4 {
		t.Fatalf("expected 4 search items, got %d", len(items))
	}
	for _, badge := range []string{"exact-symbol", "exact-path", "word-symbol", "related-file"} {
		found := false
		for _, item := range items {
			if item.Badge == badge {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("expected badge %q in search items: %#v", badge, items)
		}
	}
}
