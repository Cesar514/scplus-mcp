// Persistent human-CLI bridge client for the Node backend session.
// FEATURE: typed doctor, status, changes, search, watch, and index payloads.
package backend

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
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

type ChangeRange struct {
	OldStart int `json:"oldStart"`
	OldLines int `json:"oldLines"`
	NewStart int `json:"newStart"`
	NewLines int `json:"newLines"`
}

type ChangeEntry struct {
	Path      string        `json:"path"`
	Staged    string        `json:"staged"`
	Unstaged  string        `json:"unstaged"`
	Additions int           `json:"additions"`
	Deletions int           `json:"deletions"`
	Ranges    []ChangeRange `json:"ranges"`
	Patch     string        `json:"patch"`
}

type RepoChangesSummary struct {
	ChangedFiles   int           `json:"changedFiles"`
	StagedFiles    int           `json:"stagedFiles"`
	UnstagedFiles  int           `json:"unstagedFiles"`
	UntrackedFiles int           `json:"untrackedFiles"`
	Files          []ChangeEntry `json:"files"`
}

type SearchSymbolHit struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Line       int    `json:"line"`
	EndLine    int    `json:"endLine"`
	Signature  string `json:"signature"`
	ParentName string `json:"parentName"`
	Header     string `json:"header"`
	ModulePath string `json:"modulePath"`
}

type SearchWordHit struct {
	Kind    string  `json:"kind"`
	Token   string  `json:"token"`
	Path    string  `json:"path"`
	Line    int     `json:"line"`
	Title   string  `json:"title"`
	Snippet string  `json:"snippet"`
	Score   float64 `json:"score"`
}

type SearchRankedHit struct {
	EntityType string  `json:"entityType"`
	Path       string  `json:"path"`
	Title      string  `json:"title"`
	Kind       string  `json:"kind"`
	Line       int     `json:"line"`
	Snippet    string  `json:"snippet"`
	Score      float64 `json:"score"`
}

type SearchResultPayload struct {
	Root            string            `json:"root"`
	FreshnessHeader string            `json:"freshnessHeader"`
	Intent          string            `json:"intent"`
	SearchType      string            `json:"searchType"`
	Query           string            `json:"query"`
	TopK            int               `json:"topK"`
	SymbolHits      []SearchSymbolHit `json:"symbolHits"`
	PathHits        []string          `json:"pathHits"`
	WordHits        []SearchWordHit   `json:"wordHits"`
	Hits            []SearchRankedHit `json:"hits"`
	Text            string            `json:"text"`
}

type IndexValidationIssue struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type IndexValidationReport struct {
	OK                            bool                   `json:"ok"`
	Mode                          string                 `json:"mode"`
	Generation                    int                    `json:"generation"`
	ActiveGeneration              int                    `json:"activeGeneration"`
	PendingGeneration             *int                   `json:"pendingGeneration"`
	LatestGeneration              int                    `json:"latestGeneration"`
	ActiveGenerationValidatedAt   string                 `json:"activeGenerationValidatedAt"`
	ActiveGenerationFreshness     string                 `json:"activeGenerationFreshness"`
	ActiveGenerationBlockedReason string                 `json:"activeGenerationBlockedReason"`
	CheckedAt                     string                 `json:"checkedAt"`
	Issues                        []IndexValidationIssue `json:"issues"`
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
	GeneratedAt string `json:"generatedAt"`
	Root        string `json:"root"`
	Serving     struct {
		ActiveGeneration              int    `json:"activeGeneration"`
		PendingGeneration             *int   `json:"pendingGeneration"`
		LatestGeneration              int    `json:"latestGeneration"`
		ActiveGenerationValidatedAt   string `json:"activeGenerationValidatedAt"`
		ActiveGenerationFreshness     string `json:"activeGenerationFreshness"`
		ActiveGenerationBlockedReason string `json:"activeGenerationBlockedReason"`
	} `json:"serving"`
	RepoStatus      RepoStatusSummary     `json:"repoStatus"`
	IndexValidation IndexValidationReport `json:"indexValidation"`
	HubSummary      struct {
		SuggestionCount   int      `json:"suggestionCount"`
		FeatureGroupCount int      `json:"featureGroupCount"`
		Suggestions       []string `json:"suggestions"`
		FeatureGroups     []string `json:"featureGroups"`
	} `json:"hubSummary"`
	HybridVectors struct {
		Chunk struct {
			Source         string `json:"source"`
			TotalDocuments int    `json:"totalDocuments"`
			VectorCoverage struct {
				State                string   `json:"state"`
				RequestedVectorCount int      `json:"requestedVectorCount"`
				LoadedVectorCount    int      `json:"loadedVectorCount"`
				MissingVectorCount   int      `json:"missingVectorCount"`
				CoverageRatio        float64  `json:"coverageRatio"`
				MissingVectorIDs     []string `json:"missingVectorIds"`
			} `json:"vectorCoverage"`
		} `json:"chunk"`
		Identifier struct {
			Source         string `json:"source"`
			TotalDocuments int    `json:"totalDocuments"`
			VectorCoverage struct {
				State                string   `json:"state"`
				RequestedVectorCount int      `json:"requestedVectorCount"`
				LoadedVectorCount    int      `json:"loadedVectorCount"`
				MissingVectorCount   int      `json:"missingVectorCount"`
				CoverageRatio        float64  `json:"coverageRatio"`
				MissingVectorIDs     []string `json:"missingVectorIds"`
			} `json:"vectorCoverage"`
		} `json:"identifier"`
	} `json:"hybridVectors"`
	TreeSitter struct {
		TotalParseCalls          int `json:"totalParseCalls"`
		TotalParsersCreated      int `json:"totalParsersCreated"`
		TotalParserReuses        int `json:"totalParserReuses"`
		TotalGrammarLoads        int `json:"totalGrammarLoads"`
		TotalGrammarLoadFailures int `json:"totalGrammarLoadFailures"`
		TotalParseFailures       int `json:"totalParseFailures"`
	} `json:"treeSitter"`
	Observability struct {
		Indexing struct {
			LastUpdatedAt string `json:"lastUpdatedAt"`
			ElapsedMs     int    `json:"elapsedMs"`
			Stages        map[string]struct {
				DurationMs      int            `json:"durationMs"`
				PhaseDurations  map[string]int `json:"phaseDurationsMs"`
				ProcessedFiles  *int           `json:"processedFiles"`
				IndexedChunks   *int           `json:"indexedChunks"`
				EmbeddedCount   *int           `json:"embeddedCount"`
				FilesPerSecond  *float64       `json:"filesPerSecond"`
				ChunksPerSecond *float64       `json:"chunksPerSecond"`
				EmbedsPerSecond *float64       `json:"embedsPerSecond"`
			} `json:"stages"`
		} `json:"indexing"`
		Caches struct {
			Embeddings struct {
				ProcessNamespaceHits    int `json:"processNamespaceHits"`
				ProcessNamespaceMisses  int `json:"processNamespaceMisses"`
				ProcessVectorHits       int `json:"processVectorHits"`
				ProcessVectorMisses     int `json:"processVectorMisses"`
				SqliteNamespaceLoads    int `json:"sqliteNamespaceLoads"`
				SqliteEntryLoads        int `json:"sqliteEntryLoads"`
				GenerationInvalidations int `json:"generationInvalidations"`
			} `json:"embeddings"`
			HybridSearch struct {
				Chunk struct {
					SearchCalls               int `json:"searchCalls"`
					LexicalCandidateCount     int `json:"lexicalCandidateCount"`
					RerankCandidateCount      int `json:"rerankCandidateCount"`
					FinalResultCount          int `json:"finalResultCount"`
					LastLexicalCandidateCount int `json:"lastLexicalCandidateCount"`
				} `json:"chunk"`
				Identifier struct {
					SearchCalls               int `json:"searchCalls"`
					LexicalCandidateCount     int `json:"lexicalCandidateCount"`
					RerankCandidateCount      int `json:"rerankCandidateCount"`
					FinalResultCount          int `json:"finalResultCount"`
					LastLexicalCandidateCount int `json:"lastLexicalCandidateCount"`
				} `json:"identifier"`
			} `json:"hybridSearch"`
			ParserPoolReuseCount int `json:"parserPoolReuseCount"`
		} `json:"caches"`
		Integrity struct {
			StaleGenerationAgeMs    *int           `json:"staleGenerationAgeMs"`
			FallbackMarkerCount     int            `json:"fallbackMarkerCount"`
			FallbackFiles           []string       `json:"fallbackFiles"`
			ParseFailuresByLanguage map[string]int `json:"parseFailuresByLanguage"`
			RefreshFailures         struct {
				FileSearch struct {
					RefreshFailures    int `json:"refreshFailures"`
					RefreshFailedFiles int `json:"refreshFailedFiles"`
				} `json:"fileSearch"`
				WriteFreshness struct {
					RefreshFailures int `json:"refreshFailures"`
				} `json:"writeFreshness"`
			} `json:"refreshFailures"`
		} `json:"integrity"`
		Scheduler struct {
			WatchEnabled       bool     `json:"watchEnabled"`
			QueueDepth         int      `json:"queueDepth"`
			MaxQueueDepth      int      `json:"maxQueueDepth"`
			BatchCount         int      `json:"batchCount"`
			DedupedPathEvents  int      `json:"dedupedPathEvents"`
			SupersededJobs     int      `json:"supersededJobs"`
			CanceledJobs       int      `json:"canceledJobs"`
			PendingChangeCount int      `json:"pendingChangeCount"`
			PendingPaths       []string `json:"pendingPaths"`
			PendingJobKind     string   `json:"pendingJobKind"`
			FullRebuildReasons []string `json:"fullRebuildReasons"`
		} `json:"scheduler"`
	} `json:"observability"`
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

type WatchState struct {
	Root    string `json:"root"`
	Enabled bool   `json:"enabled"`
}

type JobControlResult struct {
	Root           string   `json:"root"`
	Action         string   `json:"action"`
	Message        string   `json:"message"`
	QueueDepth     int      `json:"queueDepth"`
	IndexRunning   bool     `json:"indexRunning"`
	Queued         bool     `json:"queued"`
	PendingPaths   []string `json:"pendingPaths"`
	PendingJobKind string   `json:"pendingJobKind"`
	LastWatchBatch []string `json:"lastWatchBatch"`
	LastMode       string   `json:"lastMode"`
}

type Event struct {
	Kind               string   `json:"kind"`
	Root               string   `json:"root"`
	Message            string   `json:"message"`
	Level              string   `json:"level"`
	Job                string   `json:"job"`
	State              string   `json:"state"`
	Mode               string   `json:"mode"`
	Phase              string   `json:"phase"`
	Source             string   `json:"source"`
	ElapsedMs          int      `json:"elapsedMs"`
	Pending            bool     `json:"pending"`
	Enabled            bool     `json:"enabled"`
	ChangedPaths       []string `json:"changedPaths"`
	QueueDepth         int      `json:"queueDepth"`
	RebuildReason      string   `json:"rebuildReason"`
	ProcessedItems     int      `json:"processedItems"`
	TotalItems         int      `json:"totalItems"`
	PercentComplete    int      `json:"percentComplete"`
	CurrentFile        string   `json:"currentFile"`
	PendingChangeCount int      `json:"pendingChangeCount"`
	PendingPaths       []string `json:"pendingPaths"`
	PendingJobKind     string   `json:"pendingJobKind"`
}

type bridgeCallResult struct {
	payload json.RawMessage
	err     error
}

type bridgeResponseFrame struct {
	Type   string          `json:"type"`
	ID     int64           `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

type Client struct {
	nodeBin string
	entry   string

	cmd   *exec.Cmd
	stdin io.WriteCloser

	events chan Event
	done   chan struct{}

	writeMu sync.Mutex
	pending sync.Map

	nextID int64

	closeOnce sync.Once
	stopOnce  sync.Once

	errMu         sync.Mutex
	connectionErr error
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
	client := &Client{
		nodeBin: nodeBin,
		entry:   entry,
		events:  make(chan Event, 256),
		done:    make(chan struct{}),
	}
	if err := client.start(); err != nil {
		return nil, err
	}
	return client, nil
}

func (c *Client) start() error {
	cmd := exec.Command(c.nodeBin, c.entry, "bridge-serve")
	env := append([]string{}, os.Environ()...)
	env = append(env, "NODE_NO_WARNINGS=1")
	cmd.Env = env

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("open backend stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("open backend stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("open backend stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start persistent backend session: %w", err)
	}

	c.cmd = cmd
	c.stdin = stdin

	go c.readStdoutLoop(stdout)
	go c.readStderrLoop(stderr)
	go c.waitLoop()
	return nil
}

func (c *Client) waitLoop() {
	err := c.cmd.Wait()
	if err != nil && !errors.Is(err, os.ErrProcessDone) {
		c.handleDisconnect(fmt.Errorf("persistent backend session exited: %w", err))
	} else {
		c.handleDisconnect(io.EOF)
	}
	close(c.done)
}

func (c *Client) readStdoutLoop(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		var envelope struct {
			Type   string          `json:"type"`
			ID     int64           `json:"id"`
			OK     bool            `json:"ok"`
			Result json.RawMessage `json:"result"`
			Error  string          `json:"error"`
			Kind   string          `json:"kind"`
		}
		if err := json.Unmarshal(line, &envelope); err != nil {
			c.handleDisconnect(fmt.Errorf("decode persistent backend frame: %w", err))
			return
		}
		switch envelope.Type {
		case "response":
			if waiterValue, ok := c.pending.LoadAndDelete(envelope.ID); ok {
				waiter := waiterValue.(chan bridgeCallResult)
				if envelope.OK {
					waiter <- bridgeCallResult{payload: envelope.Result}
				} else {
					waiter <- bridgeCallResult{err: errors.New(envelope.Error)}
				}
			}
		case "event":
			var event Event
			if err := json.Unmarshal(line, &event); err != nil {
				c.handleDisconnect(fmt.Errorf("decode backend event: %w", err))
				return
			}
			c.emitEvent(event)
		default:
			c.handleDisconnect(fmt.Errorf("persistent backend sent unsupported frame type %q", envelope.Type))
			return
		}
	}
	if err := scanner.Err(); err != nil {
		c.handleDisconnect(fmt.Errorf("persistent backend stdout error: %w", err))
	}
}

func (c *Client) readStderrLoop(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 16*1024), 1024*1024)
	for scanner.Scan() {
		c.emitEvent(Event{
			Kind:    "log",
			Level:   "stderr",
			Message: scanner.Text(),
		})
	}
}

func (c *Client) emitEvent(event Event) {
	select {
	case c.events <- event:
	case <-c.done:
	}
}

func (c *Client) handleDisconnect(err error) {
	c.stopOnce.Do(func() {
		c.errMu.Lock()
		c.connectionErr = err
		c.errMu.Unlock()
		c.pending.Range(func(key, value any) bool {
			waiter := value.(chan bridgeCallResult)
			waiter <- bridgeCallResult{err: c.connectionErrorLocked()}
			c.pending.Delete(key)
			return true
		})
		close(c.events)
	})
}

func (c *Client) connectionErrorLocked() error {
	if c.connectionErr == nil {
		return nil
	}
	if errors.Is(c.connectionErr, io.EOF) {
		return errors.New("persistent backend session closed")
	}
	return c.connectionErr
}

func (c *Client) connectionError() error {
	c.errMu.Lock()
	defer c.errMu.Unlock()
	return c.connectionErrorLocked()
}

func (c *Client) Events() <-chan Event {
	return c.events
}

func (c *Client) call(ctx context.Context, command string, args map[string]any, target any) error {
	if err := c.connectionError(); err != nil {
		return err
	}
	id := atomic.AddInt64(&c.nextID, 1)
	waiter := make(chan bridgeCallResult, 1)
	c.pending.Store(id, waiter)

	request := map[string]any{
		"type":    "request",
		"id":      id,
		"command": command,
	}
	if args != nil {
		request["args"] = args
	}
	payload, err := json.Marshal(request)
	if err != nil {
		c.pending.Delete(id)
		return fmt.Errorf("encode backend request %q: %w", command, err)
	}

	c.writeMu.Lock()
	_, writeErr := c.stdin.Write(append(payload, '\n'))
	c.writeMu.Unlock()
	if writeErr != nil {
		c.pending.Delete(id)
		return fmt.Errorf("write backend request %q: %w", command, writeErr)
	}

	select {
	case result := <-waiter:
		if result.err != nil {
			return fmt.Errorf("backend command %q failed: %w", command, result.err)
		}
		if target == nil {
			return nil
		}
		if err := json.Unmarshal(result.payload, target); err != nil {
			return fmt.Errorf("decode backend result for %q: %w", command, err)
		}
		return nil
	case <-ctx.Done():
		c.pending.Delete(id)
		return fmt.Errorf("backend command %q canceled: %w", command, ctx.Err())
	}
}

func (c *Client) Doctor(ctx context.Context, root string) (DoctorReport, error) {
	var report DoctorReport
	err := c.call(ctx, "doctor", map[string]any{"root": root}, &report)
	return report, err
}

func (c *Client) Tree(ctx context.Context, root string) (TextPayload, error) {
	var payload TextPayload
	err := c.call(ctx, "tree", map[string]any{"root": root}, &payload)
	return payload, err
}

func (c *Client) Hubs(ctx context.Context, root string) (TextPayload, error) {
	var payload TextPayload
	err := c.call(ctx, "hubs", map[string]any{"root": root}, &payload)
	return payload, err
}

func (c *Client) FindHub(ctx context.Context, root string, query string, rankingMode string) (TextPayload, error) {
	var payload TextPayload
	args := map[string]any{
		"root":  root,
		"query": query,
	}
	if rankingMode != "" {
		args["rankingMode"] = rankingMode
	}
	err := c.call(ctx, "find-hub", args, &payload)
	return payload, err
}

func (c *Client) Cluster(ctx context.Context, root string) (TextPayload, error) {
	var payload TextPayload
	err := c.call(ctx, "cluster", map[string]any{"root": root}, &payload)
	return payload, err
}

func (c *Client) RestorePoints(ctx context.Context, root string) ([]RestorePoint, error) {
	var points []RestorePoint
	err := c.call(ctx, "restore-points", map[string]any{"root": root}, &points)
	return points, err
}

func (c *Client) Status(ctx context.Context, root string) (RepoStatusSummary, error) {
	var summary RepoStatusSummary
	err := c.call(ctx, "status", map[string]any{"root": root}, &summary)
	return summary, err
}

func (c *Client) Changes(ctx context.Context, root string, path string, limit int) (RepoChangesSummary, error) {
	var summary RepoChangesSummary
	args := map[string]any{"root": root}
	if path != "" {
		args["path"] = path
	}
	if limit > 0 {
		args["limit"] = limit
	}
	err := c.call(ctx, "changes", args, &summary)
	return summary, err
}

func (c *Client) Search(ctx context.Context, root string, query string, intent string, searchType string, topK int) (SearchResultPayload, error) {
	var payload SearchResultPayload
	args := map[string]any{
		"root":       root,
		"query":      query,
		"intent":     intent,
		"searchType": searchType,
	}
	if topK > 0 {
		args["topK"] = topK
	}
	err := c.call(ctx, "search", args, &payload)
	return payload, err
}

func (c *Client) Symbol(ctx context.Context, root string, query string, topK int) (TextPayload, error) {
	var payload TextPayload
	args := map[string]any{
		"root":  root,
		"query": query,
	}
	if topK > 0 {
		args["topK"] = topK
	}
	err := c.call(ctx, "symbol", args, &payload)
	return payload, err
}

func (c *Client) Word(ctx context.Context, root string, query string, topK int) (TextPayload, error) {
	var payload TextPayload
	args := map[string]any{
		"root":  root,
		"query": query,
	}
	if topK > 0 {
		args["topK"] = topK
	}
	err := c.call(ctx, "word", args, &payload)
	return payload, err
}

func (c *Client) Outline(ctx context.Context, root string, filePath string) (TextPayload, error) {
	var payload TextPayload
	err := c.call(ctx, "outline", map[string]any{
		"root":     root,
		"filePath": filePath,
	}, &payload)
	return payload, err
}

func (c *Client) Deps(ctx context.Context, root string, target string) (TextPayload, error) {
	var payload TextPayload
	err := c.call(ctx, "deps", map[string]any{
		"root":   root,
		"target": target,
	}, &payload)
	return payload, err
}

func (c *Client) Research(ctx context.Context, root string, query string) (TextPayload, error) {
	var payload TextPayload
	err := c.call(ctx, "research", map[string]any{
		"root":  root,
		"query": query,
	}, &payload)
	return payload, err
}

func (c *Client) Lint(ctx context.Context, root string, targetPath string) (TextPayload, error) {
	var payload TextPayload
	args := map[string]any{"root": root}
	if targetPath != "" {
		args["targetPath"] = targetPath
	}
	err := c.call(ctx, "lint", args, &payload)
	return payload, err
}

func (c *Client) BlastRadius(ctx context.Context, root string, symbolName string, fileContext string) (TextPayload, error) {
	var payload TextPayload
	args := map[string]any{
		"root":       root,
		"symbolName": symbolName,
	}
	if fileContext != "" {
		args["fileContext"] = fileContext
	}
	err := c.call(ctx, "blast-radius", args, &payload)
	return payload, err
}

func (c *Client) Checkpoint(ctx context.Context, root string, filePath string, newContent string) (TextPayload, error) {
	var payload TextPayload
	err := c.call(ctx, "checkpoint", map[string]any{
		"root":       root,
		"filePath":   filePath,
		"newContent": newContent,
	}, &payload)
	return payload, err
}

func (c *Client) Restore(ctx context.Context, root string, pointID string) (TextPayload, error) {
	var payload TextPayload
	err := c.call(ctx, "restore", map[string]any{
		"root":    root,
		"pointId": pointID,
	}, &payload)
	return payload, err
}

func (c *Client) SetWatchEnabled(ctx context.Context, root string, enabled bool) (WatchState, error) {
	var state WatchState
	err := c.call(ctx, "watch-set", map[string]any{
		"root":    root,
		"enabled": enabled,
	}, &state)
	return state, err
}

func (c *Client) ControlJob(ctx context.Context, root string, action string) (JobControlResult, error) {
	var result JobControlResult
	err := c.call(ctx, "job-control", map[string]any{
		"root":   root,
		"action": action,
	}, &result)
	return result, err
}

func (c *Client) Index(ctx context.Context, root string, mode string) (string, error) {
	if mode == "" {
		mode = "full"
	}
	var payload struct {
		Output string `json:"output"`
	}
	err := c.call(ctx, "index", map[string]any{
		"root": root,
		"mode": mode,
	}, &payload)
	return payload.Output, err
}

func (c *Client) Close() error {
	var closeErr error
	c.closeOnce.Do(func() {
		if c.cmd == nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		var ignored struct{}
		_ = c.call(ctx, "shutdown", nil, &ignored)
		if c.stdin != nil {
			_ = c.stdin.Close()
		}
		select {
		case <-c.done:
		case <-time.After(3 * time.Second):
			if c.cmd.Process != nil {
				_ = c.cmd.Process.Kill()
			}
			<-c.done
		}
		closeErr = c.connectionError()
		if closeErr != nil && closeErr.Error() == "persistent backend session closed" {
			closeErr = nil
		}
	})
	return closeErr
}
