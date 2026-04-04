// summary: Exercises navigation, shortcuts, exports, and mouse behavior in the operator console model.
// FEATURE: verifies issue and log views, palette navigation, exports, and pointer input handling.
// inputs: Bubble Tea key or mouse events, model state fixtures, and backend restore-point fixtures.
// outputs: Verified operator-console navigation state, rendered view constraints, and export side effects.

package ui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"scplus-cli/cli/internal/backend"
)

func TestIssueSlashCommandOpensFullIssueWindow(t *testing.T) {
	model := NewModel("/tmp/scplus", nil)
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
	model := NewModel("/tmp/scplus", nil)
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
	model := NewModel("/tmp/scplus", nil)
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
	model := NewModel("/tmp/scplus", nil)
	model.width = 113
	model.height = 27
	indexJob := model.job("index")
	indexJob.State = "failed"
	indexJob.Phase = "failed"
	indexJob.Message = "File search refresh blocked for /home/cesar514/Documents/agent_programming/scplus: TODO_COMPLETED.md: refresh would remove an indexed file without replacement: text index candidate exceeds max embed file size."
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
	model := NewModel("/tmp/scplus", nil)
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
	if strings.Contains(rendered, "/\\") || strings.Contains(rendered, "\\_\\/_/") {
		t.Fatalf("expected command mode to render without the removed mascot: %s", rendered)
	}
}

func TestCtrlXRequestsGlobalShutdown(t *testing.T) {
	model := NewModel("/tmp/scplus", nil)
	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyCtrlX})
	if cmd == nil {
		t.Fatal("expected Ctrl+X to return a quit command")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatalf("expected tea.QuitMsg from Ctrl+X")
	}
	nextModel, ok := next.(Model)
	if !ok {
		t.Fatalf("expected Model after Ctrl+X, got %T", next)
	}
	if !nextModel.RequestedGlobalShutdown() {
		t.Fatal("expected Ctrl+X to request global shutdown")
	}
}

func TestLogSlashCommandOpensFullLogWindow(t *testing.T) {
	model := NewModel("/tmp/scplus", nil)
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
	model := NewModel("/tmp/scplus", nil)
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
	model := NewModel("/tmp/scplus", nil)
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
	model := NewModel("/tmp/scplus", nil)
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
	model := NewModel("/tmp/scplus", nil)
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
	model := NewModel("/tmp/scplus", nil)
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
	model := NewModel("/tmp/scplus", nil)
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
	model := NewModel("/tmp/scplus", nil)
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
	model := NewModel("/tmp/scplus", nil)
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
	model := NewModel("/tmp/scplus", nil)
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
	model := NewModel("/tmp/scplus", nil)
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
	model := NewModel("/tmp/scplus", nil)
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
