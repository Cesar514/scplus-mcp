// Human CLI operator console state and rendering.
// FEATURE: keeps pane layout, typed section state, and backend-driven actions.
package ui

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"contextplusplus/cli/internal/backend"
	"contextplusplus/cli/internal/hubs"
	"github.com/charmbracelet/bubbles/list"
	"github.com/charmbracelet/bubbles/table"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

const (
	viewOverview   = "overview"
	viewTree       = "tree"
	viewHubs       = "hubs"
	viewFindHub    = "find-hub"
	viewRestore    = "restore"
	viewCluster    = "cluster"
	viewDeps       = "deps"
	viewStatus     = "status"
	viewChanges    = "changes"
	viewSearch     = "search"
	viewSymbol     = "symbol"
	viewWord       = "word"
	viewOutline    = "outline"
	viewResearch   = "research"
	viewLint       = "lint"
	viewBlast      = "blast-radius"
	viewCheckpoint = "checkpoint"
)

const (
	focusSidebar = iota
	focusContent
	focusDetail
	focusJobs
	focusLogs
	focusWizard
	focusOverlay
)

const (
	minSidebarWidth  = 26
	minContentWidth  = 32
	minDetailWidth   = 36
	minJobsHeight    = 7
	minJobsWidth     = 48
	minLogsWidth     = 42
	narrowLayoutCut  = 112
	stackedHeightCut = 30
)

var magicianFrames = []string{
	`   /\_
 _( o.o)
  > ^ <
 /|_|_\
  / \ `,
	`   /\_
 _( -.-)
  > ^ <
 /|_|_\
 _/ \_`,
	`   /\_
 _( o.o)
  > ^ <
 /|_|_\
 /_ _\`,
}

var (
	titleStyle       = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("205"))
	subtitleStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("111"))
	cardStyle        = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(lipgloss.Color("63")).Padding(0, 1)
	footerStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	statusLineStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("229")).Background(lipgloss.Color("238")).Padding(0, 1)
	errorStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Bold(true)
	sidebarActive    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("229")).Background(lipgloss.Color("62")).Padding(0, 1)
	sidebarIdle      = lipgloss.NewStyle().Foreground(lipgloss.Color("252")).Padding(0, 1)
	sidebarSelected  = lipgloss.NewStyle().Foreground(lipgloss.Color("229")).Background(lipgloss.Color("238")).Padding(0, 1)
	contentSelected  = lipgloss.NewStyle().Foreground(lipgloss.Color("229")).Background(lipgloss.Color("238")).Padding(0, 1)
	contentIdle      = lipgloss.NewStyle().Padding(0, 1)
	detailHeader     = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("224"))
	paneHeaderActive = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("229"))
	paneHeaderIdle   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("247"))
)

type doctorLoadedMsg struct {
	report backend.DoctorReport
	err    error
}

type textLoadedMsg struct {
	kind string
	text string
	err  error
}

type statusLoadedMsg struct {
	summary backend.RepoStatusSummary
	err     error
}

type changesLoadedMsg struct {
	summary backend.RepoChangesSummary
	err     error
}

type restoreLoadedMsg struct {
	points []backend.RestorePoint
	err    error
}

type indexFinishedMsg struct {
	output string
	err    error
}

type hubCreatedMsg struct {
	path string
	err  error
}

type commandLoadedMsg struct {
	jobID       string
	viewID      string
	title       string
	subtitle    string
	rawText     string
	items       []contentItem
	logMessage  string
	refreshData bool
	err         error
}

type exportFinishedMsg struct {
	path string
	err  error
}

type frameMsg time.Time

type backendEventMsg struct {
	event backend.Event
}

type wizardState struct {
	active  bool
	focus   int
	busy    bool
	message string
	inputs  []textinput.Model
}

type navigationEntry struct {
	ID       string
	Title    string
	Subtitle string
	IsAction bool
	Action   string
}

type contentItem struct {
	ID      string
	Title   string
	Summary string
	Detail  string
	Badge   string
}

type navigationSnapshot struct {
	ActiveView     string
	Focus          int
	SidebarIndex   int
	SectionSelect  map[string]int
	SectionFilters map[string]string
}

type overlayMode string

const (
	overlayNone    overlayMode = ""
	overlayHelp    overlayMode = "help"
	overlayPalette overlayMode = "palette"
	overlayPrompt  overlayMode = "prompt"
	overlayFilter  overlayMode = "filter"
)

type paletteCommand struct {
	ID                   string
	Title                string
	Subtitle             string
	Action               string
	JobID                string
	InputLabel           string
	InputPlaceholder     string
	SecondaryLabel       string
	SecondaryPlaceholder string
	RequiresInput        bool
	RequiresSecondary    bool
}

type overlayState struct {
	Mode             overlayMode
	Title            string
	Subtitle         string
	Message          string
	Input            textinput.Model
	Secondary        textinput.Model
	Commands         []paletteCommand
	Selected         int
	Command          paletteCommand
	TargetSectionID  string
	PreviousFocus    int
	SecondaryEnabled bool
}

type sectionKind int

const (
	sectionList sectionKind = iota
	sectionTable
)

type contentListItem struct {
	item contentItem
}

func (i contentListItem) Title() string       { return i.item.Title }
func (i contentListItem) Description() string { return i.item.Summary }
func (i contentListItem) FilterValue() string {
	return strings.ToLower(strings.TrimSpace(strings.Join([]string{i.item.Title, i.item.Summary, i.item.Badge}, " ")))
}

type sectionState struct {
	ID           string
	Title        string
	Subtitle     string
	Kind         sectionKind
	BaseItems    []contentItem
	Items        []contentItem
	BaseRows     []table.Row
	RawText      string
	FilterQuery  string
	List         list.Model
	Table        table.Model
	Selected     int
	EmptyMessage string
}

type jobState struct {
	ID             string
	Title          string
	State          string
	Phase          string
	Message        string
	CurrentFile    string
	Percent        *int
	ElapsedMs      int
	QueueDepth     int
	Source         string
	Mode           string
	RebuildReason  string
	Pending        bool
	LastUpdatedAt  time.Time
	LastSuccessful string
}

type Model struct {
	root           string
	client         *backend.Client
	width          int
	height         int
	magicianFrame  int
	doctor         backend.DoctorReport
	doctorLoaded   bool
	restorePoints  []backend.RestorePoint
	detail         viewport.Model
	logViewport    viewport.Model
	logs           []string
	lastError      string
	watchEnabled   bool
	backendOnline  bool
	queueDepth     int
	pendingPaths   []string
	pendingJobKind string
	focus          int
	activeView     string
	sidebarIndex   int
	sidebar        []navigationEntry
	sections       map[string]*sectionState
	jobs           map[string]*jobState
	jobOrder       []string
	jobTable       table.Model
	refreshPending int
	wizard         wizardState
	overlay        overlayState
	history        []navigationSnapshot
	historyIndex   int
	historyPaused  bool
}

func NewModel(root string, client *backend.Client) Model {
	detail := viewport.New(60, 20)
	logViewport := viewport.New(60, 8)
	jobTable := table.New(
		table.WithColumns([]table.Column{
			{Title: "Task", Width: 10},
			{Title: "State", Width: 11},
			{Title: "Phase", Width: 18},
			{Title: "%", Width: 4},
			{Title: "Current", Width: 26},
			{Title: "Elapsed", Width: 9},
			{Title: "Q", Width: 4},
		}),
		table.WithRows(nil),
		table.WithHeight(7),
		table.WithFocused(true),
	)
	model := Model{
		root:          root,
		client:        client,
		width:         120,
		height:        38,
		detail:        detail,
		logViewport:   logViewport,
		logs:          []string{"context++ CLI started."},
		wizard:        newWizardState(),
		backendOnline: true,
		activeView:    viewOverview,
		focus:         focusSidebar,
		jobTable:      jobTable,
		sections: map[string]*sectionState{
			viewOverview:   newListSection(viewOverview, "Overview", "Operator health and observability summary", "Loading doctor report..."),
			viewTree:       newListSection(viewTree, "Tree", "Prepared structural tree context", "Loading tree view..."),
			viewHubs:       newListSection(viewHubs, "Hubs", "Feature hubs and suggestions", "Loading hub view..."),
			viewFindHub:    newListSection(viewFindHub, "Find hub", "Ranked hub discovery and suggestion triage", "Run a find-hub command to load results."),
			viewRestore:    newListSection(viewRestore, "Restore", "Restore-point history", "Loading restore points..."),
			viewCluster:    newListSection(viewCluster, "Cluster", "Persisted semantic cluster summaries", "Loading cluster view..."),
			viewDeps:       newListSection(viewDeps, "Dependencies", "Direct and reverse dependency graph browsing", "Run a dependency command to load results."),
			viewStatus:     newTableSection(viewStatus, "Status", "Git worktree status table", "Loading repo status...", []table.Column{{Title: "Path", Width: 32}, {Title: "Index", Width: 8}, {Title: "Worktree", Width: 10}}),
			viewChanges:    newTableSection(viewChanges, "Changes", "Git change summary table", "Loading repo changes...", []table.Column{{Title: "Path", Width: 30}, {Title: "+/-", Width: 12}, {Title: "State", Width: 18}}),
			viewSearch:     newListSection(viewSearch, "Search", "Exact and related ranked engine search results", "Run a search command to load results."),
			viewSymbol:     newListSection(viewSymbol, "Symbol", "Exact symbol lookup output", "Run a symbol command to load results."),
			viewWord:       newListSection(viewWord, "Word", "Exact word lookup output", "Run a word command to load results."),
			viewOutline:    newListSection(viewOutline, "Outline", "Prepared file outline output", "Run an outline command to load results."),
			viewResearch:   newListSection(viewResearch, "Research", "Broad explanation-backed research reports", "Run a research command to load results."),
			viewLint:       newListSection(viewLint, "Lint", "Native lint diagnostics and scoring", "Run a lint command to load results."),
			viewBlast:      newListSection(viewBlast, "Blast radius", "Symbol usage graph and blast radius output", "Run a blast-radius command to load results."),
			viewCheckpoint: newListSection(viewCheckpoint, "Checkpoint", "Checkpoint write and restore-save output", "Run a checkpoint command to load results."),
		},
	}
	model.overlay = newOverlayState()
	model.seedJobs()
	model.refreshSidebar()
	model.syncDetailViewport()
	model.syncLogViewport(true)
	model.recordNavigation()
	return model
}

func newListSection(id string, title string, subtitle string, empty string) *sectionState {
	delegate := list.NewDefaultDelegate()
	delegate.ShowDescription = true
	model := list.New([]list.Item{}, delegate, 0, 0)
	model.SetShowTitle(false)
	model.SetShowStatusBar(false)
	model.SetShowHelp(false)
	model.SetShowPagination(false)
	model.SetFilteringEnabled(false)
	model.DisableQuitKeybindings()
	return &sectionState{
		ID:           id,
		Title:        title,
		Subtitle:     subtitle,
		Kind:         sectionList,
		List:         model,
		EmptyMessage: empty,
	}
}

func newTableSection(id string, title string, subtitle string, empty string, columns []table.Column) *sectionState {
	model := table.New(
		table.WithColumns(columns),
		table.WithRows(nil),
		table.WithHeight(8),
		table.WithFocused(true),
	)
	return &sectionState{
		ID:           id,
		Title:        title,
		Subtitle:     subtitle,
		Kind:         sectionTable,
		Table:        model,
		EmptyMessage: empty,
	}
}

func newJobState(id string, title string) *jobState {
	return &jobState{
		ID:    id,
		Title: title,
		State: "idle",
	}
}

func newWizardState() wizardState {
	title := textinput.New()
	title.Placeholder = "Hub title"
	title.Prompt = "Title: "
	title.Focus()
	summary := textinput.New()
	summary.Placeholder = "One-line hub summary"
	summary.Prompt = "Summary: "
	files := textinput.New()
	files.Placeholder = "src/index.ts, README.md"
	files.Prompt = "Files: "
	return wizardState{
		inputs: []textinput.Model{title, summary, files},
	}
}

func newOverlayInput(prompt string, placeholder string) textinput.Model {
	input := textinput.New()
	input.Prompt = prompt
	input.Placeholder = placeholder
	return input
}

func newOverlayState() overlayState {
	return overlayState{
		Input:     newOverlayInput("> ", "Type to filter commands"),
		Secondary: newOverlayInput("> ", ""),
	}
}

func paletteCommands() []paletteCommand {
	return []paletteCommand{
		{ID: "open-status", Title: "Open status", Subtitle: "Jump to the git worktree status table", Action: "open-status"},
		{ID: "open-changes", Title: "Open changes", Subtitle: "Jump to changed-file stats and ranges", Action: "open-changes"},
		{ID: "find-hub", Title: "Find hub", Subtitle: "Rank hubs by keyword and semantic relevance", Action: "find-hub", JobID: "query", RequiresInput: true, InputLabel: "Query: ", InputPlaceholder: "scheduler observability"},
		{ID: "exact-lookup", Title: "Exact lookup", Subtitle: "Run exact mixed search against the fast substrate", Action: "exact-lookup", JobID: "query", RequiresInput: true, InputLabel: "Query: ", InputPlaceholder: "runSearchByIntent"},
		{ID: "search-related", Title: "Search related", Subtitle: "Run related discovery over prepared ranked results", Action: "search-related", JobID: "query", RequiresInput: true, InputLabel: "Query: ", InputPlaceholder: "scheduler observability"},
		{ID: "research", Title: "Research", Subtitle: "Build the broad explanation-backed research report", Action: "research", JobID: "query", RequiresInput: true, InputLabel: "Query: ", InputPlaceholder: "operator console architecture"},
		{ID: "go-file", Title: "Go to file", Subtitle: "Find an exact file/path hit and open it in Search", Action: "go-file", JobID: "query", RequiresInput: true, InputLabel: "File query: ", InputPlaceholder: "cli/internal/ui/model.go"},
		{ID: "go-symbol", Title: "Go to symbol", Subtitle: "Find an exact symbol hit and open it in Search", Action: "go-symbol", JobID: "query", RequiresInput: true, InputLabel: "Symbol: ", InputPlaceholder: "runSearchByIntent"},
		{ID: "symbol-lookup", Title: "Symbol lookup", Subtitle: "Run the exact symbol tool over the prepared substrate", Action: "symbol-lookup", JobID: "query", RequiresInput: true, InputLabel: "Symbol: ", InputPlaceholder: "runSearchByIntent"},
		{ID: "word-lookup", Title: "Word lookup", Subtitle: "Scan exact word hits in the prepared fast cache", Action: "word-lookup", JobID: "query", RequiresInput: true, InputLabel: "Word: ", InputPlaceholder: "watcher"},
		{ID: "outline-file", Title: "Outline file", Subtitle: "Load the prepared file outline for one file", Action: "outline-file", JobID: "query", RequiresInput: true, InputLabel: "File path: ", InputPlaceholder: "src/tools/query-intent.ts"},
		{ID: "deps-file", Title: "Dependencies", Subtitle: "Load direct and reverse deps for one file", Action: "deps-file", JobID: "query", RequiresInput: true, InputLabel: "Target path: ", InputPlaceholder: "src/tools/query-intent.ts"},
		{ID: "lint", Title: "Lint", Subtitle: "Run the native linter for the repo or one target path", Action: "lint", JobID: "lint", RequiresInput: true, InputLabel: "Target path: ", InputPlaceholder: "leave blank for full repo"},
		{ID: "blast-radius", Title: "Blast radius", Subtitle: "Trace where one symbol is used across the repo", Action: "blast-radius", JobID: "query", RequiresInput: true, RequiresSecondary: true, InputLabel: "Symbol: ", InputPlaceholder: "runSearchByIntent", SecondaryLabel: "File context: ", SecondaryPlaceholder: "optional defining file"},
		{ID: "checkpoint-detail", Title: "Checkpoint detail", Subtitle: "Save the selected detail content to a repo file", Action: "checkpoint-detail", JobID: "restore", RequiresInput: true, InputLabel: "File path: ", InputPlaceholder: "notes/operator-snapshot.txt"},
		{ID: "restore-point", Title: "Restore point", Subtitle: "Restore one recorded checkpoint by id", Action: "restore-point", JobID: "restore", RequiresInput: true, InputLabel: "Restore id: ", InputPlaceholder: "rp-..."},
	}
}

func (m *Model) seedJobs() {
	m.jobOrder = []string{"index", "refresh", "restore", "lint", "query"}
	m.jobs = map[string]*jobState{
		"index":   newJobState("index", "Index"),
		"refresh": newJobState("refresh", "Refresh"),
		"restore": newJobState("restore", "Restore"),
		"lint":    newJobState("lint", "Lint"),
		"query":   newJobState("query", "Query"),
	}
	m.refreshJobTable()
}

func (m *Model) job(id string) *jobState {
	if m.jobs == nil {
		m.seedJobs()
	}
	job, ok := m.jobs[id]
	if ok {
		return job
	}
	job = newJobState(id, titleFromID(id))
	m.jobs[id] = job
	m.jobOrder = append(m.jobOrder, id)
	return job
}

func (m *Model) refreshJobTable() {
	rows := make([]table.Row, 0, len(m.jobOrder))
	for _, id := range m.jobOrder {
		job := m.jobs[id]
		if job == nil {
			continue
		}
		rows = append(rows, table.Row{
			job.Title,
			jobStateLabel(job),
			truncate(formatBlankAsNone(job.Phase), 18),
			formatJobPercent(job.Percent),
			truncate(formatBlankAsNone(job.CurrentFile), 26),
			formatElapsedMs(job.ElapsedMs),
			fmt.Sprintf("%d", job.QueueDepth),
		})
	}
	m.jobTable.SetRows(rows)
	if len(rows) == 0 {
		m.jobTable.SetCursor(0)
		return
	}
	if m.jobTable.Cursor() >= len(rows) {
		m.jobTable.SetCursor(len(rows) - 1)
	}
}

func (m *Model) selectedJob() *jobState {
	if len(m.jobOrder) == 0 {
		return nil
	}
	cursor := m.jobTable.Cursor()
	if cursor < 0 {
		cursor = 0
	}
	if cursor >= len(m.jobOrder) {
		cursor = len(m.jobOrder) - 1
	}
	return m.jobs[m.jobOrder[cursor]]
}

func (m *Model) activeStatusJob() *jobState {
	for _, id := range []string{"index", "refresh", "restore", "lint", "query"} {
		job := m.job(id)
		if isActiveJobState(job.State) {
			return job
		}
	}
	return m.job("index")
}

func (m *Model) pendingChangeCount() int {
	return len(m.pendingPaths)
}

func (m *Model) pendingJobLabel() string {
	switch m.pendingJobKind {
	case "index":
		return "full rebuild"
	case "refresh":
		return "refresh"
	default:
		return "job"
	}
}

func (m *Model) syncLiveSchedulerSnapshot() {
	if !m.doctorLoaded {
		return
	}
	m.doctor.Observability.Scheduler.WatchEnabled = m.watchEnabled
	m.doctor.Observability.Scheduler.QueueDepth = m.queueDepth
	m.doctor.Observability.Scheduler.PendingChangeCount = len(m.pendingPaths)
	m.doctor.Observability.Scheduler.PendingPaths = append([]string(nil), m.pendingPaths...)
	m.doctor.Observability.Scheduler.PendingJobKind = m.pendingJobKind
}

func (m *Model) syncLogViewport(follow bool) {
	previousOffset := m.logViewport.YOffset
	width := m.width - minJobsWidth - 8
	if m.useStackedLayout() {
		width = m.width - 4
	}
	if width < minLogsWidth {
		width = minLogsWidth
	}
	height := max(6, m.height/4)
	if m.useStackedLayout() {
		height = max(6, m.height/5)
	}
	m.logViewport.Width = width
	m.logViewport.Height = height
	if len(m.logs) == 0 {
		m.logViewport.SetContent("No backend activity yet.")
		return
	}
	m.logViewport.SetContent(strings.Join(m.logs, "\n"))
	if follow {
		m.logViewport.GotoBottom()
		return
	}
	m.logViewport.SetYOffset(previousOffset)
}

func (m *Model) startRefreshJob(message string, pending int) {
	job := m.job("refresh")
	job.State = "running"
	job.Phase = "snapshot-refresh"
	job.Message = message
	job.ElapsedMs = 0
	job.QueueDepth = m.queueDepth
	job.Percent = intPtr(0)
	job.CurrentFile = fmt.Sprintf("%d backend reads queued", pending)
	job.LastUpdatedAt = time.Now()
	m.refreshPending = pending
	m.refreshJobTable()
}

func (m *Model) finishRefreshSubtask(task string, err error) {
	if m.refreshPending <= 0 {
		return
	}
	m.refreshPending--
	job := m.job("refresh")
	job.LastUpdatedAt = time.Now()
	if err != nil {
		job.State = "failed"
		job.Message = err.Error()
		job.Phase = task
		job.Percent = nil
		job.CurrentFile = task
		m.refreshPending = 0
		m.refreshJobTable()
		return
	}
	completed := 7 - m.refreshPending
	if completed < 0 {
		completed = 0
	}
	job.Phase = task
	job.Message = "backend snapshots refreshed"
	job.CurrentFile = task
	job.Percent = intPtr(min(100, (completed*100)/7))
	if m.refreshPending == 0 {
		job.State = "completed"
		job.ElapsedMs = 0
		job.LastSuccessful = time.Now().Format(time.RFC3339)
		job.CurrentFile = "doctor/tree/hubs/cluster/restore/status/changes"
	}
	m.refreshJobTable()
}

func animateCmd() tea.Cmd {
	return tea.Tick(220*time.Millisecond, func(t time.Time) tea.Msg {
		return frameMsg(t)
	})
}

func loadDoctorCmd(client *backend.Client, root string) tea.Cmd {
	return func() tea.Msg {
		report, err := client.Doctor(context.Background(), root)
		return doctorLoadedMsg{report: report, err: err}
	}
}

func loadTreeCmd(client *backend.Client, root string) tea.Cmd {
	return func() tea.Msg {
		payload, err := client.Tree(context.Background(), root)
		return textLoadedMsg{kind: viewTree, text: payload.Text, err: err}
	}
}

func loadHubsCmd(client *backend.Client, root string) tea.Cmd {
	return func() tea.Msg {
		payload, err := client.Hubs(context.Background(), root)
		return textLoadedMsg{kind: viewHubs, text: payload.Text, err: err}
	}
}

func loadClusterCmd(client *backend.Client, root string) tea.Cmd {
	return func() tea.Msg {
		payload, err := client.Cluster(context.Background(), root)
		return textLoadedMsg{kind: viewCluster, text: payload.Text, err: err}
	}
}

func loadRestorePointsCmd(client *backend.Client, root string) tea.Cmd {
	return func() tea.Msg {
		points, err := client.RestorePoints(context.Background(), root)
		return restoreLoadedMsg{points: points, err: err}
	}
}

func loadStatusCmd(client *backend.Client, root string) tea.Cmd {
	return func() tea.Msg {
		summary, err := client.Status(context.Background(), root)
		return statusLoadedMsg{summary: summary, err: err}
	}
}

func loadChangesCmd(client *backend.Client, root string) tea.Cmd {
	return func() tea.Msg {
		summary, err := client.Changes(context.Background(), root, "", 20)
		return changesLoadedMsg{summary: summary, err: err}
	}
}

func runIndexCmd(client *backend.Client, root string) tea.Cmd {
	return func() tea.Msg {
		output, err := client.Index(context.Background(), root, "full")
		return indexFinishedMsg{output: output, err: err}
	}
}

func createHubCmd(root string, wizard wizardState) tea.Cmd {
	title := wizard.inputs[0].Value()
	summary := wizard.inputs[1].Value()
	files := wizard.inputs[2].Value()
	return func() tea.Msg {
		path, err := hubs.CreateHub(root, title, summary, files)
		return hubCreatedMsg{path: path, err: err}
	}
}

func waitForBackendEventCmd(events <-chan backend.Event) tea.Cmd {
	return func() tea.Msg {
		event, ok := <-events
		if !ok {
			return backendEventMsg{event: backend.Event{Kind: "disconnect", Message: "backend session closed"}}
		}
		return backendEventMsg{event: event}
	}
}

func refreshAllCmd(client *backend.Client, root string) tea.Cmd {
	return tea.Batch(
		loadDoctorCmd(client, root),
		loadTreeCmd(client, root),
		loadHubsCmd(client, root),
		loadClusterCmd(client, root),
		loadRestorePointsCmd(client, root),
		loadStatusCmd(client, root),
		loadChangesCmd(client, root),
	)
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(animateCmd(), refreshAllCmd(m.client, m.root), waitForBackendEventCmd(m.client.Events()))
}

func (m *Model) appendLog(line string) {
	timestamp := time.Now().Format("15:04:05")
	m.logs = append(m.logs, fmt.Sprintf("[%s] %s", timestamp, line))
	m.syncLogViewport(true)
}

func (m *Model) setError(err error) {
	if err == nil {
		m.lastError = ""
		return
	}
	m.lastError = err.Error()
	m.appendLog("ERROR: " + err.Error())
}

func (m *Model) captureNavigationSnapshot() navigationSnapshot {
	sectionSelect := make(map[string]int, len(m.sections))
	sectionFilters := make(map[string]string, len(m.sections))
	for id, section := range m.sections {
		sectionSelect[id] = section.Selected
		sectionFilters[id] = section.FilterQuery
	}
	return navigationSnapshot{
		ActiveView:     m.activeView,
		Focus:          m.focus,
		SidebarIndex:   m.sidebarIndex,
		SectionSelect:  sectionSelect,
		SectionFilters: sectionFilters,
	}
}

func sameNavigationSnapshot(left navigationSnapshot, right navigationSnapshot) bool {
	if left.ActiveView != right.ActiveView || left.Focus != right.Focus || left.SidebarIndex != right.SidebarIndex {
		return false
	}
	if len(left.SectionSelect) != len(right.SectionSelect) || len(left.SectionFilters) != len(right.SectionFilters) {
		return false
	}
	for key, value := range left.SectionSelect {
		if right.SectionSelect[key] != value {
			return false
		}
	}
	for key, value := range left.SectionFilters {
		if right.SectionFilters[key] != value {
			return false
		}
	}
	return true
}

func (m *Model) restoreNavigationSnapshot(snapshot navigationSnapshot) {
	m.historyPaused = true
	defer func() {
		m.historyPaused = false
	}()
	m.activeView = snapshot.ActiveView
	m.focus = snapshot.Focus
	m.sidebarIndex = snapshot.SidebarIndex
	for id, selected := range snapshot.SectionSelect {
		section := m.sections[id]
		if section == nil {
			continue
		}
		section.Selected = selected
	}
	for id, filterQuery := range snapshot.SectionFilters {
		section := m.sections[id]
		if section == nil {
			continue
		}
		section.FilterQuery = filterQuery
		m.applySectionFilter(section)
	}
	m.refreshSidebar()
	m.ensureSectionSelection(m.activeSection())
	m.syncDetailViewport()
}

func (m *Model) recordNavigation() {
	if m.historyPaused || m.overlay.Mode != overlayNone {
		return
	}
	snapshot := m.captureNavigationSnapshot()
	if len(m.history) > 0 && sameNavigationSnapshot(m.history[m.historyIndex], snapshot) {
		return
	}
	if m.historyIndex < len(m.history)-1 {
		m.history = append([]navigationSnapshot{}, m.history[:m.historyIndex+1]...)
	}
	m.history = append(m.history, snapshot)
	m.historyIndex = len(m.history) - 1
}

func (m *Model) navigateHistory(delta int) {
	if len(m.history) == 0 {
		return
	}
	next := m.historyIndex + delta
	if next < 0 || next >= len(m.history) {
		return
	}
	m.historyIndex = next
	m.restoreNavigationSnapshot(m.history[m.historyIndex])
}

func (m *Model) applySectionFilter(section *sectionState) {
	if section == nil {
		return
	}
	query := strings.ToLower(strings.TrimSpace(section.FilterQuery))
	if query == "" {
		section.Items = append([]contentItem{}, section.BaseItems...)
		if section.Kind == sectionTable {
			section.Table.SetRows(append([]table.Row{}, section.BaseRows...))
		} else {
			listItems := make([]list.Item, 0, len(section.Items))
			for _, item := range section.Items {
				listItems = append(listItems, contentListItem{item: item})
			}
			section.List.SetItems(listItems)
		}
		m.ensureSectionSelection(section)
		return
	}
	filteredItems := make([]contentItem, 0, len(section.BaseItems))
	filteredRows := make([]table.Row, 0, len(section.BaseRows))
	for index, item := range section.BaseItems {
		haystack := strings.ToLower(strings.Join([]string{item.Title, item.Summary, item.Detail, item.Badge}, "\n"))
		if !strings.Contains(haystack, query) {
			continue
		}
		filteredItems = append(filteredItems, item)
		if section.Kind == sectionTable && index < len(section.BaseRows) {
			filteredRows = append(filteredRows, section.BaseRows[index])
		}
	}
	section.Items = filteredItems
	if section.Kind == sectionTable {
		section.Table.SetRows(filteredRows)
	} else {
		listItems := make([]list.Item, 0, len(filteredItems))
		for _, item := range filteredItems {
			listItems = append(listItems, contentListItem{item: item})
		}
		section.List.SetItems(listItems)
	}
	m.ensureSectionSelection(section)
}

func (m *Model) openHelpOverlay() {
	m.overlay = newOverlayState()
	m.overlay.Mode = overlayHelp
	m.overlay.Title = "Help"
	m.overlay.Subtitle = "Navigation, command, filter, export, and mouse bindings"
	m.overlay.PreviousFocus = m.focus
	m.focus = focusOverlay
}

func (m *Model) openPalette() {
	m.overlay = newOverlayState()
	m.overlay.Mode = overlayPalette
	m.overlay.Title = "Command palette"
	m.overlay.Subtitle = "Search commands, run backend actions, and jump to exact results"
	m.overlay.PreviousFocus = m.focus
	m.overlay.Commands = paletteCommands()
	m.overlay.Input.Focus()
	m.focus = focusOverlay
}

func (m *Model) openFilterOverlay() {
	section := m.activeSection()
	m.overlay = newOverlayState()
	m.overlay.Mode = overlayFilter
	m.overlay.Title = "Filter section"
	m.overlay.Subtitle = fmt.Sprintf("Filter %s items in-place", section.Title)
	m.overlay.PreviousFocus = m.focus
	m.overlay.TargetSectionID = section.ID
	m.overlay.Input = newOverlayInput("Filter: ", "type to narrow the current section")
	m.overlay.Input.SetValue(section.FilterQuery)
	m.overlay.Input.Focus()
	m.focus = focusOverlay
}

func (m *Model) openPromptOverlay(command paletteCommand) {
	m.overlay = newOverlayState()
	m.overlay.Mode = overlayPrompt
	m.overlay.Title = command.Title
	m.overlay.Subtitle = command.Subtitle
	m.overlay.Command = command
	m.overlay.PreviousFocus = m.focus
	m.overlay.Input = newOverlayInput(command.InputLabel, command.InputPlaceholder)
	m.overlay.Input.Focus()
	m.overlay.SecondaryEnabled = command.RequiresSecondary
	if command.RequiresSecondary {
		m.overlay.Secondary = newOverlayInput(command.SecondaryLabel, command.SecondaryPlaceholder)
	}
	m.focus = focusOverlay
}

func (m *Model) closeOverlay() {
	previousFocus := m.overlay.PreviousFocus
	m.overlay = newOverlayState()
	if previousFocus == focusOverlay {
		previousFocus = focusContent
	}
	m.focus = previousFocus
	m.syncDetailViewport()
}

func (m *Model) filteredPaletteCommands() []paletteCommand {
	commands := m.overlay.Commands
	query := strings.ToLower(strings.TrimSpace(m.overlay.Input.Value()))
	if query == "" {
		return commands
	}
	filtered := make([]paletteCommand, 0, len(commands))
	for _, command := range commands {
		haystack := strings.ToLower(strings.Join([]string{command.Title, command.Subtitle, command.Action}, "\n"))
		if strings.Contains(haystack, query) {
			filtered = append(filtered, command)
		}
	}
	return filtered
}

func (m *Model) activePaletteCommand() (paletteCommand, bool) {
	commands := m.filteredPaletteCommands()
	if len(commands) == 0 {
		return paletteCommand{}, false
	}
	if m.overlay.Selected >= len(commands) {
		m.overlay.Selected = len(commands) - 1
	}
	if m.overlay.Selected < 0 {
		m.overlay.Selected = 0
	}
	return commands[m.overlay.Selected], true
}

func buildItemsForCommandView(viewID string, title string, rawText string) []contentItem {
	switch viewID {
	case viewFindHub:
		return buildFindHubItems(rawText)
	case viewDeps:
		return buildBlockItems("deps", rawText)
	case viewSymbol:
		return buildBlockItems("symbol", rawText)
	case viewWord:
		return buildBlockItems("word", rawText)
	case viewOutline:
		return buildBlockItems("outline", rawText)
	case viewResearch:
		return buildBlockItems("research", rawText)
	case viewLint:
		return buildBlockItems("lint", rawText)
	case viewBlast:
		return buildBlockItems("blast-radius", rawText)
	case viewCheckpoint:
		return buildBlockItems("checkpoint", rawText)
	default:
		return buildTextFallbackItems(title, rawText)
	}
}

func (m *Model) showCommandSection(viewID string, title string, subtitle string, items []contentItem, rawText string) {
	section := m.sections[viewID]
	if section == nil {
		return
	}
	section.Title = title
	section.Subtitle = subtitle
	section.EmptyMessage = "No results returned."
	section.RawText = rawText
	m.setListSectionItems(viewID, items)
	m.setActiveView(viewID)
	m.focus = focusContent
	m.refreshSidebar()
	m.recordNavigation()
}

func (m *Model) startOperatorJob(jobID string, phase string, message string, currentFile string) {
	job := m.job(jobID)
	job.State = "running"
	job.Phase = phase
	job.Message = message
	job.CurrentFile = currentFile
	job.ElapsedMs = 0
	job.Percent = nil
	job.LastUpdatedAt = time.Now()
	m.refreshJobTable()
}

func (m *Model) finishOperatorJob(jobID string, state string, message string) {
	job := m.job(jobID)
	job.State = state
	job.Message = message
	job.LastUpdatedAt = time.Now()
	if state == "completed" {
		job.LastSuccessful = time.Now().Format(time.RFC3339)
	}
	m.refreshJobTable()
}

func runSearchCommandCmd(client *backend.Client, root string, query string, intent string, searchType string, viewID string, title string, subtitle string) tea.Cmd {
	return func() tea.Msg {
		payload, err := client.Search(context.Background(), root, query, intent, searchType, 8)
		if err != nil {
			return commandLoadedMsg{jobID: "query", err: err}
		}
		return commandLoadedMsg{
			jobID:      "query",
			viewID:     viewID,
			title:      title,
			subtitle:   subtitle,
			rawText:    payload.Text,
			items:      buildSearchItems(payload),
			logMessage: fmt.Sprintf("%s completed for %q", title, query),
		}
	}
}

func runTextCommandCmd(jobID string, viewID string, title string, subtitle string, refreshData bool, loader func() (backend.TextPayload, error)) tea.Cmd {
	return func() tea.Msg {
		payload, err := loader()
		if err != nil {
			return commandLoadedMsg{jobID: jobID, err: err}
		}
		return commandLoadedMsg{
			jobID:       jobID,
			viewID:      viewID,
			title:       title,
			subtitle:    subtitle,
			rawText:     payload.Text,
			items:       buildItemsForCommandView(viewID, title, payload.Text),
			logMessage:  title + " completed",
			refreshData: refreshData,
		}
	}
}

func exportContentCmd(root string, name string, content string) tea.Cmd {
	return func() tea.Msg {
		if strings.TrimSpace(content) == "" {
			return exportFinishedMsg{err: errors.New("no exportable content is selected")}
		}
		exportDir := filepath.Join(root, ".contextplus", "exports")
		if err := os.MkdirAll(exportDir, 0o755); err != nil {
			return exportFinishedMsg{err: err}
		}
		filePath := filepath.Join(exportDir, fmt.Sprintf("%s-%s.txt", time.Now().Format("20060102-150405"), slugify(name)))
		if err := os.WriteFile(filePath, []byte(content), 0o644); err != nil {
			return exportFinishedMsg{err: err}
		}
		return exportFinishedMsg{path: filePath}
	}
}

func (m *Model) refreshSidebar() {
	watchLabel := "Enable watcher"
	watchSubtitle := "Watch for file changes and queue refresh work"
	if m.watchEnabled {
		watchLabel = "Disable watcher"
		watchSubtitle = "Stop watcher-driven refresh jobs"
	}
	if m.pendingChangeCount() > 0 {
		watchSubtitle = fmt.Sprintf("Changes detected (%d) | pending %s", m.pendingChangeCount(), m.pendingJobLabel())
	}
	indexJob := m.job("index")
	indexLabel := "Run full index"
	indexSubtitle := "Start a full engine refresh"
	if isActiveJobState(indexJob.State) {
		indexLabel = "Index running"
		indexSubtitle = fmt.Sprintf("Phase %s | queue %d", formatBlankAsNone(indexJob.Phase), indexJob.QueueDepth)
	}
	cancelLabel := "Cancel pending job"
	cancelSubtitle := "Clear queued watch work before it starts"
	if m.pendingChangeCount() > 0 {
		cancelLabel = "Cancel pending " + m.pendingJobLabel()
		cancelSubtitle = fmt.Sprintf("Drop %d detected file changes before %s starts", m.pendingChangeCount(), m.pendingJobLabel())
	} else if m.queueDepth == 0 {
		cancelLabel = "No pending job"
		cancelSubtitle = "Queued watch work will appear here"
	}
	supersedeLabel := "Supersede pending job"
	supersedeSubtitle := "Replace stale queued work with the latest changes"
	if m.pendingChangeCount() > 0 {
		supersedeLabel = "Supersede pending " + m.pendingJobLabel()
		supersedeSubtitle = fmt.Sprintf("Re-plan %d detected file changes into one %s", m.pendingChangeCount(), m.pendingJobLabel())
	} else if m.queueDepth == 0 {
		supersedeLabel = "No stale job"
		supersedeSubtitle = "Supersede becomes available after queued changes"
	}
	m.sidebar = []navigationEntry{
		{ID: viewOverview, Title: "Overview", Subtitle: "Health, serving, and observability"},
		{ID: viewTree, Title: "Tree", Subtitle: "Prepared tree and file topology"},
		{ID: viewHubs, Title: "Hubs", Subtitle: "Manual and suggested hub views"},
		{ID: viewFindHub, Title: "Find hub", Subtitle: "Ranked hub discovery and triage"},
		{ID: viewRestore, Title: "Restore", Subtitle: "Checkpoint history and recovery"},
		{ID: viewCluster, Title: "Cluster", Subtitle: "Cluster and subsystem summaries"},
		{ID: viewDeps, Title: "Dependencies", Subtitle: "Direct and reverse dependency browsing"},
		{ID: viewStatus, Title: "Status", Subtitle: "Git worktree status table"},
		{ID: viewChanges, Title: "Changes", Subtitle: "Changed-file ranges and stats"},
		{ID: viewSearch, Title: "Search", Subtitle: "Exact and related ranked search results"},
		{ID: viewSymbol, Title: "Symbol", Subtitle: "Exact symbol lookup results"},
		{ID: viewWord, Title: "Word", Subtitle: "Exact word lookup results"},
		{ID: viewOutline, Title: "Outline", Subtitle: "Prepared file outline output"},
		{ID: viewResearch, Title: "Research", Subtitle: "Broad explanation-backed reports"},
		{ID: viewLint, Title: "Lint", Subtitle: "Native lint diagnostics"},
		{ID: viewBlast, Title: "Blast radius", Subtitle: "Symbol usage graph and blast radius"},
		{ID: viewCheckpoint, Title: "Checkpoint", Subtitle: "Checkpoint write results"},
		{ID: "refresh", Title: "Refresh data", Subtitle: "Reload backend snapshots", IsAction: true, Action: "refresh"},
		{ID: "index", Title: indexLabel, Subtitle: indexSubtitle, IsAction: true, Action: "index"},
		{ID: "retry-index", Title: "Retry last index", Subtitle: "Re-run the last index mode through the backend", IsAction: true, Action: "retry-index"},
		{ID: "cancel-pending", Title: cancelLabel, Subtitle: cancelSubtitle, IsAction: true, Action: "cancel-pending"},
		{ID: "supersede-pending", Title: supersedeLabel, Subtitle: supersedeSubtitle, IsAction: true, Action: "supersede-pending"},
		{ID: "watch", Title: watchLabel, Subtitle: watchSubtitle, IsAction: true, Action: "watch"},
		{ID: "hub-create", Title: "New hub", Subtitle: "Create a manual feature hub", IsAction: true, Action: "hub-create"},
		{ID: "palette", Title: "Command palette", Subtitle: "Search backend actions, exact lookups, and exports", IsAction: true, Action: "palette"},
		{ID: "help", Title: "Help", Subtitle: "Show keybindings, filters, exports, and mouse usage", IsAction: true, Action: "help"},
	}
	if m.sidebarIndex >= len(m.sidebar) {
		m.sidebarIndex = max(0, len(m.sidebar)-1)
	}
}

func (m *Model) activeSection() *sectionState {
	section, ok := m.sections[m.activeView]
	if !ok {
		return &sectionState{ID: m.activeView, Title: "Unknown", EmptyMessage: "No section state."}
	}
	return section
}

func (m *Model) setActiveView(viewID string) {
	if _, ok := m.sections[viewID]; !ok {
		return
	}
	m.activeView = viewID
	m.ensureSectionSelection(m.activeSection())
	m.syncDetailViewport()
	m.recordNavigation()
}

func (m *Model) syncDetailViewport() {
	width := m.width - minSidebarWidth - minContentWidth - 10
	if m.useStackedLayout() {
		width = m.width - 4
	}
	if width < minDetailWidth {
		width = minDetailWidth
	}
	height := m.height - 16
	if m.useStackedLayout() {
		height = max(8, (m.height/3)-2)
	}
	m.detail.Width = width
	m.detail.Height = height
	m.detail.SetContent(m.buildDetailContent())
	m.syncLogViewport(false)
}

func (m *Model) ensureSectionSelection(section *sectionState) {
	if section == nil {
		return
	}
	if len(section.Items) == 0 {
		section.Selected = 0
		return
	}
	if section.Selected >= len(section.Items) {
		section.Selected = len(section.Items) - 1
	}
	if section.Selected < 0 {
		section.Selected = 0
	}
	if section.Kind == sectionList {
		section.List.Select(section.Selected)
		return
	}
	section.Table.SetCursor(section.Selected)
}

func (m *Model) setListSectionItems(kind string, items []contentItem) {
	section := m.sections[kind]
	if section == nil {
		return
	}
	section.BaseItems = append([]contentItem{}, items...)
	m.applySectionFilter(section)
}

func (m *Model) setTableSectionRows(kind string, items []contentItem, rows []table.Row) {
	section := m.sections[kind]
	if section == nil {
		return
	}
	section.BaseItems = append([]contentItem{}, items...)
	section.BaseRows = append([]table.Row{}, rows...)
	m.applySectionFilter(section)
}

func (m Model) useStackedLayout() bool {
	return m.width < narrowLayoutCut || m.height < stackedHeightCut
}

func (m *Model) refreshOverviewSection() {
	section := m.sections[viewOverview]
	if section == nil {
		return
	}
	if !m.doctorLoaded {
		section.Items = nil
		section.EmptyMessage = "Loading doctor report..."
		return
	}
	chunkCoverage := m.doctor.HybridVectors.Chunk.VectorCoverage
	identifierCoverage := m.doctor.HybridVectors.Identifier.VectorCoverage
	items := []contentItem{
		{
			ID:      "repo",
			Title:   "Repository",
			Summary: fmt.Sprintf("branch %s | changed %d | untracked %d", m.doctor.RepoStatus.Branch, m.doctor.RepoStatus.UnstagedCount, m.doctor.RepoStatus.UntrackedCount),
			Detail: strings.Join([]string{
				fmt.Sprintf("Root: %s", m.doctor.Root),
				fmt.Sprintf("Branch: %s", m.doctor.RepoStatus.Branch),
				fmt.Sprintf("Changed files: %d", m.doctor.RepoStatus.UnstagedCount),
				fmt.Sprintf("Untracked files: %d", m.doctor.RepoStatus.UntrackedCount),
				fmt.Sprintf("Backend connectivity: %s", map[bool]string{true: "connected", false: "offline"}[m.backendOnline]),
			}, "\n"),
		},
		{
			ID:      "worktree",
			Title:   "Worktree",
			Summary: fmt.Sprintf("ahead %d | behind %d | staged %d | conflicted %d", m.doctor.RepoStatus.Ahead, m.doctor.RepoStatus.Behind, m.doctor.RepoStatus.StagedCount, m.doctor.RepoStatus.ConflictedCount),
			Detail: strings.Join([]string{
				fmt.Sprintf("Ahead: %d", m.doctor.RepoStatus.Ahead),
				fmt.Sprintf("Behind: %d", m.doctor.RepoStatus.Behind),
				fmt.Sprintf("Staged files: %d", m.doctor.RepoStatus.StagedCount),
				fmt.Sprintf("Modified files: %d", m.doctor.RepoStatus.ModifiedCount),
				fmt.Sprintf("Created files: %d", m.doctor.RepoStatus.CreatedCount),
				fmt.Sprintf("Deleted files: %d", m.doctor.RepoStatus.DeletedCount),
				fmt.Sprintf("Renamed files: %d", m.doctor.RepoStatus.RenamedCount),
				fmt.Sprintf("Conflicted files: %d", m.doctor.RepoStatus.ConflictedCount),
			}, "\n"),
		},
		{
			ID:      "serving",
			Title:   "Serving generation",
			Summary: fmt.Sprintf("active %d | pending %s | freshness %s", m.doctor.Serving.ActiveGeneration, formatOptionalInt(m.doctor.Serving.PendingGeneration), m.doctor.Serving.ActiveGenerationFreshness),
			Detail: strings.Join([]string{
				fmt.Sprintf("Active generation: %d", m.doctor.Serving.ActiveGeneration),
				fmt.Sprintf("Pending generation: %s", formatOptionalInt(m.doctor.Serving.PendingGeneration)),
				fmt.Sprintf("Latest generation: %d", m.doctor.Serving.LatestGeneration),
				fmt.Sprintf("Freshness: %s", m.doctor.Serving.ActiveGenerationFreshness),
				fmt.Sprintf("Validated at: %s", formatBlankAsNone(m.doctor.Serving.ActiveGenerationValidatedAt)),
				fmt.Sprintf("Blocked reason: %s", formatBlankAsNone(m.doctor.Serving.ActiveGenerationBlockedReason)),
			}, "\n"),
		},
		{
			ID:      "runtime",
			Title:   "Runtime",
			Summary: fmt.Sprintf("generated %s | ollama %s | restore points %d", formatBlankAsNone(m.doctor.GeneratedAt), formatOllamaSummary(m.doctor.Ollama), m.doctor.RestorePointCount),
			Detail: strings.Join([]string{
				fmt.Sprintf("Generated at: %s", formatBlankAsNone(m.doctor.GeneratedAt)),
				fmt.Sprintf("Ollama: %s", formatOllamaSummary(m.doctor.Ollama)),
				fmt.Sprintf("Tree-sitter parse failures: %d", m.doctor.TreeSitter.TotalParseFailures),
				fmt.Sprintf("Hub suggestions: %d", m.doctor.HubSummary.SuggestionCount),
				fmt.Sprintf("Feature groups: %d", m.doctor.HubSummary.FeatureGroupCount),
				fmt.Sprintf("Restore points: %d", m.doctor.RestorePointCount),
			}, "\n"),
		},
		{
			ID:      "indexing",
			Title:   "Index stages",
			Summary: formatStageMetrics(m.doctor.Observability.Indexing.Stages),
			Detail:  formatStageMetricsDetail(m.doctor.Observability.Indexing.Stages),
		},
		{
			ID:      "vectors",
			Title:   "Vectors and caches",
			Summary: fmt.Sprintf("chunk %d/%d %s | id %d/%d %s", chunkCoverage.LoadedVectorCount, chunkCoverage.RequestedVectorCount, chunkCoverage.State, identifierCoverage.LoadedVectorCount, identifierCoverage.RequestedVectorCount, identifierCoverage.State),
			Detail: strings.Join([]string{
				fmt.Sprintf("Chunk vector coverage: %d/%d %s", chunkCoverage.LoadedVectorCount, chunkCoverage.RequestedVectorCount, chunkCoverage.State),
				fmt.Sprintf("Identifier vector coverage: %d/%d %s", identifierCoverage.LoadedVectorCount, identifierCoverage.RequestedVectorCount, identifierCoverage.State),
				fmt.Sprintf("Embedding namespace hits: %d", m.doctor.Observability.Caches.Embeddings.ProcessNamespaceHits),
				fmt.Sprintf("Embedding vector hits: %d", m.doctor.Observability.Caches.Embeddings.ProcessVectorHits),
				fmt.Sprintf("Parser pool reuse count: %d", m.doctor.Observability.Caches.ParserPoolReuseCount),
				fmt.Sprintf("Hybrid lexical candidates: chunk %d | id %d", m.doctor.Observability.Caches.HybridSearch.Chunk.LexicalCandidateCount, m.doctor.Observability.Caches.HybridSearch.Identifier.LexicalCandidateCount),
			}, "\n"),
		},
		{
			ID:      "integrity",
			Title:   "Integrity",
			Summary: fmt.Sprintf("stale age %s | fallback markers %d", formatOptionalInt(m.doctor.Observability.Integrity.StaleGenerationAgeMs), m.doctor.Observability.Integrity.FallbackMarkerCount),
			Detail: strings.Join([]string{
				fmt.Sprintf("Stale generation age ms: %s", formatOptionalInt(m.doctor.Observability.Integrity.StaleGenerationAgeMs)),
				fmt.Sprintf("Fallback markers: %d", m.doctor.Observability.Integrity.FallbackMarkerCount),
				fmt.Sprintf("Parse failures by language: %s", formatParseFailuresByLanguage(m.doctor.Observability.Integrity.ParseFailuresByLanguage)),
				fmt.Sprintf("File refresh failures: %d", m.doctor.Observability.Integrity.RefreshFailures.FileSearch.RefreshFailures),
				fmt.Sprintf("Write refresh failures: %d", m.doctor.Observability.Integrity.RefreshFailures.WriteFreshness.RefreshFailures),
			}, "\n"),
		},
		{
			ID:    "scheduler",
			Title: "Scheduler",
			Summary: fmt.Sprintf(
				"changes %d | pending %s | batches %d",
				m.doctor.Observability.Scheduler.PendingChangeCount,
				formatBlankAsNone(m.doctor.Observability.Scheduler.PendingJobKind),
				m.doctor.Observability.Scheduler.BatchCount,
			),
			Detail: strings.Join([]string{
				fmt.Sprintf("Watcher enabled: %t", m.doctor.Observability.Scheduler.WatchEnabled),
				fmt.Sprintf("Queue depth: %d", m.doctor.Observability.Scheduler.QueueDepth),
				fmt.Sprintf("Pending changes: %d", m.doctor.Observability.Scheduler.PendingChangeCount),
				fmt.Sprintf("Pending job: %s", formatBlankAsNone(m.doctor.Observability.Scheduler.PendingJobKind)),
				fmt.Sprintf("Pending paths: %s", formatSliceOrNone(m.doctor.Observability.Scheduler.PendingPaths)),
				fmt.Sprintf("Max queue depth: %d", m.doctor.Observability.Scheduler.MaxQueueDepth),
				fmt.Sprintf("Batch count: %d", m.doctor.Observability.Scheduler.BatchCount),
				fmt.Sprintf("Deduped path events: %d", m.doctor.Observability.Scheduler.DedupedPathEvents),
				fmt.Sprintf("Canceled jobs: %d", m.doctor.Observability.Scheduler.CanceledJobs),
				fmt.Sprintf("Superseded jobs: %d", m.doctor.Observability.Scheduler.SupersededJobs),
				formatFullRebuildReasons(m.doctor.Observability.Scheduler.FullRebuildReasons),
			}, "\n"),
		},
	}
	section.EmptyMessage = "No overview data."
	m.setListSectionItems(viewOverview, items)
}

func (m *Model) setTextSection(kind string, text string) {
	section := m.sections[kind]
	if section != nil {
		section.RawText = text
	}
	switch kind {
	case viewTree:
		m.setListSectionItems(kind, buildTreeItems(text))
	case viewHubs:
		m.setListSectionItems(kind, buildHubItems(text))
	case viewCluster:
		m.setListSectionItems(kind, buildClusterItems(text))
	default:
		m.setListSectionItems(kind, buildTextFallbackItems(kind, text))
	}
}

func (m *Model) setRestorePoints(points []backend.RestorePoint) {
	m.restorePoints = points
	section := m.sections[viewRestore]
	if section != nil {
		section.RawText = renderRestorePoints(points)
	}
	m.setListSectionItems(viewRestore, buildRestoreItems(points))
}

func (m *Model) setStatusSummary(summary backend.RepoStatusSummary) {
	items, rows := buildStatusRows(summary)
	section := m.sections[viewStatus]
	if section != nil {
		section.EmptyMessage = "Worktree clean."
		section.RawText = strings.TrimSpace(strings.Join([]string{
			fmt.Sprintf("Branch: %s", summary.Branch),
			fmt.Sprintf("Staged: %d", summary.StagedCount),
			fmt.Sprintf("Unstaged: %d", summary.UnstagedCount),
			fmt.Sprintf("Untracked: %d", summary.UntrackedCount),
		}, "\n"))
	}
	m.setTableSectionRows(viewStatus, items, rows)
}

func (m *Model) setChangesSummary(summary backend.RepoChangesSummary) {
	items, rows := buildChangesRows(summary)
	section := m.sections[viewChanges]
	if section != nil {
		section.EmptyMessage = "No changed files."
		section.RawText = fmt.Sprintf("Changed files: %d\nStaged files: %d\nUnstaged files: %d\nUntracked files: %d", summary.ChangedFiles, summary.StagedFiles, summary.UnstagedFiles, summary.UntrackedFiles)
	}
	m.setTableSectionRows(viewChanges, items, rows)
}

func (m *Model) moveSidebar(delta int) {
	if len(m.sidebar) == 0 {
		return
	}
	next := m.sidebarIndex + delta
	if next < 0 {
		next = len(m.sidebar) - 1
	}
	if next >= len(m.sidebar) {
		next = 0
	}
	m.sidebarIndex = next
	m.recordNavigation()
}

func (m *Model) moveContent(delta int) {
	section := m.activeSection()
	if len(section.Items) == 0 {
		return
	}
	next := section.Selected + delta
	if next < 0 {
		next = len(section.Items) - 1
	}
	if next >= len(section.Items) {
		next = 0
	}
	section.Selected = next
	m.ensureSectionSelection(section)
	m.syncDetailViewport()
	m.recordNavigation()
}

func (m *Model) cycleFocus(delta int) {
	if m.overlay.Mode != overlayNone {
		return
	}
	order := []int{focusSidebar, focusContent, focusDetail, focusJobs, focusLogs}
	if m.wizard.active {
		order = append(order, focusWizard)
	}
	currentIndex := 0
	for index, value := range order {
		if value == m.focus {
			currentIndex = index
			break
		}
	}
	next := currentIndex + delta
	if next < 0 {
		next = len(order) - 1
	}
	if next >= len(order) {
		next = 0
	}
	m.focus = order[next]
	m.recordNavigation()
}

func (m *Model) executeSidebarSelection() tea.Cmd {
	if len(m.sidebar) == 0 {
		return nil
	}
	entry := m.sidebar[m.sidebarIndex]
	if !entry.IsAction {
		m.setActiveView(entry.ID)
		m.focus = focusContent
		m.recordNavigation()
		return nil
	}
	switch entry.Action {
	case "refresh":
		m.startRefreshJob("manual refresh requested", 7)
		m.appendLog("manual refresh requested")
		return refreshAllCmd(m.client, m.root)
	case "index":
		if isActiveJobState(m.job("index").State) {
			m.appendLog("index already running")
			return nil
		}
		m.job("index").State = "queued"
		m.job("index").Phase = "bootstrap"
		m.job("index").Message = "manual full index requested"
		m.job("index").Percent = intPtr(0)
		m.job("index").QueueDepth = m.queueDepth
		m.job("index").LastUpdatedAt = time.Now()
		m.refreshJobTable()
		m.refreshSidebar()
		m.appendLog("manual full index requested")
		return runIndexCmd(m.client, m.root)
	case "retry-index":
		if m.client == nil {
			return nil
		}
		result, err := m.client.ControlJob(context.Background(), m.root, "retry-last")
		if err != nil {
			m.setError(err)
			return nil
		}
		m.queueDepth = result.QueueDepth
		m.appendLog(result.Message)
		m.refreshSidebar()
		return nil
	case "cancel-pending":
		if m.queueDepth == 0 || m.client == nil {
			return nil
		}
		result, err := m.client.ControlJob(context.Background(), m.root, "cancel-pending")
		if err != nil {
			m.setError(err)
			return nil
		}
		m.queueDepth = result.QueueDepth
		m.pendingPaths = append([]string(nil), result.PendingPaths...)
		m.pendingJobKind = result.PendingJobKind
		m.syncLiveSchedulerSnapshot()
		m.appendLog(result.Message)
		m.refreshOverviewSection()
		m.syncDetailViewport()
		m.refreshSidebar()
		return nil
	case "supersede-pending":
		if m.queueDepth == 0 || m.client == nil {
			return nil
		}
		result, err := m.client.ControlJob(context.Background(), m.root, "supersede-pending")
		if err != nil {
			m.setError(err)
			return nil
		}
		m.queueDepth = result.QueueDepth
		m.pendingPaths = append([]string(nil), result.PendingPaths...)
		m.pendingJobKind = result.PendingJobKind
		m.syncLiveSchedulerSnapshot()
		m.appendLog(result.Message)
		m.refreshOverviewSection()
		m.syncDetailViewport()
		m.refreshSidebar()
		return nil
	case "watch":
		return m.toggleWatcher()
	case "hub-create":
		m.wizard = newWizardState()
		m.wizard.active = true
		m.focus = focusWizard
		m.setActiveView(viewHubs)
		m.syncDetailViewport()
		m.recordNavigation()
		return nil
	case "palette":
		m.openPalette()
		return nil
	case "help":
		m.openHelpOverlay()
		return nil
	default:
		return nil
	}
}

func (m *Model) toggleWatcher() tea.Cmd {
	state, err := m.client.SetWatchEnabled(context.Background(), m.root, !m.watchEnabled)
	if err != nil {
		m.setError(err)
		return nil
	}
	m.watchEnabled = state.Enabled
	m.refreshSidebar()
	if state.Enabled {
		m.appendLog("watcher enabled")
	} else {
		m.appendLog("watcher disabled")
	}
	return nil
}

func (m *Model) exportActiveContent() tea.Cmd {
	name := "detail"
	content := m.buildDetailContent()
	switch {
	case m.focus == focusLogs:
		name = "logs"
		content = strings.Join(m.logs, "\n")
	case m.focus == focusContent || m.focus == focusDetail:
		name = m.activeView
		if section := m.activeSection(); section != nil && strings.TrimSpace(section.RawText) != "" {
			content = section.RawText
		}
	}
	return exportContentCmd(m.root, name, content)
}

func (m *Model) executePromptCommand(command paletteCommand, primary string, secondary string) tea.Cmd {
	primary = strings.TrimSpace(primary)
	secondary = strings.TrimSpace(secondary)
	if command.RequiresInput && primary == "" && command.Action != "lint" {
		m.setError(fmt.Errorf("%s requires input", command.Title))
		return nil
	}
	switch command.Action {
	case "find-hub":
		m.startOperatorJob("query", "find-hub", "find-hub requested", primary)
		return runTextCommandCmd("query", viewFindHub, "Find hub", fmt.Sprintf("Ranked hub matches for %q", primary), false, func() (backend.TextPayload, error) {
			return m.client.FindHub(context.Background(), m.root, primary, "both")
		})
	case "exact-lookup":
		m.startOperatorJob("query", "exact", "exact lookup requested", primary)
		return runSearchCommandCmd(m.client, m.root, primary, "exact", "mixed", viewSearch, "Exact lookup", fmt.Sprintf("Exact mixed lookup for %q", primary))
	case "search-related":
		m.startOperatorJob("query", "related", "related search requested", primary)
		return runSearchCommandCmd(m.client, m.root, primary, "related", "mixed", viewSearch, "Related search", fmt.Sprintf("Related ranked search for %q", primary))
	case "research":
		m.startOperatorJob("query", "research", "research requested", primary)
		return runTextCommandCmd("query", viewResearch, "Research", fmt.Sprintf("Broad research report for %q", primary), false, func() (backend.TextPayload, error) {
			return m.client.Research(context.Background(), m.root, primary)
		})
	case "go-file":
		m.startOperatorJob("query", "go-file", "file lookup requested", primary)
		return runSearchCommandCmd(m.client, m.root, primary, "exact", "file", viewSearch, "Go to file", fmt.Sprintf("Exact file lookup for %q", primary))
	case "go-symbol":
		m.startOperatorJob("query", "go-symbol", "symbol lookup requested", primary)
		return runSearchCommandCmd(m.client, m.root, primary, "exact", "symbol", viewSearch, "Go to symbol", fmt.Sprintf("Exact symbol lookup for %q", primary))
	case "symbol-lookup":
		m.startOperatorJob("query", "symbol", "symbol lookup requested", primary)
		return runTextCommandCmd("query", viewSymbol, "Symbol", fmt.Sprintf("Exact symbol hits for %q", primary), false, func() (backend.TextPayload, error) {
			return m.client.Symbol(context.Background(), m.root, primary, 8)
		})
	case "word-lookup":
		m.startOperatorJob("query", "word", "word lookup requested", primary)
		return runTextCommandCmd("query", viewWord, "Word lookup", fmt.Sprintf("Word hits for %q", primary), false, func() (backend.TextPayload, error) {
			return m.client.Word(context.Background(), m.root, primary, 8)
		})
	case "outline-file":
		m.startOperatorJob("query", "outline", "outline requested", primary)
		return runTextCommandCmd("query", viewOutline, "Outline", fmt.Sprintf("Prepared outline for %s", primary), false, func() (backend.TextPayload, error) {
			return m.client.Outline(context.Background(), m.root, primary)
		})
	case "deps-file":
		m.startOperatorJob("query", "deps", "dependency info requested", primary)
		return runTextCommandCmd("query", viewDeps, "Dependencies", fmt.Sprintf("Dependency graph for %s", primary), false, func() (backend.TextPayload, error) {
			return m.client.Deps(context.Background(), m.root, primary)
		})
	case "lint":
		m.startOperatorJob("lint", "lint", "lint requested", formatBlankAsNone(primary))
		return runTextCommandCmd("lint", viewLint, "Lint", fmt.Sprintf("Native lint report for %s", formatBlankAsNone(primary)), false, func() (backend.TextPayload, error) {
			return m.client.Lint(context.Background(), m.root, primary)
		})
	case "blast-radius":
		m.startOperatorJob("query", "blast-radius", "blast radius requested", primary)
		return runTextCommandCmd("query", viewBlast, "Blast radius", fmt.Sprintf("Blast radius for %s", primary), false, func() (backend.TextPayload, error) {
			return m.client.BlastRadius(context.Background(), m.root, primary, secondary)
		})
	case "checkpoint-detail":
		detailContent := strings.TrimSpace(m.buildDetailContent())
		if detailContent == "" {
			m.setError(errors.New("no detail content is available to checkpoint"))
			return nil
		}
		m.startOperatorJob("restore", "checkpoint", "checkpoint requested", primary)
		return runTextCommandCmd("restore", viewCheckpoint, "Checkpoint", fmt.Sprintf("Checkpointed detail into %s", primary), true, func() (backend.TextPayload, error) {
			return m.client.Checkpoint(context.Background(), m.root, primary, detailContent)
		})
	case "restore-point":
		m.startOperatorJob("restore", "restore", "restore requested", primary)
		return runTextCommandCmd("restore", "", "Restore", fmt.Sprintf("Restored point %s", primary), true, func() (backend.TextPayload, error) {
			return m.client.Restore(context.Background(), m.root, primary)
		})
	default:
		return nil
	}
}

func (m *Model) submitPaletteSelection() tea.Cmd {
	command, ok := m.activePaletteCommand()
	if !ok {
		m.setError(errors.New("no palette command matches the current filter"))
		return nil
	}
	m.closeOverlay()
	if command.RequiresInput {
		m.openPromptOverlay(command)
		return nil
	}
	switch command.Action {
	case "open-status":
		m.setActiveView(viewStatus)
		m.focus = focusContent
		m.recordNavigation()
		return nil
	case "open-changes":
		m.setActiveView(viewChanges)
		m.focus = focusContent
		m.recordNavigation()
		return nil
	default:
		return nil
	}
}

func (m *Model) updateOverlay(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch m.overlay.Mode {
	case overlayHelp:
		switch key.String() {
		case "esc", "?", "enter":
			m.closeOverlay()
		}
		return m, nil
	case overlayPalette:
		switch key.String() {
		case "esc":
			m.closeOverlay()
			return m, nil
		case "up", "k":
			m.overlay.Selected--
			if m.overlay.Selected < 0 {
				m.overlay.Selected = max(0, len(m.filteredPaletteCommands())-1)
			}
			return m, nil
		case "down", "j":
			m.overlay.Selected++
			if commands := m.filteredPaletteCommands(); len(commands) > 0 && m.overlay.Selected >= len(commands) {
				m.overlay.Selected = 0
			}
			return m, nil
		case "enter":
			return m, m.submitPaletteSelection()
		default:
			var cmd tea.Cmd
			m.overlay.Input, cmd = m.overlay.Input.Update(key)
			m.overlay.Selected = 0
			return m, cmd
		}
	case overlayFilter:
		switch key.String() {
		case "esc":
			m.closeOverlay()
			return m, nil
		case "enter":
			section := m.sections[m.overlay.TargetSectionID]
			if section == nil {
				m.closeOverlay()
				return m, nil
			}
			section.FilterQuery = strings.TrimSpace(m.overlay.Input.Value())
			m.applySectionFilter(section)
			m.closeOverlay()
			m.syncDetailViewport()
			m.recordNavigation()
			return m, nil
		default:
			var cmd tea.Cmd
			m.overlay.Input, cmd = m.overlay.Input.Update(key)
			return m, cmd
		}
	case overlayPrompt:
		switch key.String() {
		case "esc":
			m.closeOverlay()
			return m, nil
		case "shift+tab":
			if m.overlay.SecondaryEnabled && m.overlay.Secondary.Focused() {
				m.overlay.Secondary.Blur()
				m.overlay.Input.Focus()
			}
			return m, nil
		case "tab":
			if m.overlay.SecondaryEnabled && m.overlay.Input.Focused() {
				m.overlay.Input.Blur()
				m.overlay.Secondary.Focus()
			}
			return m, nil
		case "enter":
			if m.overlay.SecondaryEnabled && m.overlay.Input.Focused() {
				m.overlay.Input.Blur()
				m.overlay.Secondary.Focus()
				return m, nil
			}
			command := m.overlay.Command
			primary := m.overlay.Input.Value()
			secondary := m.overlay.Secondary.Value()
			m.closeOverlay()
			return m, m.executePromptCommand(command, primary, secondary)
		default:
			if m.overlay.SecondaryEnabled && m.overlay.Secondary.Focused() {
				var cmd tea.Cmd
				m.overlay.Secondary, cmd = m.overlay.Secondary.Update(key)
				return m, cmd
			}
			var cmd tea.Cmd
			m.overlay.Input, cmd = m.overlay.Input.Update(key)
			return m, cmd
		}
	default:
		return m, nil
	}
}

func (m *Model) handleMouse(message tea.MouseMsg) tea.Cmd {
	switch message.Action {
	case tea.MouseActionRelease:
		return nil
	case tea.MouseActionPress:
		if message.Button == tea.MouseButtonWheelUp {
			if m.focus == focusLogs {
				m.logViewport.LineUp(3)
				return nil
			}
			if m.focus == focusDetail {
				m.detail.LineUp(3)
				return nil
			}
			if m.focus == focusJobs {
				m.jobTable.SetCursor(max(0, m.jobTable.Cursor()-1))
				return nil
			}
			if m.focus == focusContent {
				m.moveContent(-1)
				return nil
			}
		}
		if message.Button == tea.MouseButtonWheelDown {
			if m.focus == focusLogs {
				m.logViewport.LineDown(3)
				return nil
			}
			if m.focus == focusDetail {
				m.detail.LineDown(3)
				return nil
			}
			if m.focus == focusJobs {
				m.jobTable.SetCursor(min(max(0, len(m.jobOrder)-1), m.jobTable.Cursor()+1))
				return nil
			}
			if m.focus == focusContent {
				m.moveContent(1)
				return nil
			}
		}
		if message.Button != tea.MouseButtonLeft {
			return nil
		}
		headerHeight := 8
		y := message.Y
		x := message.X
		if y < headerHeight {
			return nil
		}
		relativeY := y - headerHeight
		if m.useStackedLayout() {
			sectionHeights := []struct {
				focus  int
				height int
			}{
				{focusSidebar, max(8, 0)},
				{focusContent, max(12, m.height/3)},
				{focusDetail, max(10, m.height/3)},
				{focusJobs, max(minJobsHeight, m.height/5)},
				{focusLogs, max(minJobsHeight, m.height/5)},
			}
			accumulated := 0
			for _, pane := range sectionHeights {
				accumulated += pane.height + 1
				if relativeY <= accumulated {
					m.focus = pane.focus
					m.recordNavigation()
					return nil
				}
			}
			return nil
		}
		jobsHeight := max(minJobsHeight, m.height/4)
		mainHeight := max(16, m.height-jobsHeight-8)
		sidebarWidth := max(minSidebarWidth, m.width/5)
		contentWidth := max(minContentWidth, m.width/3)
		if relativeY > mainHeight {
			if x <= max(minJobsWidth, m.width/2) {
				m.focus = focusJobs
			} else {
				m.focus = focusLogs
			}
			m.recordNavigation()
			return nil
		}
		if x <= sidebarWidth {
			m.focus = focusSidebar
			entryIndex := max(0, (relativeY-2)/2)
			if entryIndex < len(m.sidebar) {
				m.sidebarIndex = entryIndex
			}
		} else if x <= sidebarWidth+contentWidth {
			m.focus = focusContent
		} else {
			m.focus = focusDetail
		}
		m.recordNavigation()
	}
	return nil
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	switch message := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = message.Width
		m.height = message.Height
		m.syncDetailViewport()
		return m, nil
	case frameMsg:
		m.magicianFrame = (m.magicianFrame + 1) % len(magicianFrames)
		return m, animateCmd()
	case doctorLoadedMsg:
		if message.err != nil {
			m.backendOnline = false
			m.setError(message.err)
			m.finishRefreshSubtask("doctor", message.err)
			return m, nil
		}
		m.backendOnline = true
		m.doctor = message.report
		m.doctorLoaded = true
		m.watchEnabled = message.report.Observability.Scheduler.WatchEnabled
		m.queueDepth = message.report.Observability.Scheduler.QueueDepth
		m.pendingPaths = append([]string(nil), message.report.Observability.Scheduler.PendingPaths...)
		m.pendingJobKind = message.report.Observability.Scheduler.PendingJobKind
		m.job("index").QueueDepth = m.queueDepth
		m.job("refresh").QueueDepth = m.queueDepth
		m.syncLiveSchedulerSnapshot()
		m.refreshOverviewSection()
		m.refreshSidebar()
		m.syncDetailViewport()
		m.appendLog("doctor report refreshed")
		m.finishRefreshSubtask("doctor", nil)
		return m, nil
	case textLoadedMsg:
		if message.err != nil {
			m.setError(message.err)
			m.finishRefreshSubtask(message.kind, message.err)
			return m, nil
		}
		m.setTextSection(message.kind, message.text)
		m.syncDetailViewport()
		m.finishRefreshSubtask(message.kind, nil)
		return m, nil
	case restoreLoadedMsg:
		if message.err != nil {
			m.setError(message.err)
			m.finishRefreshSubtask("restore-points", message.err)
			return m, nil
		}
		m.setRestorePoints(message.points)
		m.syncDetailViewport()
		m.finishRefreshSubtask("restore-points", nil)
		return m, nil
	case statusLoadedMsg:
		if message.err != nil {
			m.setError(message.err)
			m.finishRefreshSubtask("status", message.err)
			return m, nil
		}
		m.setStatusSummary(message.summary)
		m.syncDetailViewport()
		m.finishRefreshSubtask("status", nil)
		return m, nil
	case changesLoadedMsg:
		if message.err != nil {
			m.setError(message.err)
			m.finishRefreshSubtask("changes", message.err)
			return m, nil
		}
		m.setChangesSummary(message.summary)
		m.syncDetailViewport()
		m.finishRefreshSubtask("changes", nil)
		return m, nil
	case indexFinishedMsg:
		m.refreshSidebar()
		if message.err != nil {
			m.setError(message.err)
		} else {
			firstLine := strings.Split(strings.TrimSpace(message.output), "\n")[0]
			if firstLine == "" {
				firstLine = "index completed"
			}
			m.appendLog(firstLine)
		}
		return m, refreshAllCmd(m.client, m.root)
	case hubCreatedMsg:
		m.wizard.busy = false
		if message.err != nil {
			m.wizard.message = message.err.Error()
			m.setError(message.err)
			return m, nil
		}
		m.wizard.message = "Created " + message.path
		m.appendLog("created hub " + message.path)
		m.wizard.active = false
		m.focus = focusSidebar
		m.setActiveView(viewHubs)
		return m, tea.Batch(loadHubsCmd(m.client, m.root), loadDoctorCmd(m.client, m.root))
	case commandLoadedMsg:
		if message.err != nil {
			m.finishOperatorJob(message.jobID, "failed", message.err.Error())
			m.setError(message.err)
			return m, nil
		}
		m.finishOperatorJob(message.jobID, "completed", message.logMessage)
		if strings.TrimSpace(message.viewID) != "" {
			m.showCommandSection(message.viewID, message.title, message.subtitle, message.items, message.rawText)
		}
		m.appendLog(message.logMessage)
		m.syncDetailViewport()
		if message.refreshData {
			return m, tea.Batch(refreshAllCmd(m.client, m.root), loadRestorePointsCmd(m.client, m.root))
		}
		return m, nil
	case exportFinishedMsg:
		if message.err != nil {
			m.setError(message.err)
			return m, nil
		}
		m.appendLog("exported view to " + message.path)
		return m, nil
	case backendEventMsg:
		m.backendOnline = message.event.Kind != "disconnect"
		switch message.event.Kind {
		case "disconnect":
			m.setError(errors.New(message.event.Message))
		case "log":
			if message.event.Message != "" {
				m.appendLog(message.event.Message)
			}
		case "watch-state":
			m.watchEnabled = message.event.Enabled
			m.queueDepth = message.event.QueueDepth
			m.pendingPaths = append([]string(nil), message.event.PendingPaths...)
			m.pendingJobKind = message.event.PendingJobKind
			m.job("index").QueueDepth = m.queueDepth
			m.job("refresh").QueueDepth = m.queueDepth
			m.syncLiveSchedulerSnapshot()
			m.refreshJobTable()
			m.refreshSidebar()
		case "watch-batch":
			m.queueDepth = message.event.QueueDepth
			m.pendingPaths = append([]string(nil), message.event.PendingPaths...)
			m.pendingJobKind = message.event.PendingJobKind
			m.job("index").QueueDepth = m.queueDepth
			m.job("refresh").QueueDepth = m.queueDepth
			if m.doctorLoaded {
				m.doctor.Observability.Scheduler.BatchCount++
			}
			m.syncLiveSchedulerSnapshot()
			m.refreshJobTable()
			if len(message.event.ChangedPaths) > 0 {
				m.appendLog("detected changes: " + strings.Join(message.event.ChangedPaths, ", "))
			}
		case "job":
			jobID := message.event.Job
			if strings.TrimSpace(jobID) == "" {
				jobID = "index"
			}
			activeJob := m.job(jobID)
			activeJob.State = message.event.State
			activeJob.Phase = message.event.Phase
			activeJob.Message = message.event.Message
			activeJob.RebuildReason = message.event.RebuildReason
			activeJob.QueueDepth = message.event.QueueDepth
			activeJob.ElapsedMs = message.event.ElapsedMs
			activeJob.Source = message.event.Source
			activeJob.Mode = message.event.Mode
			activeJob.Pending = message.event.Pending
			activeJob.CurrentFile = message.event.CurrentFile
			if message.event.PercentComplete > 0 || message.event.TotalItems > 0 {
				activeJob.Percent = intPtr(message.event.PercentComplete)
			} else if message.event.State == "completed" {
				activeJob.Percent = intPtr(100)
			} else {
				activeJob.Percent = nil
			}
			activeJob.LastUpdatedAt = time.Now()
			if message.event.State == "completed" {
				activeJob.LastSuccessful = time.Now().Format(time.RFC3339)
			}
			m.queueDepth = message.event.QueueDepth
			m.pendingPaths = append([]string(nil), message.event.PendingPaths...)
			m.pendingJobKind = message.event.PendingJobKind
			if m.doctorLoaded {
				switch message.event.State {
				case "canceled":
					m.doctor.Observability.Scheduler.CanceledJobs++
				}
			}
			m.syncLiveSchedulerSnapshot()
			m.refreshJobTable()
			m.refreshSidebar()
		}
		m.refreshOverviewSection()
		m.syncDetailViewport()
		return m, waitForBackendEventCmd(m.client.Events())
	case tea.MouseMsg:
		return m, m.handleMouse(message)
	case tea.KeyMsg:
		if m.overlay.Mode != overlayNone {
			return m.updateOverlay(message)
		}
		if m.wizard.active && m.focus == focusWizard {
			return m.updateWizard(message)
		}
		switch message.String() {
		case "ctrl+c", "q":
			return m, tea.Quit
		case "ctrl+p", ":":
			m.openPalette()
			return m, nil
		case "?":
			m.openHelpOverlay()
			return m, nil
		case "/":
			m.openFilterOverlay()
			return m, nil
		case "e":
			return m, m.exportActiveContent()
		case "b":
			m.navigateHistory(-1)
			return m, nil
		case "f":
			m.navigateHistory(1)
			return m, nil
		case "shift+tab":
			m.cycleFocus(-1)
			return m, nil
		case "tab":
			m.cycleFocus(1)
			return m, nil
		case "left":
			if m.focus == focusContent {
				m.focus = focusSidebar
			} else if m.focus == focusDetail {
				m.focus = focusContent
			} else if m.focus == focusLogs {
				m.focus = focusJobs
			}
			m.recordNavigation()
			return m, nil
		case "right":
			if m.focus == focusSidebar {
				m.focus = focusContent
			} else if m.focus == focusContent {
				m.focus = focusDetail
			} else if m.focus == focusJobs {
				m.focus = focusLogs
			}
			m.recordNavigation()
			return m, nil
		case "up", "k":
			if m.focus == focusSidebar {
				m.moveSidebar(-1)
				return m, nil
			}
			if m.focus == focusContent {
				m.moveContent(-1)
				return m, nil
			}
			if m.focus == focusJobs {
				m.jobTable.SetCursor(max(0, m.jobTable.Cursor()-1))
				m.recordNavigation()
				return m, nil
			}
		case "down", "j":
			if m.focus == focusSidebar {
				m.moveSidebar(1)
				return m, nil
			}
			if m.focus == focusContent {
				m.moveContent(1)
				return m, nil
			}
			if m.focus == focusJobs {
				maxCursor := max(0, len(m.jobOrder)-1)
				m.jobTable.SetCursor(min(maxCursor, m.jobTable.Cursor()+1))
				m.recordNavigation()
				return m, nil
			}
		case "enter":
			if m.focus == focusSidebar {
				return m, m.executeSidebarSelection()
			}
			if m.focus == focusContent {
				m.focus = focusDetail
				m.recordNavigation()
				return m, nil
			}
		case "x":
			m.sidebarIndex = m.findSidebarAction("cancel-pending")
			return m, m.executeSidebarSelection()
		case "s":
			m.sidebarIndex = m.findSidebarAction("supersede-pending")
			return m, m.executeSidebarSelection()
		case "t":
			m.sidebarIndex = m.findSidebarAction("retry-index")
			return m, m.executeSidebarSelection()
		case "i":
			m.sidebarIndex = m.findSidebarAction("index")
			return m, m.executeSidebarSelection()
		case "r":
			m.sidebarIndex = m.findSidebarAction("refresh")
			return m, m.executeSidebarSelection()
		case "w":
			m.sidebarIndex = m.findSidebarAction("watch")
			return m, m.executeSidebarSelection()
		case "n":
			m.sidebarIndex = m.findSidebarAction("hub-create")
			return m, m.executeSidebarSelection()
		case "u":
			if m.focus == focusContent && m.activeView == viewRestore {
				section := m.activeSection()
				if len(section.Items) == 0 {
					return m, nil
				}
				pointID := strings.TrimSpace(section.Items[section.Selected].ID)
				if pointID == "" {
					return m, nil
				}
				m.startOperatorJob("restore", "restore", "restore requested", pointID)
				return m, runTextCommandCmd("restore", "", "Restore", fmt.Sprintf("Restored point %s", pointID), true, func() (backend.TextPayload, error) {
					return m.client.Restore(context.Background(), m.root, pointID)
				})
			}
		case "1":
			m.setActiveView(viewOverview)
			m.focus = focusContent
			return m, nil
		case "2":
			m.setActiveView(viewTree)
			m.focus = focusContent
			return m, nil
		case "3":
			m.setActiveView(viewHubs)
			m.focus = focusContent
			return m, nil
		case "4":
			m.setActiveView(viewRestore)
			m.focus = focusContent
			return m, nil
		case "5":
			m.setActiveView(viewCluster)
			m.focus = focusContent
			return m, nil
		case "6":
			m.setActiveView(viewStatus)
			m.focus = focusContent
			return m, nil
		case "7":
			m.setActiveView(viewChanges)
			m.focus = focusContent
			return m, nil
		case "8":
			m.setActiveView(viewSearch)
			m.focus = focusContent
			return m, nil
		case "9":
			m.setActiveView(viewSymbol)
			m.focus = focusContent
			return m, nil
		}
		if m.focus == focusDetail {
			m.detail, cmd = m.detail.Update(message)
			return m, cmd
		}
		if m.focus == focusLogs {
			m.logViewport, cmd = m.logViewport.Update(message)
			return m, cmd
		}
	}
	return m, nil
}

func (m *Model) updateWizard(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.String() {
	case "esc":
		m.wizard = newWizardState()
		m.wizard.active = false
		m.focus = focusSidebar
		m.syncDetailViewport()
		return m, nil
	case "shift+tab":
		m.wizard.focus = (m.wizard.focus + len(m.wizard.inputs) - 1) % len(m.wizard.inputs)
	case "tab":
		m.wizard.focus = (m.wizard.focus + 1) % len(m.wizard.inputs)
	case "enter":
		if m.wizard.focus == len(m.wizard.inputs)-1 {
			m.wizard.busy = true
			m.wizard.message = "Creating hub..."
			m.syncDetailViewport()
			return m, createHubCmd(m.root, m.wizard)
		}
		m.wizard.focus++
	default:
	}
	for index := range m.wizard.inputs {
		if index == m.wizard.focus {
			m.wizard.inputs[index].Focus()
		} else {
			m.wizard.inputs[index].Blur()
		}
	}
	for index := range m.wizard.inputs {
		var cmd tea.Cmd
		m.wizard.inputs[index], cmd = m.wizard.inputs[index].Update(key)
		if cmd != nil {
			m.syncDetailViewport()
			return m, cmd
		}
	}
	m.syncDetailViewport()
	return m, nil
}

func (m *Model) findSidebarAction(action string) int {
	for index, entry := range m.sidebar {
		if entry.Action == action {
			return index
		}
	}
	return 0
}

func (m Model) buildDetailContent() string {
	if m.wizard.active {
		return m.renderWizardDetail()
	}
	section := m.activeSection()
	if len(section.Items) == 0 {
		return section.EmptyMessage
	}
	item := section.Items[section.Selected]
	lines := []string{
		item.Title,
		"",
	}
	if item.Badge != "" {
		lines = append(lines, "Badge: "+item.Badge, "")
	}
	if item.Summary != "" {
		lines = append(lines, item.Summary, "")
	}
	lines = append(lines, item.Detail)
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func (m Model) renderWizardDetail() string {
	lines := []string{
		"Create Human Hub",
		"",
		"Fill the fields below, then press Enter on the last field to create the hub.",
		"",
	}
	for _, input := range m.wizard.inputs {
		lines = append(lines, input.View())
	}
	if m.wizard.message != "" {
		lines = append(lines, "", m.wizard.message)
	}
	return strings.Join(lines, "\n")
}

func (m Model) renderHeader() string {
	magician := lipgloss.NewStyle().Foreground(lipgloss.Color("212")).Render(magicianFrames[m.magicianFrame])
	subtitle := "Operator console with navigation history, command palette, and export layers"
	if m.useStackedLayout() {
		subtitle = "Stacked operator console for narrow terminals"
	}
	return lipgloss.JoinHorizontal(
		lipgloss.Top,
		magician,
		lipgloss.NewStyle().MarginLeft(2).Render(
			titleStyle.Render("context++ Human CLI")+"\n"+
				subtitleStyle.Render(subtitle),
		),
	)
}

func (m Model) renderSidebarPanel(width int) string {
	lines := []string{
		renderPaneTitle("Navigation", m.focus == focusSidebar),
		"",
	}
	for index, entry := range m.sidebar {
		prefix := "  "
		if entry.IsAction {
			prefix = "> "
		}
		label := prefix + entry.Title
		style := sidebarIdle
		if index == m.sidebarIndex {
			if m.focus == focusSidebar {
				style = sidebarSelected
			} else {
				style = sidebarActive
			}
		} else if !entry.IsAction && entry.ID == m.activeView {
			style = sidebarActive
		}
		lines = append(lines, style.Render(label))
		if entry.Subtitle != "" {
			lines = append(lines, subtitleStyle.Render("  "+entry.Subtitle))
		}
	}
	return cardStyle.Width(width).Render(strings.Join(lines, "\n"))
}

func (m *Model) renderContentPanel(width int, height int) string {
	section := m.activeSection()
	m.ensureSectionSelection(section)
	bodyHeight := max(4, height-6)
	lines := []string{
		renderPaneTitle(section.Title, m.focus == focusContent),
		subtitleStyle.Render(section.Subtitle),
		subtitleStyle.Render(fmt.Sprintf("Selected %d/%d | filter=%s", selectedCountLabel(section.Selected, len(section.Items)), max(1, len(section.Items)), formatBlankAsNone(section.FilterQuery))),
		"",
	}
	if len(section.Items) == 0 {
		lines = append(lines, section.EmptyMessage)
		return cardStyle.Width(width).Height(height).Render(strings.Join(lines, "\n"))
	}
	if section.Kind == sectionList {
		windowSize := max(6, bodyHeight)
		start, end := visibleRange(len(section.Items), section.Selected, windowSize)
		if start > 0 {
			lines = append(lines, subtitleStyle.Render(fmt.Sprintf("  ... %d earlier items hidden", start)))
		}
		lines = append(lines, m.renderSectionList(section, width-4, bodyHeight))
		if end < len(section.Items) {
			lines = append(lines, subtitleStyle.Render(fmt.Sprintf("  ... %d more items hidden", len(section.Items)-end)))
		}
		return cardStyle.Width(width).Height(height).Render(strings.Join(lines, "\n"))
	}
	lines = append(lines, m.renderSectionTable(section, width-4, bodyHeight))
	return cardStyle.Width(width).Height(height).Render(strings.Join(lines, "\n"))
}

func (m *Model) renderSectionList(section *sectionState, width int, height int) string {
	section.List.SetWidth(max(12, width))
	section.List.SetHeight(max(4, height))
	if m.focus == focusContent {
		section.List.Styles.Title = lipgloss.NewStyle()
	}
	return section.List.View()
}

func (m *Model) renderSectionTable(section *sectionState, width int, height int) string {
	section.Table.SetWidth(max(12, width))
	section.Table.SetHeight(max(4, height))
	if m.focus == focusContent {
		section.Table.Focus()
	} else {
		section.Table.Blur()
	}
	return section.Table.View()
}

func (m Model) renderDetailPanel(width int, height int) string {
	m.detail.Width = max(minDetailWidth, width-4)
	m.detail.Height = max(8, height-4)
	m.detail.SetContent(m.buildDetailContent())
	body := []string{
		renderPaneTitle("Detail", m.focus == focusDetail || m.focus == focusWizard),
		subtitleStyle.Render("Preview, export target, and command context"),
		"",
		m.detail.View(),
	}
	return cardStyle.Width(width).Height(height).Render(strings.Join(body, "\n"))
}

func (m Model) renderJobsPanel(width int, height int) string {
	selectedJob := m.selectedJob()
	tableHeight := max(4, height-9)
	m.jobTable.SetWidth(max(12, width-4))
	m.jobTable.SetHeight(tableHeight)
	if m.focus == focusJobs {
		m.jobTable.Focus()
	} else {
		m.jobTable.Blur()
	}
	lines := []string{
		renderPaneTitle("Jobs", m.focus == focusJobs),
		subtitleStyle.Render("Structured backend and operator task state"),
		"",
		m.jobTable.View(),
	}
	if selectedJob != nil {
		lines = append(lines, "")
		lines = append(lines, subtitleStyle.Render(fmt.Sprintf(
			"%s | phase=%s | percent=%s | queue=%d | file=%s",
			selectedJob.Title,
			formatBlankAsNone(selectedJob.Phase),
			formatJobPercent(selectedJob.Percent),
			selectedJob.QueueDepth,
			truncate(formatBlankAsNone(selectedJob.CurrentFile), max(18, width/3)),
		)))
		lines = append(lines, truncate(formatBlankAsNone(selectedJob.Message), max(20, width-6)))
		if strings.TrimSpace(selectedJob.RebuildReason) != "" {
			lines = append(lines, subtitleStyle.Render("reason: "+truncate(selectedJob.RebuildReason, max(20, width-8))))
		}
		lines = append(lines, subtitleStyle.Render("controls: i run | t retry | x cancel pending | s supersede pending"))
	}
	if m.lastError != "" {
		lines = append(lines, "", errorStyle.Render("Last error: "+m.lastError))
	}
	return cardStyle.Width(width).Height(height).Render(strings.Join(lines, "\n"))
}

func (m Model) renderLogsPanel(width int, height int) string {
	viewportCopy := m.logViewport
	viewportCopy.Width = max(12, width-4)
	viewportCopy.Height = max(4, height-4)
	body := []string{
		renderPaneTitle("Logs", m.focus == focusLogs),
		subtitleStyle.Render(fmt.Sprintf("Scrollable backend log stream (%d lines)", len(m.logs))),
		"",
		viewportCopy.View(),
	}
	return cardStyle.Width(width).Height(height).Render(strings.Join(body, "\n"))
}

func (m Model) renderStatusLine() string {
	watcherState := "off"
	if m.watchEnabled {
		watcherState = "on"
	}
	statusJob := m.activeStatusJob()
	stage := strings.TrimSpace(statusJob.Phase)
	if stage == "" {
		stage = map[bool]string{true: "running", false: "idle"}[isActiveJobState(statusJob.State)]
	}
	backendState := "connected"
	if !m.backendOnline {
		backendState = "offline"
	}
	generation := "unknown"
	if m.doctorLoaded {
		generation = fmt.Sprintf("%d", m.doctor.Serving.ActiveGeneration)
	}
	historyState := "0/0"
	if len(m.history) > 0 {
		historyState = fmt.Sprintf("%d/%d", m.historyIndex+1, len(m.history))
	}
	status := strings.Join([]string{
		"watcher: " + watcherState,
		"stage: " + stage,
		"pending: " + fmt.Sprintf("%d", m.pendingChangeCount()),
		"backend: " + backendState,
		"repo: " + truncate(m.root, max(24, m.width/3)),
		"generation: " + generation,
		"history: " + historyState,
	}, " | ")
	return statusLineStyle.Width(max(0, m.width-2)).Render(status)
}

func (m Model) renderOverlayCard(width int) string {
	lines := []string{
		renderPaneTitle(m.overlay.Title, true),
		subtitleStyle.Render(m.overlay.Subtitle),
		"",
	}
	switch m.overlay.Mode {
	case overlayHelp:
		lines = append(lines,
			"Navigation",
			"  Tab / Shift+Tab move focus across panes",
			"  Up/Down move the selected row",
			"  Enter opens detail from the content pane",
			"  b / f walk back and forward through navigation history",
			"",
			"Commands",
			"  : or Ctrl+P opens the command palette",
			"  1-9 jump directly to overview, tree, hubs, restore, cluster, status, changes, search, and symbol",
			"  i/t/x/s/r/w keep the existing index, retry, cancel, supersede, refresh, and watcher actions",
			"  u restores the selected restore point from the Restore section",
			"",
			"Filters and export",
			"  / opens the current-section filter box",
			"  e exports logs, results, or the selected detail view into .contextplus/exports/",
			"",
			"Mouse",
			"  left-click focuses a pane and sidebar row",
			"  wheel scrolls logs, detail, jobs, and content lists",
		)
	case overlayPalette:
		lines = append(lines, m.overlay.Input.View(), "")
		commands := m.filteredPaletteCommands()
		if len(commands) == 0 {
			lines = append(lines, "No commands match the current filter.")
			break
		}
		windowSize := max(6, min(14, len(commands)))
		start, end := visibleRange(len(commands), m.overlay.Selected, windowSize)
		for index := start; index < end; index++ {
			command := commands[index]
			prefix := "  "
			style := contentIdle
			if index == m.overlay.Selected {
				prefix = "> "
				style = contentSelected
			}
			lines = append(lines, style.Render(prefix+command.Title))
			lines = append(lines, subtitleStyle.Render("  "+command.Subtitle))
		}
	case overlayFilter:
		lines = append(lines, m.overlay.Input.View())
	case overlayPrompt:
		lines = append(lines, m.overlay.Input.View())
		if m.overlay.SecondaryEnabled {
			lines = append(lines, m.overlay.Secondary.View())
		}
	}
	if strings.TrimSpace(m.overlay.Message) != "" {
		lines = append(lines, "", m.overlay.Message)
	}
	return cardStyle.Width(width).Render(strings.Join(lines, "\n"))
}

func (m Model) View() string {
	header := m.renderHeader()
	var body string
	if m.useStackedLayout() {
		sidebar := m.renderSidebarPanel(max(32, m.width-4))
		content := m.renderContentPanel(max(32, m.width-4), max(12, m.height/3))
		detail := m.renderDetailPanel(max(36, m.width-4), max(10, m.height/3))
		jobs := m.renderJobsPanel(max(36, m.width-4), max(minJobsHeight, m.height/5))
		logs := m.renderLogsPanel(max(36, m.width-4), max(minJobsHeight, m.height/5))
		body = lipgloss.JoinVertical(lipgloss.Left, sidebar, content, detail, jobs, logs)
	} else {
		jobsHeight := max(minJobsHeight, m.height/4)
		mainHeight := max(16, m.height-jobsHeight-8)
		sidebarWidth := max(minSidebarWidth, m.width/5)
		contentWidth := max(minContentWidth, m.width/3)
		detailWidth := max(minDetailWidth, m.width-sidebarWidth-contentWidth-8)
		top := lipgloss.JoinHorizontal(
			lipgloss.Top,
			m.renderSidebarPanel(sidebarWidth),
			m.renderContentPanel(contentWidth, mainHeight),
			m.renderDetailPanel(detailWidth, mainHeight),
		)
		jobsWidth := max(minJobsWidth, m.width/2)
		logsWidth := max(minLogsWidth, m.width-jobsWidth-4)
		jobs := m.renderJobsPanel(jobsWidth, jobsHeight)
		logs := m.renderLogsPanel(logsWidth, jobsHeight)
		bottom := lipgloss.JoinHorizontal(lipgloss.Top, jobs, logs)
		body = lipgloss.JoinVertical(lipgloss.Left, top, bottom)
	}
	if m.overlay.Mode != overlayNone {
		body = lipgloss.JoinVertical(lipgloss.Left, body, "", m.renderOverlayCard(max(48, m.width-4)))
	}
	status := m.renderStatusLine()
	footer := footerStyle.Render("Up/Down move | Tab focus | Enter detail/action | : palette | / filter | b/f history | e export | ? help | q quit")
	if m.wizard.active {
		footer = footerStyle.Render("Wizard: Tab move fields | Enter continue/create | Esc cancel")
	} else if m.overlay.Mode == overlayPalette {
		footer = footerStyle.Render("Palette: type to filter | Up/Down select | Enter run | Esc close")
	} else if m.overlay.Mode == overlayPrompt {
		footer = footerStyle.Render("Prompt: Enter submit | Tab move fields | Esc cancel")
	} else if m.overlay.Mode == overlayFilter {
		footer = footerStyle.Render("Filter: type to narrow current section | Enter apply | Esc cancel")
	} else if m.overlay.Mode == overlayHelp {
		footer = footerStyle.Render("Help: Enter or Esc closes | mouse click focuses panes | wheel scrolls active panes")
	} else if m.activeView == viewRestore && m.focus == focusContent {
		footer = footerStyle.Render("Restore: Up/Down select point | u restore selected point | Enter detail | / filter | e export | q quit")
	}
	return lipgloss.JoinVertical(
		lipgloss.Left,
		header,
		"",
		body,
		"",
		status,
		footer,
	)
}

func (m Model) Close() error {
	return nil
}

func RenderDoctorPlain(report backend.DoctorReport) string {
	stageMetrics := formatStageMetrics(report.Observability.Indexing.Stages)
	lines := []string{
		fmt.Sprintf("context++ CLI doctor for %s", report.Root),
		fmt.Sprintf("Branch: %s", report.RepoStatus.Branch),
		fmt.Sprintf("Unstaged: %d | Untracked: %d", report.RepoStatus.UnstagedCount, report.RepoStatus.UntrackedCount),
		fmt.Sprintf("Active generation: %d", report.Serving.ActiveGeneration),
		fmt.Sprintf("Pending generation: %s", formatOptionalInt(report.Serving.PendingGeneration)),
		fmt.Sprintf("Freshness: %s", report.Serving.ActiveGenerationFreshness),
	}
	if report.IndexValidation.OK {
		lines = append(lines, "Prepared index: OK")
	} else {
		lines = append(lines, fmt.Sprintf("Prepared index: %d issues", len(report.IndexValidation.Issues)))
	}
	if report.Ollama.OK {
		lines = append(lines, fmt.Sprintf("Ollama: %d running models", len(report.Ollama.Models)))
	} else {
		lines = append(lines, "Ollama: "+report.Ollama.Error)
	}
	lines = append(lines,
		fmt.Sprintf("Hub suggestions: %d", report.HubSummary.SuggestionCount),
		fmt.Sprintf("Restore points: %d", report.RestorePointCount),
		fmt.Sprintf(
			"Hybrid vectors: chunk %d/%d %s | identifier %d/%d %s",
			report.HybridVectors.Chunk.VectorCoverage.LoadedVectorCount,
			report.HybridVectors.Chunk.VectorCoverage.RequestedVectorCount,
			report.HybridVectors.Chunk.VectorCoverage.State,
			report.HybridVectors.Identifier.VectorCoverage.LoadedVectorCount,
			report.HybridVectors.Identifier.VectorCoverage.RequestedVectorCount,
			report.HybridVectors.Identifier.VectorCoverage.State,
		),
		fmt.Sprintf("Tree-sitter parse failures: %d", report.TreeSitter.TotalParseFailures),
		fmt.Sprintf(
			"Embedding cache hits: namespace %d | vector %d",
			report.Observability.Caches.Embeddings.ProcessNamespaceHits,
			report.Observability.Caches.Embeddings.ProcessVectorHits,
		),
		fmt.Sprintf("Stage metrics: %s", stageMetrics),
		fmt.Sprintf("Parse failures by language: %s", formatParseFailuresByLanguage(report.Observability.Integrity.ParseFailuresByLanguage)),
		fmt.Sprintf("Fallback markers: %d", report.Observability.Integrity.FallbackMarkerCount),
		fmt.Sprintf(
			"Scheduler: queue depth %d | pending changes %d | pending job %s | max %d | batches %d | deduped %d | canceled %d | superseded %d",
			report.Observability.Scheduler.QueueDepth,
			report.Observability.Scheduler.PendingChangeCount,
			formatBlankAsNone(report.Observability.Scheduler.PendingJobKind),
			report.Observability.Scheduler.MaxQueueDepth,
			report.Observability.Scheduler.BatchCount,
			report.Observability.Scheduler.DedupedPathEvents,
			report.Observability.Scheduler.CanceledJobs,
			report.Observability.Scheduler.SupersededJobs,
		),
		fmt.Sprintf("Pending paths: %s", formatSliceOrNone(report.Observability.Scheduler.PendingPaths)),
	)
	if len(report.Observability.Scheduler.FullRebuildReasons) > 0 {
		lines = append(lines, "Recent full rebuild reasons:")
		for _, reason := range report.Observability.Scheduler.FullRebuildReasons {
			lines = append(lines, "- "+reason)
		}
	}
	return strings.Join(lines, "\n")
}

func RenderSnapshot(root string, client *backend.Client) (string, error) {
	model := NewModel(root, client)
	report, err := client.Doctor(context.Background(), root)
	if err != nil {
		return "", err
	}
	model.doctor = report
	model.doctorLoaded = true
	model.watchEnabled = report.Observability.Scheduler.WatchEnabled
	model.queueDepth = report.Observability.Scheduler.QueueDepth
	model.pendingPaths = append([]string(nil), report.Observability.Scheduler.PendingPaths...)
	model.pendingJobKind = report.Observability.Scheduler.PendingJobKind
	model.refreshOverviewSection()
	model.logs = []string{"Snapshot rendered from live backend data."}
	model.width = 120
	model.height = 38
	model.refreshSidebar()
	model.syncDetailViewport()
	model.syncLogViewport(true)
	model.refreshJobTable()
	return model.View(), nil
}

func buildTreeItems(text string) []contentItem {
	lines := splitNonEmptyLines(text)
	items := make([]contentItem, 0, len(lines))
	pathStack := make([]string, 0, 12)
	for index, raw := range lines {
		indent := countLeadingSpaces(raw) / 2
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		for len(pathStack) > indent {
			pathStack = pathStack[:len(pathStack)-1]
		}
		title := line
		badge := "entry"
		summary := fmt.Sprintf("Tree line %d", index+1)
		switch {
		case strings.HasSuffix(line, "/"):
			badge = "dir"
			title = strings.TrimSuffix(line, "/")
			if title == "." {
				title = "./"
			}
			if title != "./" {
				pathStack = append(pathStack, title)
			}
			summary = fmt.Sprintf("Directory depth %d", indent)
		case strings.Contains(line, " | "):
			parts := strings.SplitN(line, " | ", 3)
			title = parts[0]
			badge = "file"
			if len(parts) > 1 {
				summary = strings.Join(parts[1:], " | ")
			}
		case strings.Contains(line, ": "):
			parts := strings.SplitN(line, ": ", 2)
			badge = parts[0]
			title = signatureTitle(parts[1])
			summary = truncate(parts[1], 96)
		default:
			title = truncate(line, 96)
		}
		items = append(items, contentItem{
			ID:      fmt.Sprintf("tree-%d", index),
			Title:   truncate(title, 88),
			Summary: summary,
			Badge:   badge,
			Detail: strings.Join([]string{
				fmt.Sprintf("Tree line: %d", index+1),
				fmt.Sprintf("Badge: %s", badge),
				fmt.Sprintf("Path context: %s", formatPathStack(pathStack)),
				line,
			}, "\n"),
		})
	}
	return items
}

func buildHubItems(text string) []contentItem {
	return buildBlockItems("hub", text)
}

func buildClusterItems(text string) []contentItem {
	return buildBlockItems("cluster", text)
}

func buildTextFallbackItems(prefix string, text string) []contentItem {
	lines := splitNonEmptyLines(text)
	items := make([]contentItem, 0, len(lines))
	for index, line := range lines {
		items = append(items, contentItem{
			ID:      fmt.Sprintf("%s-%d", prefix, index),
			Title:   truncate(strings.TrimSpace(line), 88),
			Summary: fmt.Sprintf("Line %d", index+1),
			Detail:  line,
		})
	}
	return items
}

func buildBlockItems(prefix string, text string) []contentItem {
	blocks := splitBlocks(text)
	items := make([]contentItem, 0, len(blocks))
	for index, block := range blocks {
		lines := splitNonEmptyLines(block)
		if len(lines) == 0 {
			continue
		}
		title := strings.TrimSpace(lines[0])
		summary := ""
		badge := prefix
		if strings.HasPrefix(title, "[") && strings.Contains(title, "]") {
			badge = strings.Trim(strings.SplitN(title, "]", 2)[0], "[]")
		}
		if len(lines) > 1 {
			summary = truncate(lines[1], 90)
		}
		items = append(items, contentItem{
			ID:      fmt.Sprintf("%s-%d", prefix, index),
			Title:   truncate(title, 88),
			Summary: summary,
			Badge:   badge,
			Detail:  strings.Join(lines, "\n"),
		})
	}
	return items
}

func renderRestorePoints(points []backend.RestorePoint) string {
	if len(points) == 0 {
		return "Restore points (0)\nNo restore points."
	}
	lines := []string{fmt.Sprintf("Restore points (%d)", len(points))}
	for _, point := range points {
		lines = append(lines, fmt.Sprintf("- %s | %d | %s", point.ID, point.Timestamp, point.Message))
	}
	return strings.Join(lines, "\n")
}

func buildRestoreItems(points []backend.RestorePoint) []contentItem {
	items := make([]contentItem, 0, len(points))
	for _, point := range points {
		files := strings.Join(point.Files, ", ")
		items = append(items, contentItem{
			ID:      point.ID,
			Title:   point.ID,
			Summary: point.Message,
			Badge:   time.UnixMilli(point.Timestamp).UTC().Format("2006-01-02 15:04:05Z"),
			Detail: strings.Join([]string{
				fmt.Sprintf("Restore point: %s", point.ID),
				fmt.Sprintf("Timestamp: %s", time.UnixMilli(point.Timestamp).UTC().Format(time.RFC3339)),
				fmt.Sprintf("Message: %s", point.Message),
				fmt.Sprintf("Files: %s", files),
			}, "\n"),
		})
	}
	return items
}

func buildStatusRows(summary backend.RepoStatusSummary) ([]contentItem, []table.Row) {
	items := make([]contentItem, 0, len(summary.Files))
	rows := make([]table.Row, 0, len(summary.Files))
	for _, file := range summary.Files {
		items = append(items, contentItem{
			ID:      file.Path,
			Title:   file.Path,
			Summary: fmt.Sprintf("index %s | worktree %s", renderGitStatusCode(file.Index), renderGitStatusCode(file.WorkingTree)),
			Badge:   renderGitStatusBadge(file),
			Detail: strings.Join([]string{
				fmt.Sprintf("Path: %s", file.Path),
				fmt.Sprintf("Branch: %s", summary.Branch),
				fmt.Sprintf("Ahead/behind: %d/%d", summary.Ahead, summary.Behind),
				fmt.Sprintf("Index status: %s", renderGitStatusCode(file.Index)),
				fmt.Sprintf("Worktree status: %s", renderGitStatusCode(file.WorkingTree)),
				fmt.Sprintf("Repo totals: staged=%d unstaged=%d untracked=%d conflicted=%d", summary.StagedCount, summary.UnstagedCount, summary.UntrackedCount, summary.ConflictedCount),
			}, "\n"),
		})
		rows = append(rows, table.Row{
			truncate(file.Path, 42),
			renderGitStatusCode(file.Index),
			renderGitStatusCode(file.WorkingTree),
		})
	}
	return items, rows
}

func buildChangesRows(summary backend.RepoChangesSummary) ([]contentItem, []table.Row) {
	items := make([]contentItem, 0, len(summary.Files))
	rows := make([]table.Row, 0, len(summary.Files))
	for _, file := range summary.Files {
		state := fmt.Sprintf("staged %s | unstaged %s", renderGitStatusCode(file.Staged), renderGitStatusCode(file.Unstaged))
		rangeLines := make([]string, 0, len(file.Ranges))
		for _, changeRange := range file.Ranges {
			rangeLines = append(rangeLines, fmt.Sprintf("old %d:%d -> new %d:%d", changeRange.OldStart, changeRange.OldLines, changeRange.NewStart, changeRange.NewLines))
		}
		if len(rangeLines) == 0 {
			rangeLines = append(rangeLines, "No diff ranges recorded.")
		}
		patch := strings.TrimSpace(file.Patch)
		if patch == "" {
			patch = "No patch text recorded."
		}
		items = append(items, contentItem{
			ID:      file.Path,
			Title:   file.Path,
			Summary: fmt.Sprintf("+%d -%d | %s", file.Additions, file.Deletions, state),
			Badge:   renderChangeBadge(file),
			Detail: strings.Join([]string{
				fmt.Sprintf("Path: %s", file.Path),
				fmt.Sprintf("Additions: %d", file.Additions),
				fmt.Sprintf("Deletions: %d", file.Deletions),
				fmt.Sprintf("Staged status: %s", renderGitStatusCode(file.Staged)),
				fmt.Sprintf("Unstaged status: %s", renderGitStatusCode(file.Unstaged)),
				"Ranges:",
				strings.Join(rangeLines, "\n"),
				"",
				"Patch:",
				patch,
			}, "\n"),
		})
		rows = append(rows, table.Row{
			truncate(file.Path, 40),
			fmt.Sprintf("+%d/-%d", file.Additions, file.Deletions),
			state,
		})
	}
	return items, rows
}

func buildSearchItems(payload backend.SearchResultPayload) []contentItem {
	items := make([]contentItem, 0, len(payload.SymbolHits)+len(payload.PathHits)+len(payload.WordHits)+len(payload.Hits))
	total := len(payload.SymbolHits) + len(payload.PathHits) + len(payload.WordHits) + len(payload.Hits)
	rank := 1
	for _, hit := range payload.SymbolHits {
		items = append(items, contentItem{
			ID:      fmt.Sprintf("%s:%d", hit.Path, hit.Line),
			Title:   hit.Name,
			Summary: fmt.Sprintf("rank #%d/%d | %s | %s:%d-%d", rank, total, hit.Kind, hit.Path, hit.Line, hit.EndLine),
			Badge:   fmt.Sprintf("exact-symbol #%d", rank),
			Detail: strings.Join([]string{
				fmt.Sprintf("Rank: %d of %d", rank, total),
				fmt.Sprintf("Path: %s", hit.Path),
				fmt.Sprintf("Kind: %s", hit.Kind),
				fmt.Sprintf("Range: %d-%d", hit.Line, hit.EndLine),
				fmt.Sprintf("Signature: %s", hit.Signature),
				fmt.Sprintf("Header: %s", hit.Header),
			}, "\n"),
		})
		rank++
	}
	for _, path := range payload.PathHits {
		items = append(items, contentItem{
			ID:      path,
			Title:   path,
			Summary: fmt.Sprintf("rank #%d/%d | exact path match", rank, total),
			Badge:   fmt.Sprintf("exact-path #%d", rank),
			Detail: strings.Join([]string{
				fmt.Sprintf("Rank: %d of %d", rank, total),
				fmt.Sprintf("Path hit: %s", path),
			}, "\n"),
		})
		rank++
	}
	for _, hit := range payload.WordHits {
		items = append(items, contentItem{
			ID:      fmt.Sprintf("%s:%d:%s", hit.Path, hit.Line, hit.Token),
			Title:   hit.Title,
			Summary: fmt.Sprintf("rank #%d/%d | %.2f | %s", rank, total, hit.Score, hit.Path),
			Badge:   fmt.Sprintf("word-%s #%d", hit.Kind, rank),
			Detail: strings.Join([]string{
				fmt.Sprintf("Rank: %d of %d", rank, total),
				fmt.Sprintf("Token: %s", hit.Token),
				fmt.Sprintf("Kind: %s", hit.Kind),
				fmt.Sprintf("Path: %s", hit.Path),
				fmt.Sprintf("Line: %d", hit.Line),
				fmt.Sprintf("Score: %.2f", hit.Score),
				fmt.Sprintf("Snippet: %s", hit.Snippet),
			}, "\n"),
		})
		rank++
	}
	for _, hit := range payload.Hits {
		items = append(items, contentItem{
			ID:      fmt.Sprintf("%s:%d:%s", hit.Path, hit.Line, hit.EntityType),
			Title:   hit.Title,
			Summary: fmt.Sprintf("rank #%d/%d | score %.2f | %s", rank, total, hit.Score, hit.Path),
			Badge:   fmt.Sprintf("related-%s #%d", hit.EntityType, rank),
			Detail: strings.Join([]string{
				fmt.Sprintf("Rank: %d of %d", rank, total),
				fmt.Sprintf("Entity type: %s", hit.EntityType),
				fmt.Sprintf("Kind: %s", hit.Kind),
				fmt.Sprintf("Path: %s", hit.Path),
				fmt.Sprintf("Line: %d", hit.Line),
				fmt.Sprintf("Score: %.2f", hit.Score),
				fmt.Sprintf("Snippet: %s", hit.Snippet),
			}, "\n"),
		})
		rank++
	}
	return items
}

func buildFindHubItems(text string) []contentItem {
	blocks := splitBlocks(text)
	items := make([]contentItem, 0, len(blocks))
	for index, block := range blocks {
		lines := splitNonEmptyLines(block)
		if len(lines) == 0 || !strings.Contains(lines[0], ". ") {
			continue
		}
		title := strings.TrimSpace(lines[0])
		summary := ""
		if len(lines) > 2 {
			summary = strings.TrimSpace(lines[2])
		} else if len(lines) > 1 {
			summary = strings.TrimSpace(lines[1])
		}
		badge := "manual"
		if strings.Contains(title, "[suggested]") {
			badge = "suggested"
		}
		items = append(items, contentItem{
			ID:      fmt.Sprintf("find-hub-%d", index),
			Title:   truncate(title, 88),
			Summary: truncate(summary, 96),
			Badge:   badge,
			Detail:  strings.Join(lines, "\n"),
		})
	}
	if len(items) > 0 {
		return items
	}
	return buildBlockItems("find-hub", text)
}

type indexedItem struct {
	index int
	value contentItem
}

func visibleItems(items []contentItem, selected int, maxRows int) []indexedItem {
	if len(items) == 0 {
		return nil
	}
	start, end := visibleRange(len(items), selected, maxRows)
	if start == 0 && end == len(items) {
		result := make([]indexedItem, 0, len(items))
		for index, item := range items {
			result = append(result, indexedItem{index: index, value: item})
		}
		return result
	}
	result := make([]indexedItem, 0, end-start)
	for index := start; index < end; index++ {
		result = append(result, indexedItem{index: index, value: items[index]})
	}
	return result
}

func visibleRange(total int, selected int, maxRows int) (int, int) {
	if total <= 0 {
		return 0, 0
	}
	if maxRows <= 0 || total <= maxRows {
		return 0, total
	}
	start := selected - maxRows/2
	if start < 0 {
		start = 0
	}
	end := start + maxRows
	if end > total {
		end = total
		start = max(0, end-maxRows)
	}
	return start, end
}

func selectedCountLabel(selected int, total int) int {
	if total <= 0 {
		return 1
	}
	if selected < 0 {
		return 1
	}
	if selected >= total {
		return total
	}
	return selected + 1
}

func countLeadingSpaces(value string) int {
	count := 0
	for _, char := range value {
		if char != ' ' {
			break
		}
		count++
	}
	return count
}

func signatureTitle(signature string) string {
	candidate := strings.TrimSpace(signature)
	if candidate == "" {
		return "unknown"
	}
	if open := strings.Index(candidate, "("); open > 0 {
		parts := strings.Fields(candidate[:open])
		if len(parts) > 0 {
			return parts[len(parts)-1]
		}
	}
	parts := strings.Fields(candidate)
	return parts[len(parts)-1]
}

func formatPathStack(stack []string) string {
	if len(stack) == 0 {
		return "./"
	}
	return "./" + strings.Join(stack, "/")
}

func renderGitStatusCode(value string) string {
	code := strings.TrimSpace(value)
	if code == "" {
		return "clean"
	}
	if code == "?" {
		return "untracked"
	}
	return code
}

func renderGitStatusBadge(file backend.RepoStatusFile) string {
	switch {
	case file.Index == "?" || file.WorkingTree == "?":
		return "untracked"
	case file.Index == "U" || file.WorkingTree == "U":
		return "conflict"
	case file.Index == "R" || file.WorkingTree == "R":
		return "renamed"
	case file.Index == "A" || file.WorkingTree == "A":
		return "created"
	case file.Index == "D" || file.WorkingTree == "D":
		return "deleted"
	case file.Index == "M" || file.WorkingTree == "M":
		return "modified"
	default:
		return "clean"
	}
}

func renderChangeBadge(file backend.ChangeEntry) string {
	switch {
	case file.Staged == "?" || file.Unstaged == "?":
		return "untracked"
	case file.Staged == "R" || file.Unstaged == "R":
		return "renamed"
	case file.Staged == "D" || file.Unstaged == "D":
		return "deleted"
	case file.Staged == "A" || file.Unstaged == "A":
		return "created"
	default:
		return "changed"
	}
}

func splitBlocks(text string) []string {
	raw := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n\n")
	blocks := make([]string, 0, len(raw))
	for _, block := range raw {
		if strings.TrimSpace(block) == "" {
			continue
		}
		blocks = append(blocks, block)
	}
	return blocks
}

func splitNonEmptyLines(text string) []string {
	raw := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}

func renderPaneTitle(title string, active bool) string {
	if active {
		return paneHeaderActive.Render(title)
	}
	return paneHeaderIdle.Render(title)
}

func formatStageMetricsDetail(stages map[string]struct {
	DurationMs      int            `json:"durationMs"`
	PhaseDurations  map[string]int `json:"phaseDurationsMs"`
	ProcessedFiles  *int           `json:"processedFiles"`
	IndexedChunks   *int           `json:"indexedChunks"`
	EmbeddedCount   *int           `json:"embeddedCount"`
	FilesPerSecond  *float64       `json:"filesPerSecond"`
	ChunksPerSecond *float64       `json:"chunksPerSecond"`
	EmbedsPerSecond *float64       `json:"embedsPerSecond"`
}) string {
	if len(stages) == 0 {
		return "No stage metrics available."
	}
	order := []string{"bootstrap", "file-search", "identifier-search", "full-artifacts"}
	lines := make([]string, 0, len(order)*4)
	for _, stage := range order {
		metrics, ok := stages[stage]
		if !ok {
			continue
		}
		lines = append(lines, detailHeader.Render(stage))
		lines = append(lines, fmt.Sprintf("Duration: %dms", metrics.DurationMs))
		if metrics.FilesPerSecond != nil {
			lines = append(lines, fmt.Sprintf("Files/s: %.2f", *metrics.FilesPerSecond))
		}
		if metrics.ChunksPerSecond != nil {
			lines = append(lines, fmt.Sprintf("Chunks/s: %.2f", *metrics.ChunksPerSecond))
		}
		if metrics.EmbedsPerSecond != nil {
			lines = append(lines, fmt.Sprintf("Embeds/s: %.2f", *metrics.EmbedsPerSecond))
		}
		if len(metrics.PhaseDurations) > 0 {
			lines = append(lines, "Phase durations:")
			for _, phase := range sortedPhaseKeys(metrics.PhaseDurations) {
				lines = append(lines, fmt.Sprintf("- %s: %dms", phase, metrics.PhaseDurations[phase]))
			}
		}
		lines = append(lines, "")
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func sortedPhaseKeys(values map[string]int) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func formatFullRebuildReasons(reasons []string) string {
	if len(reasons) == 0 {
		return "Recent full rebuild reasons: none"
	}
	lines := []string{"Recent full rebuild reasons:"}
	for _, reason := range reasons {
		lines = append(lines, "- "+reason)
	}
	return strings.Join(lines, "\n")
}

func formatOllamaSummary(status backend.OllamaRuntimeStatus) string {
	if status.OK {
		return fmt.Sprintf("%d models", len(status.Models))
	}
	if strings.TrimSpace(status.Error) == "" {
		return "offline"
	}
	return status.Error
}

func titleFromID(value string) string {
	parts := strings.Fields(strings.ReplaceAll(value, "-", " "))
	for index, part := range parts {
		if part == "" {
			continue
		}
		parts[index] = strings.ToUpper(part[:1]) + part[1:]
	}
	return strings.Join(parts, " ")
}

func slugify(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	replacer := strings.NewReplacer(" ", "-", "/", "-", "\\", "-", ":", "-", "_", "-")
	value = replacer.Replace(value)
	value = strings.Trim(value, "-")
	if value == "" {
		return "export"
	}
	return value
}

func jobStateLabel(job *jobState) string {
	if job == nil {
		return "idle"
	}
	state := strings.TrimSpace(job.State)
	if state == "" {
		return "idle"
	}
	if job.Pending && state == "running" {
		return "running*"
	}
	return state
}

func isActiveJobState(state string) bool {
	return state == "progress" || state == "queued" || state == "running"
}

func formatJobPercent(value *int) string {
	if value == nil {
		return "--"
	}
	return fmt.Sprintf("%d", *value)
}

func formatElapsedMs(value int) string {
	if value <= 0 {
		return "--"
	}
	return fmt.Sprintf("%.1fs", float64(value)/1000)
}

func intPtr(value int) *int {
	return &value
}

func truncate(value string, limit int) string {
	if limit <= 3 || len(value) <= limit {
		return value
	}
	return value[:limit-3] + "..."
}

func min(left int, right int) int {
	if left < right {
		return left
	}
	return right
}

func max(left int, right int) int {
	if left > right {
		return left
	}
	return right
}

func formatOptionalInt(value *int) string {
	if value == nil {
		return "none"
	}
	return fmt.Sprintf("%d", *value)
}

func formatBlankAsNone(value string) string {
	if strings.TrimSpace(value) == "" {
		return "none"
	}
	return value
}

func formatSliceOrNone(values []string) string {
	if len(values) == 0 {
		return "none"
	}
	return strings.Join(values, ", ")
}

func formatParseFailuresByLanguage(values map[string]int) string {
	if len(values) == 0 {
		return "none"
	}
	languages := make([]string, 0, len(values))
	for language := range values {
		languages = append(languages, language)
	}
	sort.Strings(languages)
	parts := make([]string, 0, len(languages))
	for _, language := range languages {
		parts = append(parts, fmt.Sprintf("%s:%d", language, values[language]))
	}
	return strings.Join(parts, ", ")
}

func formatStageMetrics(stages map[string]struct {
	DurationMs      int            `json:"durationMs"`
	PhaseDurations  map[string]int `json:"phaseDurationsMs"`
	ProcessedFiles  *int           `json:"processedFiles"`
	IndexedChunks   *int           `json:"indexedChunks"`
	EmbeddedCount   *int           `json:"embeddedCount"`
	FilesPerSecond  *float64       `json:"filesPerSecond"`
	ChunksPerSecond *float64       `json:"chunksPerSecond"`
	EmbedsPerSecond *float64       `json:"embedsPerSecond"`
}) string {
	if len(stages) == 0 {
		return "none"
	}
	order := []string{"bootstrap", "file-search", "identifier-search", "full-artifacts"}
	parts := make([]string, 0, len(order))
	for _, stage := range order {
		metrics, ok := stages[stage]
		if !ok {
			continue
		}
		throughput := make([]string, 0, 3)
		if metrics.FilesPerSecond != nil {
			throughput = append(throughput, fmt.Sprintf("files/s %.2f", *metrics.FilesPerSecond))
		}
		if metrics.ChunksPerSecond != nil {
			throughput = append(throughput, fmt.Sprintf("chunks/s %.2f", *metrics.ChunksPerSecond))
		}
		if metrics.EmbedsPerSecond != nil {
			throughput = append(throughput, fmt.Sprintf("embeds/s %.2f", *metrics.EmbedsPerSecond))
		}
		part := fmt.Sprintf("%s %dms", stage, metrics.DurationMs)
		if len(throughput) > 0 {
			part += " (" + strings.Join(throughput, " | ") + ")"
		}
		parts = append(parts, part)
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, " ; ")
}
