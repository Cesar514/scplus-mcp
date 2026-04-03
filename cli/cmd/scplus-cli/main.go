// summary: Launches the Bubble Tea operator console for the Context+ human CLI.
// FEATURE: Go launcher for the persistent Context+ operator workflow.
// inputs: Process arguments, terminal capabilities, and backend startup wiring.
// outputs: Configured operator program execution and process exit status.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"

	"scplus-cli/cli/internal/backend"
	"scplus-cli/cli/internal/hubs"
	"scplus-cli/cli/internal/ui"
	tea "github.com/charmbracelet/bubbletea"
)

func runInteractive(root string, client *backend.Client) error {
	model := ui.NewModel(root, client)
	program := tea.NewProgram(model, tea.WithAltScreen(), tea.WithMouseCellMotion())
	_, err := program.Run()
	return err
}

func runDoctor(root string, client *backend.Client) error {
	report, err := client.Doctor(context.Background(), root)
	if err != nil {
		return err
	}
	fmt.Println(ui.RenderDoctorPlain(report))
	return nil
}

func runSnapshot(root string, client *backend.Client) error {
	rendered, err := ui.RenderSnapshot(root, client)
	if err != nil {
		return err
	}
	fmt.Println(rendered)
	return nil
}

func runIndex(root string, mode string, client *backend.Client) error {
	output, err := client.Index(context.Background(), root, mode)
	if err != nil {
		return err
	}
	fmt.Print(output)
	return nil
}

func runTree(root string, client *backend.Client) error {
	payload, err := client.Tree(context.Background(), root)
	if err != nil {
		return err
	}
	fmt.Println(payload.Text)
	return nil
}

func runHubs(root string, client *backend.Client) error {
	payload, err := client.Hubs(context.Background(), root)
	if err != nil {
		return err
	}
	fmt.Println(payload.Text)
	return nil
}

func runCluster(root string, client *backend.Client) error {
	payload, err := client.Cluster(context.Background(), root)
	if err != nil {
		return err
	}
	fmt.Println(payload.Text)
	return nil
}

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

func parseRoot(subcommand string, args []string) (string, []string, error) {
	root := "."
	remaining := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--root":
			if i+1 >= len(args) {
				return "", nil, fmt.Errorf("--root requires a value")
			}
			root = args[i+1]
			i++
		case strings.HasPrefix(arg, "--root="):
			value := strings.TrimPrefix(arg, "--root=")
			if value == "" {
				return "", nil, fmt.Errorf("--root requires a value")
			}
			root = value
		default:
			remaining = append(remaining, arg)
		}
	}
	return root, remaining, nil
}

func main() {
	client, err := backend.Discover()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer func() {
		_ = client.Close()
	}()
	args := os.Args[1:]
	if len(args) == 0 || args[0] == "--root" {
		root, _, parseErr := parseRoot("scplus-cli", args)
		if parseErr != nil {
			fmt.Fprintln(os.Stderr, parseErr)
			os.Exit(1)
		}
		if err := runInteractive(root, client); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	subcommand := args[0]
	root, remaining, parseErr := parseRoot(subcommand, args[1:])
	if parseErr != nil {
		fmt.Fprintln(os.Stderr, parseErr)
		os.Exit(1)
	}
	switch subcommand {
	case "doctor":
		err = runDoctor(root, client)
	case "snapshot":
		err = runSnapshot(root, client)
	case "index":
		mode := "full"
		if len(remaining) > 0 {
			mode = remaining[0]
		}
		err = runIndex(root, mode, client)
	case "tree":
		err = runTree(root, client)
	case "hubs":
		err = runHubs(root, client)
	case "cluster":
		err = runCluster(root, client)
	case "restore-points":
		err = runRestorePoints(root, client)
	case "hub-create":
		err = runHubCreate(root, remaining)
	default:
		fmt.Fprintf(os.Stderr, "Unsupported subcommand %q\n", subcommand)
		os.Exit(1)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
