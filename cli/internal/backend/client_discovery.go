// summary: Backend client discovery helpers.
// FEATURE: Persistent Node backend startup.
// inputs: Environment variables plus executable layout.
// outputs: Ready backend client sessions.
package backend

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// Purpose: Discover the backend runtime location and start a client session.
// Inputs: Environment overrides plus the installed executable path.
// Returns/Effects: Returns a ready client or a startup error.
func Discover() (*Client, error) {
	nodeBin, err := resolveNodeBinary()
	if err != nil {
		return nil, err
	}
	entry, err := resolveBackendEntry()
	if err != nil {
		return nil, err
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

// Purpose: Resolve the Node binary used by the Go bridge client.
// Inputs: The SCPLUS_NODE_BIN environment override plus PATH lookup.
// Returns/Effects: Returns the executable name or a lookup error.
func resolveNodeBinary() (string, error) {
	nodeBin := os.Getenv("SCPLUS_NODE_BIN")
	if nodeBin == "" {
		nodeBin = "node"
	}
	if _, err := exec.LookPath(nodeBin); err != nil {
		return "", fmt.Errorf("node runtime is required for the scplus-cli backend: %w", err)
	}
	return nodeBin, nil
}

// Purpose: Resolve the Node entry script for the shared backend session.
// Inputs: The SCPLUS_BACKEND_ENTRY override plus the installed executable path.
// Returns/Effects: Returns the entry script path or a filesystem error.
func resolveBackendEntry() (string, error) {
	entry := os.Getenv("SCPLUS_BACKEND_ENTRY")
	if entry == "" {
		exePath, err := os.Executable()
		if err != nil {
			return "", fmt.Errorf("resolve executable path: %w", err)
		}
		entry = filepath.Join(filepath.Dir(exePath), "index.js")
	}
	info, err := os.Stat(entry)
	if err != nil {
		return "", fmt.Errorf("scplus-mcp backend entrypoint %q is missing: %w", entry, err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("scplus-mcp backend entrypoint %q is a directory", entry)
	}
	return entry, nil
}
