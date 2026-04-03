// summary: Exercises regression coverage for operator console navigation and interactions.
// FEATURE: verifies palette, filters, history, exports, and operator layout behavior.
// inputs: Simulated UI messages, backend payloads, and rendered snapshot expectations.
// outputs: Regression coverage for palette, filters, history, exports, and layout behavior.
package ui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"scplus-cli/cli/internal/backend"
)

func renderedLineCount(value string) int {
	if value == "" {
		return 0
	}
	return strings.Count(value, "\n") + 1
}

func maxRenderedLineWidth(value string) int {
	lines := strings.Split(value, "\n")
	maxWidth := 0
	for _, line := range lines {
		width := lipgloss.Width(line)
		if width > maxWidth {
			maxWidth = width
		}
	}
	return maxWidth
}

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
		"scplus-cli doctor for /tmp/contextplus",
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
		"SCPLUS-CLI",
		"Type command",
		"watcher: on",
		"stage: identifier-search",
		"pending: 2",
		"backend: connected",
		"repo: /tmp/contextplus",
		"serving build: 7",
		"Index",
		"running",
		"observability indexing: identifier-search 62%",
	} {
		if !strings.Contains(rendered, needle) {
			t.Fatalf("expected %q in operator console view: %s", needle, rendered)
		}
	}
	for _, needle := range []string{
		"Operator console with navigation history, command palette, and export layers",
		"Slash-command console",
		"Examples:",
	} {
		if strings.Contains(rendered, needle) {
			t.Fatalf("expected %q to be absent from activity shell: %s", needle, rendered)
		}
	}
	if strings.Contains(rendered, "history: 1/1") {
		t.Fatalf("expected single-entry navigation jargon to stay hidden from the status line: %s", rendered)
	}
	if strings.Contains(rendered, "/|_|\\--*") {
		t.Fatalf("expected legacy line-art magician to be absent: %s", rendered)
	}
}

func TestViewUsesStackedLayoutForNarrowWidth(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 90
	model.height = 26
	model.doctorLoaded = true
	model.doctor = backend.DoctorReport{
		Root: "/tmp/contextplus",
		Ollama: backend.OllamaRuntimeStatus{
			OK: true,
		},
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
		"SCPLUS-CLI",
		"The magician is resting",
		"Type command",
	} {
		if !strings.Contains(rendered, needle) {
			t.Fatalf("expected %q in stacked operator console view: %s", needle, rendered)
		}
	}
	for _, needle := range []string{
		"Stacked operator console for narrow terminals",
		"Examples:",
		"Slash-command console",
	} {
		if strings.Contains(rendered, needle) {
			t.Fatalf("expected %q to be absent from stacked activity shell: %s", needle, rendered)
		}
	}
}

func TestActivityShellShowsRestingStatusWhenNoModelIsActive(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.doctorLoaded = true
	model.doctor.Ollama = backend.OllamaRuntimeStatus{OK: true, Models: nil}

	rendered := model.renderActivityShell(90, 18)
	if !strings.Contains(rendered, "SCPLUS-CLI") {
		t.Fatalf("expected branded activity title: %s", rendered)
	}
	if strings.Contains(rendered, "Activity |") {
		t.Fatalf("expected activity shell to drop the old title prefix: %s", rendered)
	}
	if !strings.Contains(rendered, "The magician is resting") {
		t.Fatalf("expected resting status in activity title: %s", rendered)
	}
}

func TestActivityShellShowsRunningModelStatusForActiveJob(t *testing.T) {
	t.Setenv("OLLAMA_CHAT_MODEL", "nemotron-3-nano:4b-128k")
	model := NewModel("/tmp/contextplus", nil)
	model.doctorLoaded = true
	model.doctor.Ollama = backend.OllamaRuntimeStatus{
		OK: true,
		Models: []backend.OllamaRuntimeModel{
			{Name: "qwen3-embedding:0.6b-32k"},
			{Name: "nemotron-3-nano:4b-128k"},
		},
	}
	queryJob := model.job("query")
	queryJob.State = "running"
	queryJob.Phase = "research"

	rendered := model.renderActivityShell(120, 18)
	if !strings.Contains(rendered, "The magician is using 'nemotron-3-nano:4b-128k' for query") {
		t.Fatalf("expected active model status in activity title: %s", rendered)
	}
}

func TestRenderMagicianASCIIUsesTransparentGirlSpritePalette(t *testing.T) {
	rendered := renderMagicianASCII(magicianFrames[0])
	for _, needle := range []string{"@@", "%%", "oo", "**", "[]"} {
		if !strings.Contains(rendered, needle) {
			t.Fatalf("expected %q in plain magician sprite: %s", needle, rendered)
		}
	}
	for _, needle := range []string{".", "K", "W", "R", "S", "H", "E", "G"} {
		if strings.Contains(rendered, needle) {
			t.Fatalf("expected palette tokens to stay internal, found %q in %s", needle, rendered)
		}
	}
}

func TestCenterBlockKeepsConsistentContainerOffsetAcrossAsciiRows(t *testing.T) {
	plain := renderMagicianASCII(magicianFrames[0])
	centered := centerBlock(plain, 60)
	renderedLines := strings.Split(centered, "\n")
	frameLines := strings.Split(plain, "\n")
	if len(renderedLines) != len(frameLines) {
		t.Fatalf("expected %d rendered lines, got %d", len(frameLines), len(renderedLines))
	}
	blockOffset := -1
	for index, frameLine := range frameLines {
		if strings.TrimSpace(frameLine) == "" {
			continue
		}
		offset := countLeadingSpaces(renderedLines[index]) - countLeadingSpaces(frameLine)
		if blockOffset == -1 {
			blockOffset = offset
			continue
		}
		if offset != blockOffset {
			t.Fatalf("expected consistent block offset, got %d on line %d after %d", offset, index, blockOffset)
		}
	}
	if blockOffset <= 0 {
		t.Fatalf("expected positive centering offset in wide container, got %d", blockOffset)
	}
}

func TestManualIndexSelectionDoesNotLeaveOptimisticQueuedState(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.sidebarIndex = model.findSidebarAction("index")

	command := model.executeSidebarSelection()
	if command == nil {
		t.Fatal("expected index action command")
	}
	indexJob := model.job("index")
	if indexJob.State != "idle" {
		t.Fatalf("expected index job to stay idle until backend events arrive, got %q", indexJob.State)
	}
}

func TestSuccessfulRefreshClearsStaleIssue(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.lastError = "cluster failed"
	model.startRefreshJob("refreshing backend snapshots after index", 7)

	for _, task := range []string{"doctor", "tree", "hubs", "cluster", "restore-points", "status", "changes"} {
		model.finishRefreshSubtask(task, nil)
	}

	if model.lastError != "" {
		t.Fatalf("expected successful refresh to clear stale issue, got %q", model.lastError)
	}
	if model.job("refresh").State != "completed" {
		t.Fatalf("expected refresh job completed, got %q", model.job("refresh").State)
	}
}

func TestActivityShellHidesCommandsUntilLettersTyped(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 120
	model.height = 24

	rendered := model.View()
	if strings.Contains(rendered, "Commands") {
		t.Fatalf("expected activity shell to stay minimal until command letters are typed: %s", rendered)
	}
	if strings.Contains(rendered, "overview\n") {
		t.Fatalf("expected command suggestions to stay hidden until command letters are typed: %s", rendered)
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
	model.setActiveView(viewOverview)
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
		"back",
		"forward",
		"overview",
		"tree",
		"issue",
		"changes",
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

func TestStatusLineUsesUserFacingServingAndViewTrailLabels(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 160
	model.doctorLoaded = true
	model.doctor.Serving.ActiveGeneration = 29
	model.doctor.Serving.ActiveGenerationFreshness = "fresh"
	model.setActiveView(viewTree)
	model.recordNavigation()
	model.setActiveView(viewStatus)
	model.recordNavigation()

	rendered := model.renderStatusLine()
	if !strings.Contains(rendered, "serving build: 29") {
		t.Fatalf("expected serving build label in status line: %s", rendered)
	}
	if !strings.Contains(rendered, "view trail: 3/3") {
		t.Fatalf("expected explicit view trail label in status line: %s", rendered)
	}
	if strings.Contains(rendered, "generation:") || strings.Contains(rendered, "history:") {
		t.Fatalf("expected internal generation/history jargon to be removed from status line: %s", rendered)
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
	model.setActiveView(viewOverview)
	model.openSectionSearchOverlay()
	model.overlay.Input.SetValue("sched")
	updated, cmd := model.updateOverlay(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatalf("expected filter overlay to apply synchronously")
	}
	filtered := updated.(*Model)
	rendered := filtered.renderContentPanel(72, 16)
	if !strings.Contains(rendered, "search=sched") {
		t.Fatalf("expected rendered content to show active filter: %s", rendered)
	}
	if !strings.Contains(rendered, "Scheduler") {
		t.Fatalf("expected scheduler row to remain visible after filtering: %s", rendered)
	}
	if strings.Contains(rendered, "Repository") {
		t.Fatalf("expected filtered overview to hide non-matching rows: %s", rendered)
	}
}

func TestLettersTypeIntoActivityCommandBar(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("l")})
	next := updated.(Model)
	if next.overlay.Mode != overlayNone {
		t.Fatalf("expected activity view to stay in-place, got overlay %#v", next.overlay.Mode)
	}
	if next.commandBar.Value() != "l" {
		t.Fatalf("expected typed letters to stay in the command bar, got %q", next.commandBar.Value())
	}
}

func TestPaletteLetterQueryShowsCommands(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.openPalette()
	model.overlay.Input.SetValue("tr")

	commands := model.filteredPaletteCommands()
	if len(commands) == 0 {
		t.Fatal("expected commands to stay visible when the palette query uses letters")
	}
	if commands[0].Action != "open-tree" {
		t.Fatalf("expected tr to match open-tree first, got %s", commands[0].Action)
	}
}

func TestActivityCommandBarRunsOverviewCommand(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.commandBar.SetValue("overview")

	cmd := model.submitCommandBar()
	if cmd != nil {
		t.Fatalf("expected overview to switch views without async command")
	}
	if model.activeView != viewOverview {
		t.Fatalf("expected overview to activate overview, got %s", model.activeView)
	}
}

func TestActivityCommandBarRunsOverviewCommandWithoutSlash(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.commandBar.SetValue("overview")

	cmd := model.submitCommandBar()
	if cmd != nil {
		t.Fatalf("expected overview to switch views without async command")
	}
	if model.activeView != viewOverview {
		t.Fatalf("expected overview to activate overview, got %s", model.activeView)
	}
}

func TestActivityCommandBarAllowsRemovingTypedLetters(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("l")})
	model = updated.(Model)
	updated, _ = model.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	next := updated.(Model)
	if next.commandBar.Value() != "" {
		t.Fatalf("expected backspace to remove the typed letters, got %q", next.commandBar.Value())
	}
}

func TestActivityCommandBarKeepsPlainLettersTyped(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	for _, key := range []tea.KeyMsg{
		{Type: tea.KeyRunes, Runes: []rune("e")},
		{Type: tea.KeyRunes, Runes: []rune("q")},
		{Type: tea.KeyRunes, Runes: []rune("?")},
	} {
		updated, _ := model.Update(key)
		model = updated.(Model)
	}
	if model.commandBar.Value() != "eq?" {
		t.Fatalf("expected plain letters to remain editable input, got %q", model.commandBar.Value())
	}
}

func TestActivityCommandSuggestionsScrollWhenSelectionMoves(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 100
	model.height = 23
	model.commandBar.SetValue("e")
	model.commandSelect = 10

	rendered := model.View()
	if !strings.Contains(rendered, "earlier commands hidden") {
		t.Fatalf("expected scroll marker for hidden earlier commands: %s", rendered)
	}
	if !strings.Contains(rendered, "more commands hidden") {
		t.Fatalf("expected scroll marker for hidden later commands: %s", rendered)
	}
}

func TestActivityCommandSuggestionsStayBoundedWhileTypingLetters(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 120
	model.height = 40
	model.commandBar.SetValue("e")

	rendered := model.renderActivityShell(90, 40)
	for _, needle := range []string{
		"SCPLUS-CLI",
		"The magician is resting",
		"Commands",
		"exit",
		"overview",
		"refresh",
	} {
		if !strings.Contains(rendered, needle) {
			t.Fatalf("expected %q in command browser: %s", needle, rendered)
		}
	}
	if !strings.Contains(rendered, "more commands hidden") {
		t.Fatalf("expected bounded command list to keep hidden commands even in a tall window: %s", rendered)
	}
	if strings.Contains(rendered, "Current task:") || strings.Contains(rendered, "Current issue:") || strings.Contains(rendered, "Latest log:") {
		t.Fatalf("expected command browser to suppress activity previews: %s", rendered)
	}
}

func TestActivityShellKeepsSameRenderedHeightWhenSlashCommandsAppear(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 113
	model.height = 27
	indexJob := model.job("index")
	indexJob.State = "failed"
	indexJob.Phase = "failed"
	indexJob.Message = "File search refresh blocked for /home/cesar514/Documents/agent_programming/contextplus: TODO_COMPLETED.md: refresh would remove an indexed file without replacement."
	model.lastError = "backend command \"cluster\" failed: cluster requires a valid prepared full index."
	model.logs = append(model.logs, "[13:28:38] doctor report refreshed")

	withoutCommands := model.View()
	model.commandBar.SetValue("lo")
	withCommands := model.View()

	withoutLines := renderedLineCount(withoutCommands)
	withLines := renderedLineCount(withCommands)
	if withoutLines > model.height {
		t.Fatalf("expected non-command activity shell to stay within terminal height %d, got %d lines: %s", model.height, withoutLines, withoutCommands)
	}
	if withLines > model.height {
		t.Fatalf("expected command activity shell to stay within terminal height %d, got %d lines: %s", model.height, withLines, withCommands)
	}
	if withLines != withoutLines {
		t.Fatalf("expected command activity shell to keep the same rendered height, got %d lines before and %d after: before=%s after=%s", withoutLines, withLines, withoutCommands, withCommands)
	}
}

func TestActivityShellHidesPreviewsWhileSlashCommandsAreActive(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 113
	model.height = 27
	indexJob := model.job("index")
	indexJob.State = "failed"
	indexJob.Phase = "failed"
	indexJob.Message = "blocked refresh message"
	model.lastError = "backend command failed"
	model.logs = append(model.logs, "doctor report refreshed")
	model.commandBar.SetValue("lo")

	rendered := model.View()
	for _, unwanted := range []string{"Current task:", "Current issue:", "Latest log:"} {
		if strings.Contains(rendered, unwanted) {
			t.Fatalf("expected command activity shell to hide %q: %s", unwanted, rendered)
		}
	}
	if strings.Contains(rendered, "Current status:") {
		t.Fatalf("expected command browser to replace the activity status block: %s", rendered)
	}
	if !strings.Contains(rendered, "Commands") {
		t.Fatalf("expected command section in letter mode: %s", rendered)
	}
}

func TestActivityShellWrapsStatusAndErrorLines(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 72
	model.height = 22
	indexJob := model.job("index")
	indexJob.State = "running"
	indexJob.Phase = "identifier-search"
	indexJob.Message = "this is a deliberately long indexing status message that should wrap inside the activity pane instead of running out of bounds"
	model.pendingPaths = []string{"src/one.ts", "src/two.ts", "src/three.ts", "src/four.ts"}
	model.lastError = "this is a deliberately long backend error message that should also wrap inside the activity pane instead of overflowing past the right edge"

	rendered := model.renderActivityShell(60, 18)
	if !strings.Contains(rendered, "Current status: Index | state=running |") {
		t.Fatalf("expected current status line in wrapped activity shell: %s", rendered)
	}
	if !strings.Contains(rendered, "phase=identifier-search |") {
		t.Fatalf("expected wrapped status to keep the phase content visible: %s", rendered)
	}
	if !strings.Contains(rendered, "pending=4") {
		t.Fatalf("expected wrapped status to keep the pending count visible: %s", rendered)
	}
	if maxRenderedLineWidth(rendered) > 60 {
		t.Fatalf("expected wrapped activity shell to stay within width 60, got max width %d: %s", maxRenderedLineWidth(rendered), rendered)
	}
}

func TestActivityShellClampsIssueAndLogPreviewsToThreeLines(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 90
	model.height = 25
	model.lastError = "issue line one\nissue line two\nissue line three\nissue line four"
	model.logs = append(model.logs, "log line one\nlog line two\nlog line three\nlog line four")

	rendered := model.renderActivityShell(70, 25)
	for _, snippet := range []string{"[issue] Current issue:", "issue line one", "issue line two", "issue line three... (+1)", "[log] Latest log:", "log line one... (+3)", "[log] ... 3 more lines hidden"} {
		if !strings.Contains(rendered, snippet) {
			t.Fatalf("expected activity shell to include %q: %s", snippet, rendered)
		}
	}
	for _, snippet := range []string{"issue line four", "log line three", "log line four"} {
		if strings.Contains(rendered, snippet) {
			t.Fatalf("expected hidden preview content to stay out of the activity shell: %s", rendered)
		}
	}
}

func TestActivityPanelClampsIssueAndLogPreviewsToThreeLines(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.lastError = "panel issue one\npanel issue two\npanel issue three\npanel issue four"
	model.logs = append(model.logs, "panel log one\npanel log two\npanel log three\npanel log four")

	rendered := model.renderActivityPanel(64)
	for _, snippet := range []string{"Current issue:", "panel issue one", "panel issue two", "panel issue three...", "Latest log:", "panel log one", "panel log two", "panel log three..."} {
		if !strings.Contains(rendered, snippet) {
			t.Fatalf("expected activity panel to include %q: %s", snippet, rendered)
		}
	}
	for _, snippet := range []string{"panel issue four", "panel log four"} {
		if strings.Contains(rendered, snippet) {
			t.Fatalf("expected hidden preview content to stay out of the activity panel: %s", rendered)
		}
	}
}

func TestIssueSlashCommandOpensFullIssueWindow(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.lastError = "first issue line\nsecond issue line\nthird issue line\nfourth issue line"

	cmd := model.executePaletteAction("open-issue")
	if cmd != nil {
		t.Fatalf("expected issue command to switch views synchronously")
	}
	if model.activeView != viewIssue {
		t.Fatalf("expected issue command to open %q, got %q", viewIssue, model.activeView)
	}
	section := model.sections[viewIssue]
	if section == nil || section.RawText != model.lastError {
		t.Fatalf("expected full issue text in the issue view, got %#v", section)
	}
}

func TestIssueViewStaysWithinTerminalHeight(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 113
	model.height = 27
	model.lastError = "first issue line\nsecond issue line\nthird issue line\nfourth issue line"
	model.logs = append(model.logs, "latest log line\nsecond log line\nthird log line\nfourth log line")

	if cmd := model.executePaletteAction("open-issue"); cmd != nil {
		t.Fatalf("expected issue command to switch views synchronously")
	}

	rendered := model.View()
	if lines := renderedLineCount(rendered); lines > model.height {
		t.Fatalf("expected issue view to stay within terminal height %d, got %d lines: %s", model.height, lines, rendered)
	}
}

func TestIssueViewReplacesActivityWindow(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 113
	model.height = 27
	model.lastError = "blocker line one\nblocker line two"

	if cmd := model.executePaletteAction("open-issue"); cmd != nil {
		t.Fatalf("expected issue command to switch views synchronously")
	}

	rendered := model.View()
	if strings.Contains(rendered, "Activity | scplus-cli") {
		t.Fatalf("expected issue view to replace the activity window content: %s", rendered)
	}
	if !strings.Contains(rendered, "Issue | scplus-cli") {
		t.Fatalf("expected issue title in the single window: %s", rendered)
	}
	if !strings.Contains(rendered, "blocker line one") {
		t.Fatalf("expected full issue text in the replacement window: %s", rendered)
	}
	if strings.Count(rendered, "╭") != 1 || strings.Count(rendered, "╰") != 1 {
		t.Fatalf("expected exactly one bordered window in the rendered view: %s", rendered)
	}
}

func TestActivityViewStaysWithinTerminalHeight(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 113
	model.height = 27
	indexJob := model.job("index")
	indexJob.State = "failed"
	indexJob.Phase = "failed"
	indexJob.Message = "File search refresh blocked for /home/cesar514/Documents/agent_programming/contextplus: TODO_COMPLETED.md: refresh would remove an indexed file without replacement: text index candidate exceeds max embed file size."
	model.lastError = "backend command \"cluster\" failed: cluster requires a valid prepared full index.\nIndex validation: failed."
	model.logs = append(model.logs, "[13:28:38] doctor report refreshed")

	rendered := model.View()
	if lines := renderedLineCount(rendered); lines > model.height {
		t.Fatalf("expected activity view to stay within terminal height %d, got %d lines: %s", model.height, lines, rendered)
	}
	if !strings.Contains(rendered, "Current issue:") {
		t.Fatalf("expected activity issue preview to remain visible: %s", rendered)
	}
}

func TestSlashCommandViewKeepsSingleWindowWithinTerminalBounds(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 113
	model.height = 27
	model.commandBar.SetValue("lo")
	model.lastError = "backend command failed"
	model.logs = append(model.logs, "doctor report refreshed")

	rendered := model.View()
	if renderedLineCount(rendered) > model.height {
		t.Fatalf("expected command view to stay within terminal height %d, got %d lines: %s", model.height, renderedLineCount(rendered), rendered)
	}
	if maxRenderedLineWidth(rendered) > model.width {
		t.Fatalf("expected command view to stay within terminal width %d, got max width %d: %s", model.width, maxRenderedLineWidth(rendered), rendered)
	}
	if strings.Count(rendered, "╭") != 1 || strings.Count(rendered, "╰") != 1 {
		t.Fatalf("expected exactly one bordered window while browsing commands: %s", rendered)
	}
	if !strings.Contains(rendered, "/|_|\\--*") {
		t.Fatalf("expected the centered magician to remain visible once in command mode: %s", rendered)
	}
}

func TestLogSlashCommandOpensFullLogWindow(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.logs = append(model.logs, "alpha", "beta", "gamma")

	cmd := model.executePaletteAction("open-log")
	if cmd != nil {
		t.Fatalf("expected log command to switch views synchronously")
	}
	if model.activeView != viewLog {
		t.Fatalf("expected log command to open %q, got %q", viewLog, model.activeView)
	}
	section := model.sections[viewLog]
	if section == nil || !strings.Contains(section.RawText, "scplus-cli started.\nalpha\nbeta\ngamma") {
		t.Fatalf("expected full log history in the log view, got %#v", section)
	}
}

func TestRightArrowDoesNothingInActivityShell(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.focus = focusContent
	model.commandBar.SetValue("")

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRight})
	if cmd != nil {
		t.Fatalf("expected right arrow to stay inert in activity shell")
	}
	next := updated.(Model)
	if next.focus != focusContent {
		t.Fatalf("expected focus to stay on activity content, got %d", next.focus)
	}
	if next.commandBar.Value() != "" {
		t.Fatalf("expected right arrow to avoid mutating the command bar, got %q", next.commandBar.Value())
	}
}

func TestColonOpensCommandPaletteFromNonActivityView(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.setActiveView(viewOverview)

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(":")})
	if cmd != nil {
		t.Fatalf("expected command palette open without extra command")
	}
	next := updated.(Model)
	if next.overlay.Mode != overlayPalette {
		t.Fatalf("expected : to open the command palette outside the activity view, got %#v", next.overlay.Mode)
	}
}

func TestEscReturnsToActivityFromSecondaryView(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.setActiveView(viewTree)
	model.focus = focusContent
	model.setActiveView(viewStatus)
	model.focus = focusContent

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if cmd != nil {
		t.Fatalf("expected esc back navigation without extra command")
	}
	next := updated.(Model)
	if next.activeView != viewActivity {
		t.Fatalf("expected esc to restore activity, got %s", next.activeView)
	}
}

func TestEscDoesNothingInRootActivityView(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.focus = focusContent
	model.commandBar.SetValue("log")

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if cmd != nil {
		t.Fatalf("expected esc in the root activity view to stay inert")
	}
	next := updated.(Model)
	if next.activeView != viewActivity {
		t.Fatalf("expected esc in activity to keep the activity view, got %s", next.activeView)
	}
	if next.commandBar.Value() != "log" {
		t.Fatalf("expected esc in activity to keep the typed command, got %q", next.commandBar.Value())
	}
}

func TestCtrlFOpensSectionSearchOverlay(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.focus = focusContent

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyCtrlF})
	if cmd != nil {
		t.Fatalf("expected section search overlay to open synchronously")
	}
	next := updated.(Model)
	if next.overlay.Mode != overlayFilter {
		t.Fatalf("expected ctrl+f to open the section search overlay, got %#v", next.overlay.Mode)
	}
	if next.overlay.Title != "Search section" {
		t.Fatalf("expected search overlay title, got %q", next.overlay.Title)
	}
}

func TestSidebarPanelShowsHiddenEntriesWhenScrolled(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 120
	model.height = 18
	model.sidebarIndex = len(model.sidebar) - 1

	rendered := model.renderSidebarPanel(38, 10)
	if !strings.Contains(rendered, "earlier entries hidden") {
		t.Fatalf("expected hidden-entry marker in sidebar: %s", rendered)
	}
	if strings.Contains(rendered, "Overview") {
		t.Fatalf("expected earliest sidebar entry to be scrolled out of the visible window: %s", rendered)
	}
	if !strings.Contains(rendered, "Help") {
		t.Fatalf("expected trailing sidebar actions to remain visible: %s", rendered)
	}
}

func TestQNoLongerQuitsWhileWatcherActive(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.watchEnabled = true
	model.pendingPaths = []string{"src/app.ts"}
	model.pendingJobKind = "refresh"

	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("q")})
	next, ok := updated.(Model)
	if !ok {
		t.Fatalf("expected updated model value, got %T", updated)
	}
	if next.focus != model.focus {
		t.Fatalf("expected q to leave focus unchanged, got %d", next.focus)
	}
	if next.commandBar.Value() != "q" {
		t.Fatalf("expected q to remain available for typing, got %q", next.commandBar.Value())
	}
}

func TestPaletteExitCommandQuits(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.openPalette()
	model.overlay.Input.SetValue("exit")

	cmd := model.submitPaletteSelection()
	if cmd == nil {
		t.Fatal("expected exit to return a quit command")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatalf("expected tea.QuitMsg from exit")
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
	if filepath.Dir(exported.path) != filepath.Join(root, ".scplus", "exports") {
		t.Fatalf("expected export path under .scplus/exports, got %s", exported.path)
	}
}

func TestFindHubItemsPreserveSuggestedBadge(t *testing.T) {
	items := buildFindHubItems(strings.Join([]string{
		`Ranked hubs for: "scheduler observability"`,
		`Ranking mode: both`,
		`Candidates: 2`,
		``,
		`1. .scplus/hubs/observability.md [manual] score=0.931`,
		`   Title: Observability`,
		`   Keyword: 0.800 | Semantic: 0.990`,
		``,
		`2. .scplus/hubs/scheduler-ops.md [suggested] score=0.812`,
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

func TestRestoreLetterShortcutIsDisabled(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.setRestorePoints([]backend.RestorePoint{
		{ID: "rp-123", Timestamp: 1, Message: "before refactor", Files: []string{"src/index.ts"}},
	})
	model.setActiveView(viewRestore)
	model.focus = focusContent
	model.client = nil

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("u")})
	if cmd != nil {
		t.Fatalf("expected plain letter restore shortcut to stay disabled, got command %v", cmd)
	}
	next := updated.(Model)
	if next.job("restore").Phase == "restore" {
		t.Fatalf("expected restore job to remain idle without a slash command, got %#v", next.job("restore"))
	}
}

func TestMouseEventsAreIgnored(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 160
	model.height = 40
	model.focus = focusContent

	updated, cmd := model.Update(tea.MouseMsg{X: 10, Y: 34, Button: tea.MouseButtonLeft, Action: tea.MouseActionPress})
	if cmd != nil {
		t.Fatalf("expected mouse events to be ignored without extra command")
	}
	next := updated.(Model)
	if next.focus != focusContent {
		t.Fatalf("expected mouse input to leave focus unchanged, got %d", next.focus)
	}
}

func TestMouseWheelScrollsIssueWindow(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = 100
	model.height = 24
	model.lastError = strings.Repeat("issue line that should scroll\n", 20)
	if cmd := model.executePaletteAction("open-issue"); cmd != nil {
		t.Fatalf("expected issue window open without async command")
	}
	before := model.detail.YOffset

	updated, cmd := model.Update(tea.MouseMsg{Button: tea.MouseButtonWheelDown, Action: tea.MouseActionPress})
	if cmd != nil {
		t.Fatalf("expected wheel scrolling to stay synchronous")
	}
	next := updated.(Model)
	if next.detail.YOffset <= before {
		t.Fatalf("expected wheel down to scroll the issue window, before=%d after=%d", before, next.detail.YOffset)
	}
}
