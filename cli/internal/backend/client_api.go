// summary: Typed backend command wrappers.
// FEATURE: High-level Go API methods.
// inputs: Repo roots plus command-specific parameters.
// outputs: Typed backend command results.
package backend

import "context"

// Purpose: Run the doctor command and decode the typed report payload.
// Inputs: A context plus the repo root for the command.
// Returns/Effects: Returns the doctor report or a backend error.
func (c *Client) Doctor(ctx context.Context, root string) (DoctorReport, error) {
	return callTyped[DoctorReport](c, ctx, "doctor", map[string]any{"root": root})
}

// Purpose: Run the tree command and decode its text payload.
// Inputs: A context plus the repo root for the command.
// Returns/Effects: Returns the tree payload or a backend error.
func (c *Client) Tree(ctx context.Context, root string) (TextPayload, error) {
	return callTyped[TextPayload](c, ctx, "tree", map[string]any{"root": root})
}

// Purpose: Run the hubs command and decode its text payload.
// Inputs: A context plus the repo root for the command.
// Returns/Effects: Returns the hubs payload or a backend error.
func (c *Client) Hubs(ctx context.Context, root string) (TextPayload, error) {
	return callTyped[TextPayload](c, ctx, "hubs", map[string]any{"root": root})
}

// Purpose: Run the ranked hub search command with an optional ranking mode.
// Inputs: A context, repo root, search query, and optional ranking mode.
// Returns/Effects: Returns the search payload or a backend error.
func (c *Client) FindHub(ctx context.Context, root string, query string, rankingMode string) (TextPayload, error) {
	args := map[string]any{
		"root":  root,
		"query": query,
	}
	if rankingMode != "" {
		args["rankingMode"] = rankingMode
	}
	return callTyped[TextPayload](c, ctx, "find-hub", args)
}

// Purpose: Run the cluster command and decode its text payload.
// Inputs: A context plus the repo root for the command.
// Returns/Effects: Returns the cluster payload or a backend error.
func (c *Client) Cluster(ctx context.Context, root string) (TextPayload, error) {
	return callTyped[TextPayload](c, ctx, "cluster", map[string]any{"root": root})
}

// Purpose: Run the view-clusters command and decode its text payload.
// Inputs: A context plus the repo root for the command.
// Returns/Effects: Returns the cluster view payload or a backend error.
func (c *Client) ViewClusters(ctx context.Context, root string) (TextPayload, error) {
	return callTyped[TextPayload](c, ctx, "view-clusters", map[string]any{"root": root})
}

// Purpose: Refresh clusters using the cluster command path.
// Inputs: A context plus the repo root for the command.
// Returns/Effects: Returns the cluster refresh payload or a backend error.
func (c *Client) ClusterRefresh(ctx context.Context, root string) (TextPayload, error) {
	return c.Cluster(ctx, root)
}

// Purpose: Load the current restore-point list from the backend.
// Inputs: A context plus the repo root for the command.
// Returns/Effects: Returns restore points or a backend error.
func (c *Client) RestorePoints(ctx context.Context, root string) ([]RestorePoint, error) {
	return callTyped[[]RestorePoint](c, ctx, "restore-points", map[string]any{"root": root})
}

// Purpose: Load the repo status summary from the backend.
// Inputs: A context plus the repo root for the command.
// Returns/Effects: Returns repo status or a backend error.
func (c *Client) Status(ctx context.Context, root string) (RepoStatusSummary, error) {
	return callTyped[RepoStatusSummary](c, ctx, "status", map[string]any{"root": root})
}

// Purpose: Load the repo changes summary with optional file and limit filters.
// Inputs: A context, repo root, optional path filter, and optional result limit.
// Returns/Effects: Returns repo changes or a backend error.
func (c *Client) Changes(ctx context.Context, root string, path string, limit int) (RepoChangesSummary, error) {
	args := map[string]any{"root": root}
	if path != "" {
		args["path"] = path
	}
	if limit > 0 {
		args["limit"] = limit
	}
	return callTyped[RepoChangesSummary](c, ctx, "changes", args)
}

// Purpose: Run the mixed search command with the requested ranking parameters.
// Inputs: Search context, repo root, query, intent, search type, and top-k limit.
// Returns/Effects: Returns ranked search results or a backend error.
func (c *Client) Search(
	ctx context.Context,
	root string,
	query string,
	intent string,
	searchType string,
	topK int,
) (SearchResultPayload, error) {
	args := map[string]any{
		"root":       root,
		"query":      query,
		"intent":     intent,
		"searchType": searchType,
	}
	if topK > 0 {
		args["topK"] = topK
	}
	return callTyped[SearchResultPayload](c, ctx, "search", args)
}

// Purpose: Run the exact symbol lookup command.
// Inputs: A context, repo root, symbol query, and optional result limit.
// Returns/Effects: Returns the symbol payload or a backend error.
func (c *Client) Symbol(ctx context.Context, root string, query string, topK int) (TextPayload, error) {
	return c.callQueryPayload(ctx, "symbol", root, query, topK)
}

// Purpose: Run the exact word lookup command.
// Inputs: A context, repo root, word query, and optional result limit.
// Returns/Effects: Returns the word payload or a backend error.
func (c *Client) Word(ctx context.Context, root string, query string, topK int) (TextPayload, error) {
	return c.callQueryPayload(ctx, "word", root, query, topK)
}

// Purpose: Run the outline command for one file path.
// Inputs: A context, repo root, and the target file path.
// Returns/Effects: Returns the outline payload or a backend error.
func (c *Client) Outline(ctx context.Context, root string, filePath string) (TextPayload, error) {
	return callTyped[TextPayload](c, ctx, "outline", map[string]any{
		"root":     root,
		"filePath": filePath,
	})
}

// Purpose: Run the dependency report command for one target path.
// Inputs: A context, repo root, and the dependency target string.
// Returns/Effects: Returns the dependency payload or a backend error.
func (c *Client) Deps(ctx context.Context, root string, target string) (TextPayload, error) {
	return callTyped[TextPayload](c, ctx, "deps", map[string]any{
		"root":   root,
		"target": target,
	})
}

// Purpose: Run the research report command.
// Inputs: A context, repo root, and the natural-language research query.
// Returns/Effects: Returns the research payload or a backend error.
func (c *Client) Research(ctx context.Context, root string, query string) (TextPayload, error) {
	return callTyped[TextPayload](c, ctx, "research", map[string]any{
		"root":  root,
		"query": query,
	})
}

// Purpose: Run the lint command with an optional target path.
// Inputs: A context, repo root, and an optional file or directory target.
// Returns/Effects: Returns the lint payload or a backend error.
func (c *Client) Lint(ctx context.Context, root string, targetPath string) (TextPayload, error) {
	args := map[string]any{"root": root}
	if targetPath != "" {
		args["targetPath"] = targetPath
	}
	return callTyped[TextPayload](c, ctx, "lint", args)
}

// Purpose: Run the blast-radius command with an optional file context.
// Inputs: A context, repo root, symbol name, and optional file context path.
// Returns/Effects: Returns the blast-radius payload or a backend error.
func (c *Client) BlastRadius(ctx context.Context, root string, symbolName string, fileContext string) (TextPayload, error) {
	args := map[string]any{
		"root":       root,
		"symbolName": symbolName,
	}
	if fileContext != "" {
		args["fileContext"] = fileContext
	}
	return callTyped[TextPayload](c, ctx, "blast-radius", args)
}

// Purpose: Run the checkpoint command with replacement file content.
// Inputs: A context, repo root, target file path, and new file content.
// Returns/Effects: Returns the checkpoint payload or a backend error.
func (c *Client) Checkpoint(ctx context.Context, root string, filePath string, newContent string) (TextPayload, error) {
	return callTyped[TextPayload](c, ctx, "checkpoint", map[string]any{
		"root":       root,
		"filePath":   filePath,
		"newContent": newContent,
	})
}

// Purpose: Run the restore command for one restore-point ID.
// Inputs: A context, repo root, and restore-point identifier.
// Returns/Effects: Returns the restore payload or a backend error.
func (c *Client) Restore(ctx context.Context, root string, pointID string) (TextPayload, error) {
	return callTyped[TextPayload](c, ctx, "restore", map[string]any{
		"root":    root,
		"pointId": pointID,
	})
}

// Purpose: Enable or disable the file-watch scheduler state.
// Inputs: A context, repo root, and requested enabled state.
// Returns/Effects: Returns the watch state payload or a backend error.
func (c *Client) SetWatchEnabled(ctx context.Context, root string, enabled bool) (WatchState, error) {
	return callTyped[WatchState](c, ctx, "watch-set", map[string]any{
		"root":    root,
		"enabled": enabled,
	})
}

// Purpose: Run the job-control command with the requested action string.
// Inputs: A context, repo root, and job-control action.
// Returns/Effects: Returns the job-control payload or a backend error.
func (c *Client) ControlJob(ctx context.Context, root string, action string) (JobControlResult, error) {
	return callTyped[JobControlResult](c, ctx, "job-control", map[string]any{
		"root":   root,
		"action": action,
	})
}

// Purpose: Run the index command with the requested mode string.
// Inputs: A context, repo root, and optional index mode.
// Returns/Effects: Returns backend index output text or a backend error.
func (c *Client) Index(ctx context.Context, root string, mode string) (string, error) {
	if mode == "" {
		mode = "full"
	}
	payload, err := callTyped[struct {
		Output string `json:"output"`
	}](c, ctx, "index", map[string]any{
		"root": root,
		"mode": mode,
	})
	return payload.Output, err
}

// Purpose: Run a simple text-query command with an optional top-k override.
// Inputs: Command metadata plus a context, repo root, query, and optional result limit.
// Returns/Effects: Returns the text payload or a backend error.
func (c *Client) callQueryPayload(
	ctx context.Context,
	command string,
	root string,
	query string,
	topK int,
) (TextPayload, error) {
	args := map[string]any{
		"root":  root,
		"query": query,
	}
	if topK > 0 {
		args["topK"] = topK
	}
	return callTyped[TextPayload](c, ctx, command, args)
}

// Purpose: Run one backend command and decode a typed result value.
// Inputs: The client, context, command name, and JSON argument map.
// Returns/Effects: Returns the typed payload or a backend error.
func callTyped[T any](c *Client, ctx context.Context, command string, args map[string]any) (T, error) {
	var payload T
	err := c.call(ctx, command, args, &payload)
	return payload, err
}
