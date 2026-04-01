package ui

import (
	"context"
	"errors"
	"fmt"
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
	tabOverview = iota
	tabTree
	tabHubs
	tabRestore
	tabCluster
	tabWizard
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
	titleStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("205"))
	subtitleStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("111"))
	activeTab     = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("229")).Background(lipgloss.Color("62")).Padding(0, 1)
	idleTab       = lipgloss.NewStyle().Foreground(lipgloss.Color("252")).Background(lipgloss.Color("236")).Padding(0, 1)
	cardStyle     = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(lipgloss.Color("63")).Padding(0, 1)
	logStyle      = lipgloss.NewStyle().Border(lipgloss.NormalBorder()).BorderForeground(lipgloss.Color("240")).Padding(0, 1)
	footerStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	errorStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Bold(true)
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

type Model struct {
	root          string
	client        *backend.Client
	width         int
	height        int
	tab           int
	magicianFrame int
	doctor        backend.DoctorReport
	doctorLoaded  bool
	treeText      string
	hubsText      string
	clusterText   string
	restorePoints []backend.RestorePoint
	viewport      viewport.Model
	logs          []string
	lastError     string
	indexing      bool
	watchEnabled  bool
	backendOnline bool
	jobPhase      string
	jobMessage    string
	wizard        wizardState
}

func NewModel(root string, client *backend.Client) Model {
	vp := viewport.New(80, 20)
	model := Model{
		root:          root,
		client:        client,
		width:         110,
		height:        36,
		viewport:      vp,
		logs:          []string{"Context+ CLI started."},
		wizard:        newWizardState(),
		backendOnline: true,
		watchEnabled:  false,
	}
	model.syncViewport()
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
		return textLoadedMsg{kind: "tree", text: payload.Text, err: err}
	}
}

func loadHubsCmd(client *backend.Client, root string) tea.Cmd {
	return func() tea.Msg {
		payload, err := client.Hubs(context.Background(), root)
		return textLoadedMsg{kind: "hubs", text: payload.Text, err: err}
	}
}

func loadClusterCmd(client *backend.Client, root string) tea.Cmd {
	return func() tea.Msg {
		payload, err := client.Cluster(context.Background(), root)
		return textLoadedMsg{kind: "cluster", text: payload.Text, err: err}
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
	if len(m.logs) > 12 {
		m.logs = m.logs[:12]
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

func (m *Model) syncViewport() {
	content := ""
	switch m.tab {
	case tabTree:
		content = m.treeText
	case tabHubs:
		content = m.hubsText
	case tabRestore:
		content = renderRestorePoints(m.restorePoints)
	case tabCluster:
		content = m.clusterText
	default:
		content = ""
	}
	width := m.width - 4
	if width < 40 {
		width = 40
	}
	height := m.height - 12
	if height < 8 {
		height = 8
	}
	m.viewport.Width = width
	m.viewport.Height = height
	m.viewport.SetContent(content)
}

func (m *Model) activateTab(index int) {
	if index < tabOverview || index > tabWizard {
		return
	}
	m.tab = index
	m.syncViewport()
}

func (m *Model) toggleWatcher() tea.Cmd {
	state, err := m.client.SetWatchEnabled(context.Background(), m.root, !m.watchEnabled)
	if err != nil {
		m.setError(err)
		return nil
	}
	m.watchEnabled = state.Enabled
	if state.Enabled {
		m.appendLog("watcher enabled")
	} else {
		m.appendLog("watcher disabled")
	}
	return nil
}

func (m *Model) nextTab(delta int) {
	next := m.tab + delta
	if next < tabOverview {
		next = tabCluster
	}
	if next > tabCluster && !m.wizard.active {
		next = tabOverview
	}
	if m.wizard.active && next > tabWizard {
		next = tabOverview
	}
	m.activateTab(next)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	switch message := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = message.Width
		m.height = message.Height
		m.syncViewport()
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
		m.appendLog("doctor report refreshed")
		return m, nil
	case textLoadedMsg:
		if message.err != nil {
			m.setError(message.err)
			return m, nil
		}
		switch message.kind {
		case "tree":
			m.treeText = message.text
		case "hubs":
			m.hubsText = message.text
		case "cluster":
			m.clusterText = message.text
		}
		m.syncViewport()
		return m, nil
	case restoreLoadedMsg:
		if message.err != nil {
			m.setError(message.err)
			return m, nil
		}
		m.restorePoints = message.points
		m.syncViewport()
		return m, nil
	case indexFinishedMsg:
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
		m.activateTab(tabHubs)
		return m, loadHubsCmd(m.client, m.root)
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
		case "watch-batch":
			if len(message.event.ChangedPaths) > 0 {
				m.appendLog("detected changes: " + strings.Join(message.event.ChangedPaths, ", "))
			}
		case "job":
			m.jobPhase = message.event.Phase
			m.jobMessage = message.event.Message
			m.indexing = message.event.State == "running" || message.event.State == "progress" || message.event.State == "queued"
		}
		return m, waitForBackendEventCmd(m.client.Events())
	case tea.KeyMsg:
		if m.wizard.active {
			return m.updateWizard(message)
		}
		switch message.String() {
		case "ctrl+c", "q":
			return m, tea.Quit
		case "left", "shift+tab":
			m.nextTab(-1)
			return m, nil
		case "right", "tab":
			m.nextTab(1)
			return m, nil
		case "1":
			m.activateTab(tabOverview)
			return m, nil
		case "2":
			m.activateTab(tabTree)
			return m, nil
		case "3":
			m.activateTab(tabHubs)
			return m, nil
		case "4":
			m.activateTab(tabRestore)
			return m, nil
		case "5":
			m.activateTab(tabCluster)
			return m, nil
		case "i":
			if m.indexing {
				m.appendLog("index already running")
				return m, nil
			}
			m.indexing = true
			m.appendLog("manual full index requested")
			return m, runIndexCmd(m.client, m.root)
		case "r":
			m.appendLog("manual refresh requested")
			return m, refreshAllCmd(m.client, m.root)
		case "w":
			return m, m.toggleWatcher()
		case "n":
			m.wizard = newWizardState()
			m.wizard.active = true
			m.activateTab(tabWizard)
			return m, nil
		}
	}
	if m.tab == tabTree || m.tab == tabHubs || m.tab == tabRestore || m.tab == tabCluster {
		m.viewport, cmd = m.viewport.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m Model) updateWizard(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.String() {
	case "esc":
		m.wizard = newWizardState()
		m.wizard.active = false
		m.activateTab(tabOverview)
		return m, nil
	case "shift+tab":
		m.wizard.focus = (m.wizard.focus + len(m.wizard.inputs) - 1) % len(m.wizard.inputs)
	case "tab":
		m.wizard.focus = (m.wizard.focus + 1) % len(m.wizard.inputs)
	case "enter":
		if m.wizard.focus == len(m.wizard.inputs)-1 {
			m.wizard.busy = true
			m.wizard.message = "Creating hub..."
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
			return m, cmd
		}
	}
	return m, nil
}

func renderRestorePoints(points []backend.RestorePoint) string {
	if len(points) == 0 {
		return "No restore points."
	}
	lines := make([]string, 0, len(points)*2)
	for _, point := range points {
		lines = append(lines,
			fmt.Sprintf("%s | %s", point.ID, time.UnixMilli(point.Timestamp).UTC().Format(time.RFC3339)),
			fmt.Sprintf("  %s", point.Message),
			fmt.Sprintf("  files: %s", strings.Join(point.Files, ", ")),
			"",
		)
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func renderTabs(current int) string {
	tabs := []string{"1 Overview", "2 Tree", "3 Hubs", "4 Restore", "5 Cluster", "N New Hub"}
	styles := make([]string, 0, len(tabs))
	for index, label := range tabs {
		if index == current {
			styles = append(styles, activeTab.Render(label))
			continue
		}
		if index == 5 && current != tabWizard {
			styles = append(styles, idleTab.Render(label))
			continue
		}
		styles = append(styles, idleTab.Render(label))
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, styles...)
}

func (m Model) renderOverview() string {
	doctorBody := "loading doctor report..."
	if m.doctorLoaded {
		indexLine := "index not ready"
		if m.doctor.IndexValidation.OK {
			indexLine = "prepared index OK"
		} else {
			indexLine = fmt.Sprintf("index issues %d", len(m.doctor.IndexValidation.Issues))
		}
		ollamaLine := "ollama unavailable"
		if m.doctor.Ollama.OK {
			ollamaLine = fmt.Sprintf("running models %d", len(m.doctor.Ollama.Models))
		} else if m.doctor.Ollama.Error != "" {
			ollamaLine = m.doctor.Ollama.Error
		}
		doctorBody = strings.Join([]string{
			fmt.Sprintf("root %s", m.doctor.Root),
			fmt.Sprintf("branch %s", m.doctor.RepoStatus.Branch),
			fmt.Sprintf("changed %d | untracked %d", m.doctor.RepoStatus.UnstagedCount, m.doctor.RepoStatus.UntrackedCount),
			indexLine,
			fmt.Sprintf("active gen %d | pending %s", m.doctor.Serving.ActiveGeneration, formatOptionalInt(m.doctor.Serving.PendingGeneration)),
			fmt.Sprintf("freshness %s", m.doctor.Serving.ActiveGenerationFreshness),
			fmt.Sprintf("tree-sitter failures %d | parser reuses %d", m.doctor.TreeSitter.TotalParseFailures, m.doctor.TreeSitter.TotalParserReuses),
			ollamaLine,
		}, "\n")
	}
	hubBody := "loading hub summary..."
	if m.doctorLoaded {
		hubBody = strings.Join([]string{
			fmt.Sprintf("suggestions %d", m.doctor.HubSummary.SuggestionCount),
			fmt.Sprintf("feature groups %d", m.doctor.HubSummary.FeatureGroupCount),
			fmt.Sprintf("restore points %d", m.doctor.RestorePointCount),
			fmt.Sprintf("watcher %s", map[bool]string{true: "enabled", false: "disabled"}[m.watchEnabled]),
			fmt.Sprintf("indexing %s", map[bool]string{true: "running", false: "idle"}[m.indexing]),
			fmt.Sprintf("backend %s", map[bool]string{true: "connected", false: "offline"}[m.backendOnline]),
			fmt.Sprintf("phase %s", formatBlankAsNone(m.jobPhase)),
		}, "\n")
	}
	logs := "No activity yet."
	if len(m.logs) > 0 {
		logs = strings.Join(m.logs, "\n")
	}
	magician := lipgloss.NewStyle().Foreground(lipgloss.Color("212")).Render(magicianFrames[m.magicianFrame])
	header := lipgloss.JoinHorizontal(lipgloss.Top,
		magician,
		lipgloss.NewStyle().MarginLeft(2).Render(
			titleStyle.Render("Context+ Human CLI")+"\n"+
				subtitleStyle.Render("Human operator console for the Context+ full engine"),
		),
	)
	cards := lipgloss.JoinHorizontal(lipgloss.Top,
		cardStyle.Width(max(28, m.width/3-4)).Render("Doctor\n\n"+doctorBody),
		cardStyle.Width(max(24, m.width/4-4)).Render("Ops\n\n"+hubBody),
		cardStyle.Width(max(28, m.width/3-4)).Render("Recent Activity\n\n"+logs),
	)
	body := lipgloss.JoinVertical(lipgloss.Left, header, "", cards)
	if m.lastError != "" {
		body += "\n\n" + errorStyle.Render("Last error: "+m.lastError)
	}
	return body
}

func (m Model) renderWizard() string {
	lines := []string{
		titleStyle.Render("Create Human Hub"),
		"",
		"Enter a title, a one-line summary, and a comma-separated file list.",
		"",
	}
	for _, input := range m.wizard.inputs {
		lines = append(lines, input.View())
	}
	if m.wizard.message != "" {
		lines = append(lines, "", subtitleStyle.Render(m.wizard.message))
	}
	return strings.Join(lines, "\n")
}

func (m Model) View() string {
	main := m.renderOverview()
	if m.tab == tabTree || m.tab == tabHubs || m.tab == tabRestore || m.tab == tabCluster {
		main = m.viewport.View()
	}
	if m.tab == tabWizard {
		main = m.renderWizard()
	}
	footer := footerStyle.Render("Arrows/Tab switch views | i index | r refresh | w watcher | n new hub | q quit")
	if m.tab == tabWizard {
		footer = footerStyle.Render("Tab move | Enter next/save | Esc cancel")
	}
	return lipgloss.JoinVertical(
		lipgloss.Left,
		renderTabs(m.tab),
		"",
		main,
		"",
		footer,
	)
}

func (m Model) Close() error {
	return nil
}

func RenderDoctorPlain(report backend.DoctorReport) string {
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
		fmt.Sprintf("Tree-sitter parse failures: %d", report.TreeSitter.TotalParseFailures),
	)
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
	model.logs = []string{"Snapshot rendered from live backend data."}
	model.width = 120
	model.height = 38
	model.syncViewport()
	return model.View(), nil
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
