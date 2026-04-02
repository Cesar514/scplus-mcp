// Human CLI operator console state and rendering.
// FEATURE: keeps pane layout, typed section state, and backend-driven actions.
package ui

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"contextplus/cli/internal/backend"
	"contextplus/cli/internal/hubs"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

const (
	viewOverview = "overview"
	viewTree     = "tree"
	viewHubs     = "hubs"
	viewRestore  = "restore"
	viewCluster  = "cluster"
)

const (
	focusSidebar = iota
	focusContent
	focusDetail
	focusWizard
)

const (
	logLimit         = 12
	minSidebarWidth  = 26
	minContentWidth  = 32
	minDetailWidth   = 36
	minJobsHeight    = 7
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

type sectionState struct {
	ID           string
	Title        string
	Subtitle     string
	Items        []contentItem
	Selected     int
	EmptyMessage string
}

type Model struct {
	root          string
	client        *backend.Client
	width         int
	height        int
	magicianFrame int
	doctor        backend.DoctorReport
	doctorLoaded  bool
	restorePoints []backend.RestorePoint
	detail        viewport.Model
	logs          []string
	lastError     string
	indexing      bool
	watchEnabled  bool
	backendOnline bool
	jobPhase      string
	jobMessage    string
	queueDepth    int
	jobReason     string
	focus         int
	activeView    string
	sidebarIndex  int
	sidebar       []navigationEntry
	sections      map[string]*sectionState
	wizard        wizardState
}

func NewModel(root string, client *backend.Client) Model {
	detail := viewport.New(60, 20)
	model := Model{
		root:          root,
		client:        client,
		width:         120,
		height:        38,
		detail:        detail,
		logs:          []string{"Context+ CLI started."},
		wizard:        newWizardState(),
		backendOnline: true,
		activeView:    viewOverview,
		focus:         focusSidebar,
		sections: map[string]*sectionState{
			viewOverview: {
				ID:           viewOverview,
				Title:        "Overview",
				Subtitle:     "Operator health and observability summary",
				EmptyMessage: "Loading doctor report...",
			},
			viewTree: {
				ID:           viewTree,
				Title:        "Tree",
				Subtitle:     "Prepared structural tree context",
				EmptyMessage: "Loading tree view...",
			},
			viewHubs: {
				ID:           viewHubs,
				Title:        "Hubs",
				Subtitle:     "Feature hubs and suggestions",
				EmptyMessage: "Loading hub view...",
			},
			viewRestore: {
				ID:           viewRestore,
				Title:        "Restore",
				Subtitle:     "Restore-point history",
				EmptyMessage: "Loading restore points...",
			},
			viewCluster: {
				ID:           viewCluster,
				Title:        "Cluster",
				Subtitle:     "Persisted semantic cluster summaries",
				EmptyMessage: "Loading cluster view...",
			},
		},
	}
	model.refreshSidebar()
	model.syncDetailViewport()
	return model
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
	)
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(animateCmd(), refreshAllCmd(m.client, m.root), waitForBackendEventCmd(m.client.Events()))
}

func (m *Model) appendLog(line string) {
	timestamp := time.Now().Format("15:04:05")
	m.logs = append([]string{fmt.Sprintf("[%s] %s", timestamp, line)}, m.logs...)
	if len(m.logs) > logLimit {
		m.logs = m.logs[:logLimit]
	}
}

func (m *Model) setError(err error) {
	if err == nil {
		m.lastError = ""
		return
	}
	m.lastError = err.Error()
	m.appendLog("ERROR: " + err.Error())
}

func (m *Model) refreshSidebar() {
	watchLabel := "Enable watcher"
	watchSubtitle := "Watch for file changes and queue refresh work"
	if m.watchEnabled {
		watchLabel = "Disable watcher"
		watchSubtitle = "Stop watcher-driven refresh jobs"
	}
	indexLabel := "Run full index"
	indexSubtitle := "Start a full engine refresh"
	if m.indexing {
		indexLabel = "Index running"
		indexSubtitle = "Watch the job layer for progress"
	}
	m.sidebar = []navigationEntry{
		{ID: viewOverview, Title: "Overview", Subtitle: "Health, serving, and observability"},
		{ID: viewTree, Title: "Tree", Subtitle: "Prepared tree and file topology"},
		{ID: viewHubs, Title: "Hubs", Subtitle: "Manual and suggested hub views"},
		{ID: viewRestore, Title: "Restore", Subtitle: "Checkpoint history and recovery"},
		{ID: viewCluster, Title: "Cluster", Subtitle: "Cluster and subsystem summaries"},
		{ID: "refresh", Title: "Refresh data", Subtitle: "Reload backend snapshots", IsAction: true, Action: "refresh"},
		{ID: "index", Title: indexLabel, Subtitle: indexSubtitle, IsAction: true, Action: "index"},
		{ID: "watch", Title: watchLabel, Subtitle: watchSubtitle, IsAction: true, Action: "watch"},
		{ID: "hub-create", Title: "New hub", Subtitle: "Create a manual feature hub", IsAction: true, Action: "hub-create"},
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
	if m.activeSection().Selected >= len(m.activeSection().Items) {
		m.activeSection().Selected = max(0, len(m.activeSection().Items)-1)
	}
	m.syncDetailViewport()
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
	section.Items = []contentItem{
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
			ID:      "scheduler",
			Title:   "Scheduler",
			Summary: fmt.Sprintf("queue %d | batches %d | canceled %d", m.doctor.Observability.Scheduler.QueueDepth, m.doctor.Observability.Scheduler.BatchCount, m.doctor.Observability.Scheduler.CanceledJobs),
			Detail: strings.Join([]string{
				fmt.Sprintf("Watcher enabled: %t", m.doctor.Observability.Scheduler.WatchEnabled),
				fmt.Sprintf("Queue depth: %d", m.doctor.Observability.Scheduler.QueueDepth),
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
	if section.Selected >= len(section.Items) {
		section.Selected = max(0, len(section.Items)-1)
	}
}

func (m *Model) setTextSection(kind string, text string) {
	section := m.sections[kind]
	if section == nil {
		return
	}
	switch kind {
	case viewTree:
		section.Items = parseLineItems(kind, text)
	case viewHubs, viewCluster:
		section.Items = parseBlockItems(kind, text)
	default:
		section.Items = parseLineItems(kind, text)
	}
	if section.Selected >= len(section.Items) {
		section.Selected = max(0, len(section.Items)-1)
	}
}

func (m *Model) setRestorePoints(points []backend.RestorePoint) {
	m.restorePoints = points
	section := m.sections[viewRestore]
	if section == nil {
		return
	}
	section.Items = buildRestoreItems(points)
	if section.Selected >= len(section.Items) {
		section.Selected = max(0, len(section.Items)-1)
	}
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
	m.syncDetailViewport()
}

func (m *Model) cycleFocus(delta int) {
	order := []int{focusSidebar, focusContent, focusDetail}
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
}

func (m *Model) executeSidebarSelection() tea.Cmd {
	if len(m.sidebar) == 0 {
		return nil
	}
	entry := m.sidebar[m.sidebarIndex]
	if !entry.IsAction {
		m.setActiveView(entry.ID)
		m.focus = focusContent
		return nil
	}
	switch entry.Action {
	case "refresh":
		m.appendLog("manual refresh requested")
		return refreshAllCmd(m.client, m.root)
	case "index":
		if m.indexing {
			m.appendLog("index already running")
			return nil
		}
		m.indexing = true
		m.refreshSidebar()
		m.appendLog("manual full index requested")
		return runIndexCmd(m.client, m.root)
	case "watch":
		return m.toggleWatcher()
	case "hub-create":
		m.wizard = newWizardState()
		m.wizard.active = true
		m.focus = focusWizard
		m.setActiveView(viewHubs)
		m.syncDetailViewport()
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
			return m, nil
		}
		m.backendOnline = true
		m.doctor = message.report
		m.doctorLoaded = true
		m.watchEnabled = message.report.Observability.Scheduler.WatchEnabled
		m.queueDepth = message.report.Observability.Scheduler.QueueDepth
		m.refreshOverviewSection()
		m.refreshSidebar()
		m.syncDetailViewport()
		m.appendLog("doctor report refreshed")
		return m, nil
	case textLoadedMsg:
		if message.err != nil {
			m.setError(message.err)
			return m, nil
		}
		m.setTextSection(message.kind, message.text)
		m.syncDetailViewport()
		return m, nil
	case restoreLoadedMsg:
		if message.err != nil {
			m.setError(message.err)
			return m, nil
		}
		m.setRestorePoints(message.points)
		m.syncDetailViewport()
		return m, nil
	case indexFinishedMsg:
		m.indexing = false
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
			m.refreshSidebar()
		case "watch-batch":
			m.queueDepth = message.event.QueueDepth
			if len(message.event.ChangedPaths) > 0 {
				m.appendLog("detected changes: " + strings.Join(message.event.ChangedPaths, ", "))
			}
		case "job":
			m.jobPhase = message.event.Phase
			m.jobMessage = message.event.Message
			m.jobReason = message.event.RebuildReason
			m.queueDepth = message.event.QueueDepth
			m.indexing = message.event.State == "running" || message.event.State == "progress" || message.event.State == "queued"
			m.refreshSidebar()
		}
		m.refreshOverviewSection()
		m.syncDetailViewport()
		return m, waitForBackendEventCmd(m.client.Events())
	case tea.KeyMsg:
		if m.wizard.active && m.focus == focusWizard {
			return m.updateWizard(message)
		}
		switch message.String() {
		case "ctrl+c", "q":
			return m, tea.Quit
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
			}
			return m, nil
		case "right":
			if m.focus == focusSidebar {
				m.focus = focusContent
			} else if m.focus == focusContent {
				m.focus = focusDetail
			}
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
		case "down", "j":
			if m.focus == focusSidebar {
				m.moveSidebar(1)
				return m, nil
			}
			if m.focus == focusContent {
				m.moveContent(1)
				return m, nil
			}
		case "enter":
			if m.focus == focusSidebar {
				return m, m.executeSidebarSelection()
			}
			if m.focus == focusContent {
				m.focus = focusDetail
				return m, nil
			}
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
		}
		if m.focus == focusDetail {
			m.detail, cmd = m.detail.Update(message)
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
	subtitle := "Operator console with navigation, detail, and job layers"
	if m.useStackedLayout() {
		subtitle = "Stacked operator console for narrow terminals"
	}
	return lipgloss.JoinHorizontal(
		lipgloss.Top,
		magician,
		lipgloss.NewStyle().MarginLeft(2).Render(
			titleStyle.Render("Context+ Human CLI")+"\n"+
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

func (m Model) renderContentPanel(width int) string {
	section := m.activeSection()
	windowSize := max(6, m.height/2)
	start, end := visibleRange(len(section.Items), section.Selected, windowSize)
	lines := []string{
		renderPaneTitle(section.Title, m.focus == focusContent),
		subtitleStyle.Render(section.Subtitle),
		subtitleStyle.Render(fmt.Sprintf("Selected %d/%d", min(section.Selected+1, max(1, len(section.Items))), max(1, len(section.Items)))),
		"",
	}
	if len(section.Items) == 0 {
		lines = append(lines, section.EmptyMessage)
		return cardStyle.Width(width).Render(strings.Join(lines, "\n"))
	}
	if start > 0 {
		lines = append(lines, subtitleStyle.Render(fmt.Sprintf("  ... %d earlier items hidden", start)))
	}
	for _, item := range visibleItems(section.Items, section.Selected, windowSize) {
		style := contentIdle
		if item.index == section.Selected {
			style = contentSelected
		}
		title := item.value.Title
		if item.value.Badge != "" {
			title += " [" + item.value.Badge + "]"
		}
		lines = append(lines, style.Render(title))
		if item.value.Summary != "" {
			lines = append(lines, subtitleStyle.Render("  "+truncate(item.value.Summary, width-6)))
		}
	}
	if end < len(section.Items) {
		lines = append(lines, subtitleStyle.Render(fmt.Sprintf("  ... %d more items hidden", len(section.Items)-end)))
	}
	return cardStyle.Width(width).Render(strings.Join(lines, "\n"))
}

func (m Model) renderDetailPanel(width int, height int) string {
	m.detail.Width = max(minDetailWidth, width-4)
	m.detail.Height = max(8, height-4)
	m.detail.SetContent(m.buildDetailContent())
	body := []string{
		renderPaneTitle("Detail", m.focus == focusDetail || m.focus == focusWizard),
		subtitleStyle.Render("Preview and operator context"),
		"",
		m.detail.View(),
	}
	return cardStyle.Width(width).Height(height).Render(strings.Join(body, "\n"))
}

func (m Model) renderJobsPanel(width int, height int) string {
	lines := []string{
		renderPaneTitle("Jobs", false),
		subtitleStyle.Render("Command layer, job layer, and recent backend activity"),
		"",
		fmt.Sprintf("Indexing: %s", map[bool]string{true: "running", false: "idle"}[m.indexing]),
		fmt.Sprintf("Watcher: %s", map[bool]string{true: "enabled", false: "disabled"}[m.watchEnabled]),
		fmt.Sprintf("Backend: %s", map[bool]string{true: "connected", false: "offline"}[m.backendOnline]),
		fmt.Sprintf("Phase: %s", formatBlankAsNone(m.jobPhase)),
		fmt.Sprintf("Message: %s", formatBlankAsNone(m.jobMessage)),
		fmt.Sprintf("Queue depth: %d", m.queueDepth),
		fmt.Sprintf("Rebuild reason: %s", formatBlankAsNone(m.jobReason)),
		"",
		"Recent log lines:",
	}
	if len(m.logs) == 0 {
		lines = append(lines, "No activity yet.")
	} else {
		lines = append(lines, m.logs...)
	}
	if m.lastError != "" {
		lines = append(lines, "", errorStyle.Render("Last error: "+m.lastError))
	}
	return cardStyle.Width(width).Height(height).Render(strings.Join(lines, "\n"))
}

func (m Model) renderStatusLine() string {
	watcherState := "off"
	if m.watchEnabled {
		watcherState = "on"
	}
	stage := strings.TrimSpace(m.jobPhase)
	if stage == "" {
		if m.indexing {
			stage = "queued"
		} else {
			stage = "idle"
		}
	}
	backendState := "connected"
	if !m.backendOnline {
		backendState = "offline"
	}
	generation := "unknown"
	if m.doctorLoaded {
		generation = fmt.Sprintf("%d", m.doctor.Serving.ActiveGeneration)
	}
	status := strings.Join([]string{
		"watcher: " + watcherState,
		"stage: " + stage,
		"backend: " + backendState,
		"repo: " + truncate(m.root, max(24, m.width/3)),
		"generation: " + generation,
	}, " | ")
	return statusLineStyle.Width(max(0, m.width-2)).Render(status)
}

func (m Model) View() string {
	header := m.renderHeader()
	var body string
	if m.useStackedLayout() {
		sidebar := m.renderSidebarPanel(max(32, m.width-4))
		content := m.renderContentPanel(max(32, m.width-4))
		detail := m.renderDetailPanel(max(36, m.width-4), max(10, m.height/3))
		jobs := m.renderJobsPanel(max(36, m.width-4), max(minJobsHeight, m.height/4))
		body = lipgloss.JoinVertical(lipgloss.Left, sidebar, content, detail, jobs)
	} else {
		jobsHeight := max(minJobsHeight, m.height/4)
		mainHeight := max(16, m.height-jobsHeight-8)
		sidebarWidth := max(minSidebarWidth, m.width/5)
		contentWidth := max(minContentWidth, m.width/3)
		detailWidth := max(minDetailWidth, m.width-sidebarWidth-contentWidth-8)
		top := lipgloss.JoinHorizontal(
			lipgloss.Top,
			m.renderSidebarPanel(sidebarWidth),
			m.renderContentPanel(contentWidth),
			m.renderDetailPanel(detailWidth, mainHeight),
		)
		jobs := m.renderJobsPanel(max(70, m.width-2), jobsHeight)
		body = lipgloss.JoinVertical(lipgloss.Left, top, jobs)
	}
	status := m.renderStatusLine()
	footer := footerStyle.Render("Up/Down move | Tab focus | Enter select/action | i index | r refresh | w watcher | n new hub | q quit")
	if m.wizard.active {
		footer = footerStyle.Render("Wizard: Tab move fields | Enter continue/create | Esc cancel")
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
		fmt.Sprintf("Context+ CLI doctor for %s", report.Root),
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
			"Scheduler: queue depth %d | max %d | batches %d | deduped %d | canceled %d | superseded %d",
			report.Observability.Scheduler.QueueDepth,
			report.Observability.Scheduler.MaxQueueDepth,
			report.Observability.Scheduler.BatchCount,
			report.Observability.Scheduler.DedupedPathEvents,
			report.Observability.Scheduler.CanceledJobs,
			report.Observability.Scheduler.SupersededJobs,
		),
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
	model.refreshOverviewSection()
	model.logs = []string{"Snapshot rendered from live backend data."}
	model.width = 120
	model.height = 38
	model.refreshSidebar()
	model.syncDetailViewport()
	return model.View(), nil
}

func parseLineItems(prefix string, text string) []contentItem {
	lines := splitNonEmptyLines(text)
	items := make([]contentItem, 0, len(lines))
	for index, line := range lines {
		title := strings.TrimSpace(line)
		if title == "" {
			continue
		}
		start := max(0, index-2)
		end := min(len(lines), index+3)
		items = append(items, contentItem{
			ID:      fmt.Sprintf("%s-%d", prefix, index),
			Title:   truncate(title, 88),
			Summary: fmt.Sprintf("Line %d", index+1),
			Detail:  strings.Join(lines[start:end], "\n"),
		})
	}
	return items
}

func parseBlockItems(prefix string, text string) []contentItem {
	blocks := splitBlocks(text)
	items := make([]contentItem, 0, len(blocks))
	for index, block := range blocks {
		lines := splitNonEmptyLines(block)
		if len(lines) == 0 {
			continue
		}
		title := lines[0]
		summary := ""
		if len(lines) > 1 {
			summary = truncate(lines[1], 90)
		}
		items = append(items, contentItem{
			ID:      fmt.Sprintf("%s-%d", prefix, index),
			Title:   truncate(strings.TrimSpace(title), 88),
			Summary: summary,
			Detail:  strings.Join(lines, "\n"),
		})
	}
	return items
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
