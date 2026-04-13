// summary: Persistent Go bridge client data model.
// FEATURE: Typed backend payloads plus client state.
// inputs: Backend JSON payloads and runtime session state.
// outputs: Shared backend type definitions.
package backend

import (
	"encoding/json"
	"io"
	"os/exec"
	"sync"
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

type HybridVectorCoverage struct {
	State                string   `json:"state"`
	RequestedVectorCount int      `json:"requestedVectorCount"`
	LoadedVectorCount    int      `json:"loadedVectorCount"`
	MissingVectorCount   int      `json:"missingVectorCount"`
	CoverageRatio        float64  `json:"coverageRatio"`
	MissingVectorIDs     []string `json:"missingVectorIds"`
}

type HybridVectorSection struct {
	Source         string               `json:"source"`
	TotalDocuments int                  `json:"totalDocuments"`
	VectorCoverage HybridVectorCoverage `json:"vectorCoverage"`
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
		Chunk      HybridVectorSection `json:"chunk"`
		Identifier HybridVectorSection `json:"identifier"`
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
