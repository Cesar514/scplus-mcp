// Hub creation tests for the Go operator workflow support.
// FEATURE: Go hub authoring validation for operator-driven feature maps.
package hubs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateHubWritesMarkdown(t *testing.T) {
	root := t.TempDir()
	sourceDir := filepath.Join(root, "src")
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatalf("mkdir source: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, "app.ts"), []byte("export const ready = true;\n"), 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}
	relativePath, err := CreateHub(root, "Main Flow", "Primary operator workflow", "src/app.ts")
	if err != nil {
		t.Fatalf("create hub: %v", err)
	}
	if relativePath != ".contextplus/hubs/main-flow.md" {
		t.Fatalf("unexpected hub path %q", relativePath)
	}
	content, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relativePath)))
	if err != nil {
		t.Fatalf("read hub: %v", err)
	}
	rendered := string(content)
	if !strings.Contains(rendered, "# Main Flow") {
		t.Fatalf("missing title in hub markdown: %s", rendered)
	}
	if !strings.Contains(rendered, "[[src/app.ts]]") {
		t.Fatalf("missing wikilink in hub markdown: %s", rendered)
	}
}
