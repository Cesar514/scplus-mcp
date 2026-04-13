// summary: Interactive console flow helpers.
// FEATURE: Bubble Tea operator program lifecycle.
// inputs: Repo root plus backend client session.
// outputs: Interactive shutdown decisions.
package main

import (
	"context"
	"flag"
	"fmt"

	tea "github.com/charmbracelet/bubbletea"
	"scplus-cli/cli/internal/backend"
	"scplus-cli/cli/internal/hubs"
	"scplus-cli/cli/internal/ui"
)

// Purpose: Start the Bubble Tea operator UI and read the shutdown request state.
// Inputs: Repo root plus the shared backend client.
// Returns/Effects: Returns whether global shutdown was requested and any UI error.
func runInteractive(root string, client *backend.Client) (bool, error) {
	model := ui.NewModel(root, client)
	program := tea.NewProgram(model, tea.WithAltScreen())
	finalModel, err := program.Run()
	if err != nil {
		return false, err
	}
	result, ok := finalModel.(ui.Model)
	if !ok {
		return false, nil
	}
	return result.RequestedGlobalShutdown(), nil
}

// Purpose: Run the plain doctor command output path.
// Inputs: Repo root plus the shared backend client.
// Returns/Effects: Prints doctor output or returns a backend error.
func runDoctor(root string, client *backend.Client) error {
	report, err := client.Doctor(context.Background(), root)
	if err != nil {
		return err
	}
	fmt.Println(ui.RenderDoctorPlain(report))
	return nil
}

// Purpose: Run the snapshot renderer for the requested repo root.
// Inputs: Repo root plus the shared backend client.
// Returns/Effects: Prints the snapshot or returns a rendering error.
func runSnapshot(root string, client *backend.Client) error {
	rendered, err := ui.RenderSnapshot(root, client)
	if err != nil {
		return err
	}
	fmt.Println(rendered)
	return nil
}

// Purpose: Trigger indexing and print the backend output.
// Inputs: Repo root, requested mode, and the shared backend client.
// Returns/Effects: Prints index output or returns a backend error.
func runIndex(root string, mode string, client *backend.Client) error {
	output, err := client.Index(context.Background(), root, mode)
	if err != nil {
		return err
	}
	fmt.Print(output)
	return nil
}

// Purpose: Print the tree command payload text.
// Inputs: Repo root plus the shared backend client.
// Returns/Effects: Prints tree output or returns a backend error.
func runTree(root string, client *backend.Client) error {
	payload, err := client.Tree(context.Background(), root)
	if err != nil {
		return err
	}
	fmt.Println(payload.Text)
	return nil
}

// Purpose: Print the hubs command payload text.
// Inputs: Repo root plus the shared backend client.
// Returns/Effects: Prints hub output or returns a backend error.
func runHubs(root string, client *backend.Client) error {
	payload, err := client.Hubs(context.Background(), root)
	if err != nil {
		return err
	}
	fmt.Println(payload.Text)
	return nil
}

// Purpose: Refresh clusters and print the backend payload text.
// Inputs: Repo root plus the shared backend client.
// Returns/Effects: Prints cluster output or returns a backend error.
func runCluster(root string, client *backend.Client) error {
	payload, err := client.ClusterRefresh(context.Background(), root)
	if err != nil {
		return err
	}
	fmt.Println(payload.Text)
	return nil
}

// Purpose: Print the existing clusters view.
// Inputs: Repo root plus the shared backend client.
// Returns/Effects: Prints cluster view output or returns a backend error.
func runViewClusters(root string, client *backend.Client) error {
	payload, err := client.ViewClusters(context.Background(), root)
	if err != nil {
		return err
	}
	fmt.Println(payload.Text)
	return nil
}

// Purpose: Print the restore-point list in a stable text format.
// Inputs: Repo root plus the shared backend client.
// Returns/Effects: Prints restore points or returns a backend error.
func runRestorePoints(root string, client *backend.Client) error {
	points, err := client.RestorePoints(context.Background(), root)
	if err != nil {
		return err
	}
	if len(points) == 0 {
		fmt.Println("No restore points.")
		return nil
	}
	for _, point := range points {
		fmt.Printf("%s | %d | %s\n", point.ID, point.Timestamp, point.Message)
	}
	return nil
}

// Purpose: Create a new hub file from CLI flags.
// Inputs: Repo root plus raw subcommand arguments.
// Returns/Effects: Creates the hub and prints its path or returns an error.
func runHubCreate(root string, args []string) error {
	flags := flag.NewFlagSet("hub-create", flag.ContinueOnError)
	title := flags.String("title", "", "Hub title")
	summary := flags.String("summary", "", "Hub summary")
	files := flags.String("files", "", "Comma-separated file list")
	if err := flags.Parse(args); err != nil {
		return err
	}
	path, err := hubs.CreateHub(root, *title, *summary, *files)
	if err != nil {
		return err
	}
	fmt.Printf("Created %s\n", path)
	return nil
}
