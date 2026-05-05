// summary: Process discovery and shutdown helpers.
// FEATURE: Runtime cleanup for scplus operator processes.
// inputs: CLI arguments, repo root, process listings.
// outputs: Parsed roots plus process termination actions.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"scplus-cli/cli/internal/backend"
)

const processExitWait = 2 * time.Second
const processPollInterval = 50 * time.Millisecond

// Purpose: Parse the shared --root flag from a CLI argument slice.
// Inputs: Raw arguments after the command name.
// Returns/Effects: Returns the resolved root, remaining args, and parse errors.
func parseRoot(args []string) (string, []string, error) {
	root := "."
	remaining := make([]string, 0, len(args))
	for index := 0; index < len(args); index += 1 {
		arg := args[index]
		if arg == "--root" {
			if index+1 >= len(args) {
				return "", nil, fmt.Errorf("--root requires a value")
			}
			root = args[index+1]
			index += 1
			continue
		}
		if strings.HasPrefix(arg, "--root=") {
			value := strings.TrimPrefix(arg, "--root=")
			if value == "" {
				return "", nil, fmt.Errorf("--root requires a value")
			}
			root = value
			continue
		}
		remaining = append(remaining, arg)
	}
	return root, remaining, nil
}

// Purpose: Resolve the installed tool root from the running executable path.
// Inputs: The current executable location from the OS.
// Returns/Effects: Returns the parent tool directory or an OS error.
func toolRoot() (string, error) {
	executablePath, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Dir(filepath.Dir(executablePath)), nil
}

// Purpose: Decide whether one process argument looks like a scplus runtime marker.
// Inputs: One process field plus the repo root path.
// Returns/Effects: Returns true when the field matches a known runtime command shape.
func matchesScplusProcessField(field string, repoRoot string) bool {
	if field == "bridge-serve" {
		return true
	}
	if field == "scplus-cli" {
		return true
	}
	if field == "scplus-mcp" {
		return true
	}
	if repoRoot == "" {
		return false
	}
	pathPatterns := []string{
		filepath.Join(repoRoot, "build", "scplus-cli"),
		filepath.Join(repoRoot, "build", "cli-launcher.js"),
		filepath.Join(repoRoot, "build", "index.js"),
		filepath.Join(repoRoot, "src", "index.ts"),
	}
	for _, pattern := range pathPatterns {
		if strings.Contains(field, pattern) {
			return true
		}
	}
	return false
}

// Purpose: Detect whether a full command line belongs to the scplus runtime.
// Inputs: A raw process command string plus the repo root path.
// Returns/Effects: Returns true when any command field matches a known runtime marker.
func isScplusProcessCommand(command string, repoRoot string) bool {
	normalized := strings.TrimSpace(command)
	if normalized == "" {
		return false
	}
	for _, field := range strings.Fields(normalized) {
		if matchesScplusProcessField(field, repoRoot) {
			return true
		}
	}
	return false
}

// Purpose: Extract matching process IDs from ps output lines.
// Inputs: Raw ps output, repo root, and the current process ID.
// Returns/Effects: Returns scplus process IDs excluding the current process.
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

// Purpose: Send one signal to a process while tolerating already-exited targets.
// Inputs: A process ID, desired signal, and error action label.
// Returns/Effects: Signals the process or returns a wrapped failure.
func signalProcess(pid int, signal syscall.Signal, action string) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return fmt.Errorf("find scplus process %d: %w", pid, err)
	}
	if err := process.Signal(signal); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return fmt.Errorf("%s scplus process %d: %w", action, pid, err)
	}
	return nil
}

// Purpose: Wait briefly for a process to exit after SIGTERM.
// Inputs: A process ID to poll via kill(0).
// Returns/Effects: Returns true when the process still appears alive at timeout.
func processStillRunning(pid int) bool {
	deadline := time.Now().Add(processExitWait)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err != nil {
			return false
		}
		time.Sleep(processPollInterval)
	}
	return true
}

// Purpose: Terminate a list of matching scplus process IDs.
// Inputs: Process IDs discovered from the system process table.
// Returns/Effects: Sends SIGTERM first, then SIGKILL when a process stays alive.
func terminateProcessIDs(targets []int) error {
	for _, pid := range targets {
		if err := signalProcess(pid, syscall.SIGTERM, "terminate"); err != nil {
			return err
		}
	}
	for _, pid := range targets {
		if !processStillRunning(pid) {
			continue
		}
		if err := signalProcess(pid, syscall.SIGKILL, "kill"); err != nil {
			return err
		}
	}
	return nil
}

// Purpose: Discover and terminate all scplus processes for this repo install.
// Inputs: Repo root plus the current process ID.
// Returns/Effects: Reads the process table and terminates matching scplus runtimes.
func terminateAllScplusProcesses(repoRoot string, selfPID int) error {
	output, err := exec.Command("ps", "-eo", "pid=,args=").Output()
	if err != nil {
		return fmt.Errorf("list scplus processes: %w", err)
	}
	return terminateProcessIDs(findScplusProcessIDs(string(output), repoRoot, selfPID))
}

// Purpose: Execute the interactive operator flow when no subcommand was provided.
// Inputs: Parsed repo root plus the shared backend client.
// Returns/Effects: Runs the UI and optionally terminates sibling scplus processes.
func runInteractiveCLI(root string, client *backend.Client) error {
	terminateAll, err := runInteractive(root, client)
	if err != nil {
		return err
	}
	if !terminateAll {
		return nil
	}
	repoRoot, err := toolRoot()
	if err != nil {
		return err
	}
	return terminateAllScplusProcesses(repoRoot, os.Getpid())
}

// Purpose: Execute the requested CLI command path from parsed process arguments.
// Inputs: The shared backend client plus raw process arguments.
// Returns/Effects: Runs interactive mode or one subcommand and returns command errors.
func runCLI(client *backend.Client, args []string) error {
	root, remaining, err := parseRoot(args)
	if err != nil {
		return err
	}
	if len(remaining) == 0 {
		return runInteractiveCLI(root, client)
	}
	return dispatchSubcommand(root, remaining[0], remaining[1:], client)
}
