// summary: Subcommand dispatch helpers.
// FEATURE: Non-interactive CLI command routing.
// inputs: Repo root, command name, backend client.
// outputs: Routed command execution.
package main

import "scplus-cli/cli/internal/backend"

// Purpose: Select the requested index mode from the remaining CLI args.
// Inputs: Subcommand arguments after the command name.
// Returns/Effects: Returns the explicit mode or the default auto mode.
func resolveIndexMode(args []string) string {
	if len(args) == 0 {
		return "auto"
	}
	return args[0]
}

// Purpose: Route one non-interactive subcommand to its implementation.
// Inputs: Repo root, subcommand name, remaining args, and backend client.
// Returns/Effects: Executes the requested subcommand or returns an unsupported-command error.
func dispatchSubcommand(root string, subcommand string, args []string, client *backend.Client) error {
	switch subcommand {
	case "doctor":
		return runDoctor(root, client)
	case "snapshot":
		return runSnapshot(root, client)
	case "index":
		return runIndex(root, resolveIndexMode(args), client)
	case "tree":
		return runTree(root, client)
	case "hubs":
		return runHubs(root, client)
	case "cluster":
		return runCluster(root, client)
	case "view-clusters":
		return runViewClusters(root, client)
	case "restore-points":
		return runRestorePoints(root, client)
	case "hub-create":
		return runHubCreate(root, args)
	default:
		return unsupportedSubcommandError(subcommand)
	}
}

// Purpose: Build the unsupported-subcommand error text.
// Inputs: The unrecognized command name from the CLI.
// Returns/Effects: Returns the stable unsupported-command error string.
func unsupportedSubcommandError(subcommand string) error {
	return backendErrorf("Unsupported subcommand %q", subcommand)
}

