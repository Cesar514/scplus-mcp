// Regression coverage for the human CLI operator console.
// FEATURE: verifies palette, filters, history, exports, and operator layout behavior.
package ui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"contextplusplus/cli/internal/backend"
	tea "github.com/charmbracelet/bubbletea"
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
	report.Observability.Scheduler.PendingChangeCount = 2
	report.Observability.Scheduler.PendingPaths = []string{"src/app.ts", "src/config.ts"}
	report.Observability.Scheduler.PendingJobKind = "refresh"

	rendered := RenderDoctorPlain(report)
	for _, needle := range []string{
		"contextplusplus-cli doctor for /tmp/contextplus",
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
		"Scheduler: queue depth 1 | pending changes 2 | pending job refresh | max 2 | batches 5 | deduped 3 | canceled 2 | superseded 1",
		"Pending paths: src/app.ts, src/config.ts",
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
	model.pendingPaths = []string{"src/cli/backend-core.ts", "src/cli/commands.ts"}
	model.pendingJobKind = "refresh"
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
		"Operator console with navigation history, command palette, and export layers",
		"Navigation",
		"Overview",
		"Find hub",
		"Status",
		"Changes",
		"Search",
		"Symbol",
		"Detail",
		"Jobs",
		"Logs",
		"Refresh data",
		"Index running",
		"Retry last index",
		"Cancel pending refresh",
		"Supersede pending refresh",
		"Disable watcher",
		"Changes detected (2)",
		"pending refresh",
		"watcher: on",
		"stage: identifier-search",
		"pending: 2",
		"backend: connected",
		"repo: /tmp/contextplus",
		"generation: 7",
		"history: 1/1",
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
				Patch: "@@ -10,2 +10,6 @@\n-const oldValue = 1\n+const oldValue = 2",
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

func TestChangesDetailIncludesPatchPreview(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.setChangesSummary(backend.RepoChangesSummary{
		ChangedFiles: 1,
		Files: []backend.ChangeEntry{
			{
				Path:      "src/tools/exact-query.ts",
				Staged:    "M",
				Unstaged:  " ",
				Additions: 8,
				Deletions: 1,
				Patch:     "@@ -1,3 +1,9 @@\n-interface ChangeEntry {\n+interface ChangeEntry {\n+  patch?: string;",
			},
		},
	})
	model.setActiveView(viewChanges)

	detail := model.buildDetailContent()
	for _, needle := range []string{
		"Patch:",
		"interface ChangeEntry",
		"patch?: string;",
	} {
		if !strings.Contains(detail, needle) {
			t.Fatalf("expected %q in change detail patch preview: %s", needle, detail)
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
	refreshJob := model.job("refresh")
	refreshJob.State = "progress"
	refreshJob.Phase = "structure-scan"
	refreshJob.Percent = intPtr(82)
	refreshJob.CurrentFile = "src/cli/backend-core.ts"
	refreshJob.ElapsedMs = 2800
	refreshJob.QueueDepth = 1
	refreshJob.Message = "structure-scan | 82/100 files"
	refreshJob.RebuildReason = "background incremental refresh for src/cli/backend-core.ts"
	refreshJob.Pending = true
	model.jobTable.SetCursor(1)
	model.refreshJobTable()

	rendered := model.renderJobsPanel(84, 14)
	for _, needle := range []string{
		"Structured backend and operator task state",
		"Task",
		"State",
		"Current",
		"Refresh",
		"progress",
		"structure-scan",
		"82",
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
	if !strings.Contains(items[0].Summary, "rank #1/4") {
		t.Fatalf("expected explicit rank metadata in first search summary: %#v", items[0])
	}
	if !strings.Contains(items[len(items)-1].Detail, "Rank: 4 of 4") {
		t.Fatalf("expected explicit rank metadata in ranked result detail: %#v", items[len(items)-1])
	}
	for _, badge := range []string{"exact-symbol", "exact-path", "word-symbol", "related-file"} {
		found := false
		for _, item := range items {
			if strings.HasPrefix(item.Badge, badge) {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("expected badge %q in search items: %#v", badge, items)
		}
	}
}

func TestCommandPaletteOverlayRendersPhase26Commands(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 140
	model.height = 34
	model.openPalette()

	rendered := model.View()
	for _, needle := range []string{
		"Command palette",
		"Find hub",
		"Exact lookup",
		"Go to file",
		"Go to symbol",
		"Symbol lookup",
		"Lint",
		"Blast radius",
		"Palette: type to filter | Up/Down select | Enter run | Esc close",
	} {
		if !strings.Contains(rendered, needle) {
			t.Fatalf("expected %q in palette overlay: %s", needle, rendered)
		}
	}
}

func TestNavigationHistoryTracksViewTransitions(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.setActiveView(viewTree)
	model.focus = focusContent
	model.recordNavigation()
	model.setActiveView(viewStatus)
	model.focus = focusDetail
	model.recordNavigation()

	if got := len(model.history); got < 3 {
		t.Fatalf("expected navigation history to record transitions, got %d entries", got)
	}
	model.navigateHistory(-1)
	if model.activeView != viewStatus {
		t.Fatalf("expected first history step back to remain on the last status view snapshot, got %s", model.activeView)
	}
	model.navigateHistory(-1)
	if model.activeView != viewTree {
		t.Fatalf("expected second history step back to return to tree view, got %s", model.activeView)
	}
	model.navigateHistory(1)
	model.navigateHistory(1)
	if model.activeView != viewStatus {
		t.Fatalf("expected history forward to return to status view, got %s", model.activeView)
	}
}

func TestFilterOverlayAppliesCurrentSectionFilter(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 120
	model.height = 24
	model.doctorLoaded = true
	model.doctor = backend.DoctorReport{
		Root: "/tmp/contextplus",
		RepoStatus: backend.RepoStatusSummary{
			Branch:         "main",
			UnstagedCount:  1,
			UntrackedCount: 0,
		},
	}
	model.refreshOverviewSection()
	model.openFilterOverlay()
	model.overlay.Input.SetValue("sched")
	updated, cmd := model.updateOverlay(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatalf("expected filter overlay to apply synchronously")
	}
	filtered := updated.(*Model)
	rendered := filtered.renderContentPanel(72, 16)
	if !strings.Contains(rendered, "filter=sched") {
		t.Fatalf("expected rendered content to show active filter: %s", rendered)
	}
	if !strings.Contains(rendered, "Scheduler") {
		t.Fatalf("expected scheduler row to remain visible after filtering: %s", rendered)
	}
	if strings.Contains(rendered, "Repository") {
		t.Fatalf("expected filtered overview to hide non-matching rows: %s", rendered)
	}
}

func TestQuitKeyWhileWatcherActiveReturnsQuitCommand(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.watchEnabled = true
	model.pendingPaths = []string{"src/app.ts"}
	model.pendingJobKind = "refresh"

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("q")})
	if cmd == nil {
		t.Fatal("expected quit command when pressing q")
	}
	if _, ok := updated.(Model); !ok {
		t.Fatalf("expected updated model value, got %T", updated)
	}
	message := cmd()
	if _, ok := message.(tea.QuitMsg); !ok {
		t.Fatalf("expected tea.QuitMsg, got %T", message)
	}
}

func TestExportActionWritesResultsToExportsDirectory(t *testing.T) {
	root := t.TempDir()
	model := NewModel(root, nil)
	model.width = 120
	model.height = 24
	model.showCommandSection(viewSearch, "Search", "Exact file lookup", []contentItem{
		{ID: "1", Title: "cli/internal/ui/model.go", Summary: "Exact path hit", Detail: "Detail line", Badge: "exact-path"},
	}, "Exact file matches for cli/internal/ui/model.go")

	cmd := model.exportActiveContent()
	msg := cmd()
	exported, ok := msg.(exportFinishedMsg)
	if !ok {
		t.Fatalf("expected exportFinishedMsg, got %T", msg)
	}
	if exported.err != nil {
		t.Fatalf("expected export to succeed: %v", exported.err)
	}
	content, err := os.ReadFile(exported.path)
	if err != nil {
		t.Fatalf("read export: %v", err)
	}
	if !strings.Contains(string(content), "Exact file matches for cli/internal/ui/model.go") {
		t.Fatalf("expected exported file to contain result text: %s", string(content))
	}
	if filepath.Dir(exported.path) != filepath.Join(root, ".contextplus", "exports") {
		t.Fatalf("expected export path under .contextplus/exports, got %s", exported.path)
	}
}

func TestFindHubItemsPreserveSuggestedBadge(t *testing.T) {
	items := buildFindHubItems(strings.Join([]string{
		`Ranked hubs for: "scheduler observability"`,
		`Ranking mode: both`,
		`Candidates: 2`,
		``,
		`1. .contextplus/hubs/observability.md [manual] score=0.931`,
		`   Title: Observability`,
		`   Keyword: 0.800 | Semantic: 0.990`,
		``,
		`2. .contextplus/hubs/scheduler-ops.md [suggested] score=0.812`,
		`   Title: Scheduler Ops`,
		`   Keyword: 0.700 | Semantic: 0.872`,
	}, "\n"))
	if len(items) != 2 {
		t.Fatalf("expected 2 ranked hub items, got %d", len(items))
	}
	if items[1].Badge != "suggested" {
		t.Fatalf("expected suggested badge for ranked suggested hub: %#v", items[1])
	}
}

func TestRestoreShortcutRunsSelectedPointFromRestoreView(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.setRestorePoints([]backend.RestorePoint{
		{ID: "rp-123", Timestamp: 1, Message: "before refactor", Files: []string{"src/index.ts"}},
	})
	model.setActiveView(viewRestore)
	model.focus = focusContent
	model.client = nil

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("u")})
	if cmd == nil {
		t.Fatalf("expected restore shortcut to dispatch a restore command")
	}
	next := updated.(Model)
	if next.job("restore").Phase != "restore" {
		t.Fatalf("expected restore job to enter restore phase, got %#v", next.job("restore"))
	}
}

func TestMousePressFocusesJobsPane(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 160
	model.height = 40
	if cmd := model.handleMouse(tea.MouseMsg{X: 10, Y: 34, Button: tea.MouseButtonLeft, Action: tea.MouseActionPress}); cmd != nil {
		t.Fatalf("expected mouse focus change without extra command")
	}
	if model.focus != focusJobs {
		t.Fatalf("expected mouse click in the bottom-left pane to focus jobs, got %d", model.focus)
	}
}
