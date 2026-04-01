package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type RepoStatusFile struct {
	Path        string `json:"path"`
	Staged      string `json:"staged"`
	Unstaged    string `json:"unstaged"`
	Index       string `json:"index"`
	WorkingTree string `json:"workingTree"`
}

type RepoStatusSummary struct {
	Branch          string           `json:"branch"`
	Ahead           int              `json:"ahead"`
	Behind          int              `json:"behind"`
	StagedCount     int              `json:"stagedCount"`
	UnstagedCount   int              `json:"unstagedCount"`
	UntrackedCount  int              `json:"untrackedCount"`
	ConflictedCount int              `json:"conflictedCount"`
	ModifiedCount   int              `json:"modifiedCount"`
	CreatedCount    int              `json:"createdCount"`
	DeletedCount    int              `json:"deletedCount"`
	RenamedCount    int              `json:"renamedCount"`
	Files           []RepoStatusFile `json:"files"`
}

type IndexValidationIssue struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type IndexValidationReport struct {
	OK        bool                   `json:"ok"`
	Mode      string                 `json:"mode"`
	CheckedAt string                 `json:"checkedAt"`
	Issues    []IndexValidationIssue `json:"issues"`
}

type OllamaRuntimeModel struct {
	Name      string `json:"name"`
	ID        string `json:"id"`
	Size      string `json:"size"`
	Processor string `json:"processor"`
	Until     string `json:"until"`
}

type OllamaRuntimeStatus struct {
	OK     bool                 `json:"ok"`
	Models []OllamaRuntimeModel `json:"models"`
	Error  string               `json:"error"`
}

type DoctorReport struct {
	GeneratedAt     string                `json:"generatedAt"`
	Root            string                `json:"root"`
	RepoStatus      RepoStatusSummary     `json:"repoStatus"`
	IndexValidation IndexValidationReport `json:"indexValidation"`
	HubSummary      struct {
		SuggestionCount   int      `json:"suggestionCount"`
		FeatureGroupCount int      `json:"featureGroupCount"`
		Suggestions       []string `json:"suggestions"`
		FeatureGroups     []string `json:"featureGroups"`
	} `json:"hubSummary"`
	RestorePointCount int                 `json:"restorePointCount"`
	Ollama            OllamaRuntimeStatus `json:"ollama"`
}

type TextPayload struct {
	Root string `json:"root"`
	Text string `json:"text"`
}

type RestorePoint struct {
	ID        string   `json:"id"`
	Timestamp int64    `json:"timestamp"`
	Files     []string `json:"files"`
	Message   string   `json:"message"`
}

type Client struct {
	nodeBin string
	entry   string
}

func Discover() (*Client, error) {
	nodeBin := os.Getenv("CONTEXTPLUS_NODE_BIN")
	if nodeBin == "" {
		nodeBin = "node"
	}
	if _, err := exec.LookPath(nodeBin); err != nil {
		return nil, fmt.Errorf("node runtime is required for the Context+ CLI backend: %w", err)
	}
	entry := os.Getenv("CONTEXTPLUS_BACKEND_ENTRY")
	if entry == "" {
		exePath, err := os.Executable()
		if err != nil {
			return nil, fmt.Errorf("resolve executable path: %w", err)
		}
		entry = filepath.Join(filepath.Dir(exePath), "index.js")
	}
	info, err := os.Stat(entry)
	if err != nil {
		return nil, fmt.Errorf("Context+ backend entrypoint %q is missing: %w", entry, err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("Context+ backend entrypoint %q is a directory", entry)
	}
	return &Client{nodeBin: nodeBin, entry: entry}, nil
}

func (c *Client) commandContext(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, c.nodeBin, append([]string{c.entry}, args...)...)
	env := append([]string{}, os.Environ()...)
	env = append(env, "NODE_NO_WARNINGS=1")
	cmd.Env = env
	return cmd
}

func (c *Client) run(ctx context.Context, args ...string) (string, string, error) {
	cmd := c.commandContext(ctx, args...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	stdoutText := stdout.String()
	stderrText := stderr.String()
	if err != nil {
		return stdoutText, stderrText, fmt.Errorf("backend command %q failed: %w\n%s", strings.Join(args, " "), err, strings.TrimSpace(stderrText))
	}
	return stdoutText, stderrText, nil
}

func (c *Client) decodeJSON(ctx context.Context, target any, args ...string) error {
	stdoutText, stderrText, err := c.run(ctx, args...)
	if err != nil {
		return err
	}
	if decodeErr := json.Unmarshal([]byte(stdoutText), target); decodeErr != nil {
		return fmt.Errorf("decode backend json for %q: %w\nstdout: %s\nstderr: %s", strings.Join(args, " "), decodeErr, stdoutText, stderrText)
	}
	return nil
}

func (c *Client) Doctor(ctx context.Context, root string) (DoctorReport, error) {
	var report DoctorReport
	err := c.decodeJSON(ctx, &report, "bridge", "doctor", "--root", root)
	return report, err
}

func (c *Client) Tree(ctx context.Context, root string) (TextPayload, error) {
	var payload TextPayload
	err := c.decodeJSON(ctx, &payload, "bridge", "tree", "--root", root)
	return payload, err
}

func (c *Client) Hubs(ctx context.Context, root string) (TextPayload, error) {
	var payload TextPayload
	err := c.decodeJSON(ctx, &payload, "bridge", "hubs", "--root", root)
	return payload, err
}

func (c *Client) Cluster(ctx context.Context, root string) (TextPayload, error) {
	var payload TextPayload
	err := c.decodeJSON(ctx, &payload, "bridge", "cluster", "--root", root)
	return payload, err
}

func (c *Client) RestorePoints(ctx context.Context, root string) ([]RestorePoint, error) {
	var points []RestorePoint
	err := c.decodeJSON(ctx, &points, "bridge", "restore-points", "--root", root)
	return points, err
}

func (c *Client) Index(ctx context.Context, root string, mode string) (string, error) {
	if mode == "" {
		mode = "full"
	}
	stdoutText, _, err := c.run(ctx, "index", root, "--mode", mode)
	return stdoutText, err
}
