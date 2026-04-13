// summary: Lightweight CLI error helpers.
// FEATURE: Stable CLI error formatting.
// inputs: Command-specific format strings.
// outputs: Wrapped error values.
package main

import "fmt"

// Purpose: Build a formatted CLI error value.
// Inputs: A format string plus interpolation arguments.
// Returns/Effects: Returns a wrapped error for the caller to print.
func backendErrorf(format string, args ...any) error {
	return fmt.Errorf(format, args...)
}
