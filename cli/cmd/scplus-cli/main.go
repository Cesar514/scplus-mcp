// summary: Launches the Bubble Tea operator console for the scplus human CLI.
// FEATURE: Go launcher for the persistent scplus operator workflow.
// inputs: Process arguments, terminal capabilities, and backend startup wiring.
// outputs: Configured operator program execution and process exit status.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"scplus-cli/cli/internal/backend"
	"scplus-cli/cli/internal/hubs"
	"scplus-cli/cli/internal/ui"
)

func runInteractive(root string, client *backend.Client) (bool, error) {
	model := ui.NewModel(root, client)
	program := tea.NewProgram(model, tea.WithAltScreen())
	finalModel, err := program.Run()
	if err != nil {
		return false, err
	}
	if result, ok := finalModel.(ui.Model); ok {
		return result.RequestedGlobalShutdown(), nil
	}
	return false, nil
}

func runDoctor(root string, client *backend.Client) error {
	report, err := client.Doctor(context.Background(), root)
	if err != nil {
		return err
	}
	fmt.Println(ui.RenderDoctorPlain(report))
	return nil
}

func runSnapshot(root string, client *backend.Client) error {
	rendered, err := ui.RenderSnapshot(root, client)
	if err != nil {
		return err
	}
	fmt.Println(rendered)
	return nil
}

func runIndex(root string, mode string, client *backend.Client) error {
	output, err := client.Index(context.Background(), root, mode)
	if err != nil {
		return err
	}
	fmt.Print(output)
	return nil
}

func runTree(root string, client *backend.Client) error {
	payload, err := client.Tree(context.Background(), root)
	if err != nil {
		return err
	}
	fmt.Println(payload.Text)
	return nil
}

func runHubs(root string, client *backend.Client) error {
	payload, err := client.Hubs(context.Background(), root)
	if err != nil {
		return err
	}
	fmt.Println(payload.Text)
	return nil
}

func runCluster(root string, client *backend.Client) error {
	payload, err := client.ClusterRefresh(context.Background(), root)
	if err != nil {
		return err
	}
	fmt.Println(payload.Text)
	return nil
}

func runViewClusters(root string, client *backend.Client) error {
	payload, err := client.ViewClusters(context.Background(), root)
	if err != nil {
		return err
	}
	fmt.Println(payload.Text)
	return nil
}

func runRestorePoints(root string, client *backend.Client) error {
	points, err := client.RestorePoints(context.Background(), root)
	if err != nil {
		return err
	}
	if len(points) == 0 {
		fmt.Println("No restore points.")
		return nil
	}
	for _, point := range points {
		fmt.Printf("%s | %d | %s\n", point.ID, point.Timestamp, point.Message)
	}
	return nil
}

func runHubCreate(root string, args []string) error {
	flags := flag.NewFlagSet("hub-create", flag.ContinueOnError)
	title := flags.String("title", "", "Hub title")
	summary := flags.String("summary", "", "Hub summary")
	files := flags.String("files", "", "Comma-separated file list")
	if err := flags.Parse(args); err != nil {
		return err
	}
	path, err := hubs.CreateHub(root, *title, *summary, *files)
	if err != nil {
		return err
	}
	fmt.Printf("Created %s\n", path)
	return nil
}

func parseRoot(subcommand string, args []string) (string, []string, error) {
	root := "."
	remaining := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--root":
			if i+1 >= len(args) {
				return "", nil, fmt.Errorf("--root requires a value")
			}
			root = args[i+1]
			i++
		case strings.HasPrefix(arg, "--root="):
			value := strings.TrimPrefix(arg, "--root=")
			if value == "" {
				return "", nil, fmt.Errorf("--root requires a value")
			}
			root = value
		default:
			remaining = append(remaining, arg)
		}
	}
	return root, remaining, nil
}

func toolRoot() (string, error) {
	executablePath, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Dir(filepath.Dir(executablePath)), nil
}

func isScplusProcessCommand(command string, repoRoot string) bool {
	normalized := strings.TrimSpace(command)
	if normalized == "" {
		return false
	}
	fields := strings.Fields(normalized)
	if len(fields) == 0 {
		return false
	}
	firstFieldBase := filepath.Base(fields[0])
	if fields[0] == "scplus-cli" || firstFieldBase == "scplus-cli" {
		return true
	}
	if fields[0] == "scplus-mcp" || firstFieldBase == "scplus-mcp" {
		return true
	}
	for _, field := range fields[1:] {
		if field == "bridge-serve" {
			return true
		}
	}
	for _, field := range fields {
		base := filepath.Base(field)
		if field == "bridge-serve" {
			return true
		}
		if base == "bridge-serve" {
			return true
		}
	}
	pathPatterns := []string{
		filepath.Join(repoRoot, "build", "scplus-cli"),
		filepath.Join(repoRoot, "build", "cli-launcher.js"),
		filepath.Join(repoRoot, "build", "index.js"),
		filepath.Join(repoRoot, "src", "index.ts"),
	}
	for _, pattern := range pathPatterns {
		if pattern != "" && strings.Contains(normalized, pattern) {
			return true
		}
	}
	return false
}

func findScplusProcessIDs(output string, repoRoot string, selfPID int) []int {
	targets := make([]int, 0)
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil || pid <= 0 || pid == selfPID {
			continue
		}
		command := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), fields[0]))
		if isScplusProcessCommand(command, repoRoot) {
			targets = append(targets, pid)
		}
	}
	return targets
}

func terminateProcessIDs(targets []int) error {
	for _, pid := range targets {
		process, err := os.FindProcess(pid)
		if err != nil {
			return fmt.Errorf("find scplus process %d: %w", pid, err)
		}
		if err := process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
			return fmt.Errorf("terminate scplus process %d: %w", pid, err)
		}
	}
	for _, pid := range targets {
		alive := true
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if err := syscall.Kill(pid, 0); err != nil {
				alive = false
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		if !alive {
			continue
		}
		process, err := os.FindProcess(pid)
		if err != nil {
			return fmt.Errorf("find scplus process %d for kill: %w", pid, err)
		}
		if err := process.Signal(syscall.SIGKILL); err != nil && !errors.Is(err, os.ErrProcessDone) {
			return fmt.Errorf("kill scplus process %d: %w", pid, err)
		}
	}
	return nil
}

func terminateAllScplusProcesses(repoRoot string, selfPID int) error {
	output, err := exec.Command("ps", "-eo", "pid=,args=").Output()
	if err != nil {
		return fmt.Errorf("list scplus processes: %w", err)
	}
	return terminateProcessIDs(findScplusProcessIDs(string(output), repoRoot, selfPID))
}

func main() {
	client, err := backend.Discover()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer func() {
		_ = client.Close()
	}()
	args := os.Args[1:]
	if len(args) == 0 || args[0] == "--root" {
		root, _, parseErr := parseRoot("scplus-cli", args)
		if parseErr != nil {
			fmt.Fprintln(os.Stderr, parseErr)
			os.Exit(1)
		}
		terminateAll, err := runInteractive(root, client)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if terminateAll {
			repoRoot, repoErr := toolRoot()
			if repoErr != nil {
				fmt.Fprintln(os.Stderr, repoErr)
				os.Exit(1)
			}
			if err := terminateAllScplusProcesses(repoRoot, os.Getpid()); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
		}
		return
	}
	subcommand := args[0]
	root, remaining, parseErr := parseRoot(subcommand, args[1:])
	if parseErr != nil {
		fmt.Fprintln(os.Stderr, parseErr)
		os.Exit(1)
	}
	switch subcommand {
	case "doctor":
		err = runDoctor(root, client)
	case "snapshot":
		err = runSnapshot(root, client)
	case "index":
		mode := "auto"
		if len(remaining) > 0 {
			mode = remaining[0]
		}
		err = runIndex(root, mode, client)
	case "tree":
		err = runTree(root, client)
	case "hubs":
		err = runHubs(root, client)
	case "cluster":
		err = runCluster(root, client)
	case "view-clusters":
		err = runViewClusters(root, client)
	case "restore-points":
		err = runRestorePoints(root, client)
	case "hub-create":
		err = runHubCreate(root, remaining)
	default:
		fmt.Fprintf(os.Stderr, "Unsupported subcommand %q\n", subcommand)
		os.Exit(1)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
