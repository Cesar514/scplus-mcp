//go:build visualprobe

// summary: Renders real terminal snapshots for manual UI inspection during visual debugging.
// FEATURE: build-tagged visual probe for screenshot-driven terminal diagnosis.
// inputs: Environment-configured model dimensions and activity shell state.
// outputs: Printed TUI render bracketed by markers for terminal screenshot capture.
package ui

import (
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"
)

func envInt(key string, fallback int) int {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

func TestVisualProbe(t *testing.T) {
	model := NewModel("/tmp/contextplus", nil)
	model.width = envInt("VISUAL_PROBE_WIDTH", 113)
	model.height = envInt("VISUAL_PROBE_HEIGHT", 27)
	model.commandBar.SetValue(os.Getenv("VISUAL_PROBE_QUERY"))
	model.doctorLoaded = true
	model.doctor.Root = "/tmp/contextplus"
	model.doctor.Serving.ActiveGeneration = envInt("VISUAL_PROBE_GENERATION", 29)
	model.doctor.Serving.ActiveGenerationFreshness = "fresh"

	indexJob := model.job("index")
	indexJob.State = "failed"
	indexJob.Phase = "failed"
	indexJob.Message = "File search refresh blocked for /home/cesar514/Documents/agent_programming/contextplus: TODO_COMPLETED.md: refresh would remove an indexed file without replacement: text index candidate exceeds max embed file size."
	model.lastError = "backend command \"cluster\" failed: cluster requires a valid prepared full index.\nIndex validation: failed."
	model.logs = append(model.logs, "[13:28:38] doctor report refreshed")

	if os.Getenv("VISUAL_PROBE_NO_MARKERS") == "1" {
		fmt.Print(model.View())
		if holdMs := envInt("VISUAL_PROBE_HOLD_MS", 0); holdMs > 0 {
			time.Sleep(time.Duration(holdMs) * time.Millisecond)
		}
		return
	}

	fmt.Println("VIEW-START")
	fmt.Print(model.View())
	fmt.Println()
	fmt.Println("VIEW-END")
}
