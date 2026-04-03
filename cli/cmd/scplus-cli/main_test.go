// summary: Verifies launcher-side global shutdown process matching for scplus commands.
// FEATURE: keeps Ctrl+X process sweeps scoped to scplus-related commands only.
package main

import (
	"os/exec"
	"runtime"
	"testing"
	"time"
)

func TestIsScplusProcessCommandMatchesKnownRuntimeShapes(t *testing.T) {
	repoRoot := "/workspace/scplus-mcp"
	for _, command := range []string{
		repoRoot + "/build/scplus-cli --root /repo",
		"node " + repoRoot + "/build/cli-launcher.js bridge-serve",
		"node " + repoRoot + "/build/index.js",
		"scplus-mcp",
		"scplus-cli",
	} {
		if !isScplusProcessCommand(command, repoRoot) {
			t.Fatalf("expected %q to match scplus runtime process detection", command)
		}
	}
}

func TestIsScplusProcessCommandRejectsUnrelatedCommands(t *testing.T) {
	repoRoot := "/workspace/scplus-mcp"
	for _, command := range []string{
		"node /workspace/other/build/index.js",
		"python worker.py",
		"bash",
		"go test ./cmd/scplus-cli",
		"/tmp/go-build123/scplus-cli.test -test.run TestSomething",
	} {
		if isScplusProcessCommand(command, repoRoot) {
			t.Fatalf("expected %q to stay outside scplus shutdown sweep", command)
		}
	}
}

func TestFindScplusProcessIDsReturnsOnlyMatchingRuntimePIDs(t *testing.T) {
	output := `
  101 scplus-cli --root /repo
  202 node /workspace/scplus-mcp/build/cli-launcher.js bridge-serve
  303 go test ./cmd/scplus-cli
  404 python worker.py
`
	targets := findScplusProcessIDs(output, "/workspace/scplus-mcp", 202)
	if len(targets) != 1 || targets[0] != 101 {
		t.Fatalf("expected only pid 101 after excluding self and non-runtime commands, got %v", targets)
	}
}

func TestTerminateProcessIDsStopsMatchingRuntime(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("process argv0 override test is unix-specific")
	}
	cmd := exec.Command("bash", "-lc", "exec -a scplus-mcp sleep 30")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start fake scplus process: %v", err)
	}
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	if err := terminateProcessIDs([]int{cmd.Process.Pid}); err != nil {
		t.Fatalf("terminate explicit scplus pid: %v", err)
	}

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("expected fake scplus process to exit after global shutdown sweep")
	}
}
