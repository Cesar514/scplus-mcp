// summary: Bubble Tea operator console entrypoint.
// FEATURE: Go launcher entry surface.
// inputs: Process arguments plus backend wiring.
// outputs: CLI exit status.
package main

import (
	"fmt"
	"os"

	"scplus-cli/cli/internal/backend"
)

// Purpose: Print a fatal CLI error to stderr.
// Inputs: A non-nil command or startup error.
// Returns/Effects: Writes the error message and terminates the process.
func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

// Purpose: Start the CLI runtime and execute the requested operator flow.
// Inputs: Process arguments plus the discovered backend session.
// Returns/Effects: Exits with the command status after cleaning up the backend.
func main() {
	client, err := backend.Discover()
	if err != nil {
		fail(err)
	}
	defer func() {
		_ = client.Close()
	}()
	if err := runCLI(client, os.Args[1:]); err != nil {
		fail(err)
	}
}
