// CLI root parsing tests for the Go operator entrypoint.
// FEATURE: Go launcher argument validation for operator startup behavior.
package main

import "testing"

func TestParseRootLeavesSubcommandFlags(t *testing.T) {
	root, remaining, err := parseRoot("hub-create", []string{"--root", "/tmp/demo", "--title", "Hub", "--files", "README.md"})
	if err != nil {
		t.Fatalf("parseRoot returned error: %v", err)
	}
	if root != "/tmp/demo" {
		t.Fatalf("expected root /tmp/demo, got %q", root)
	}
	if len(remaining) != 4 {
		t.Fatalf("expected 4 remaining args, got %d", len(remaining))
	}
	if remaining[0] != "--title" || remaining[1] != "Hub" || remaining[2] != "--files" || remaining[3] != "README.md" {
		t.Fatalf("unexpected remaining args: %#v", remaining)
	}
}

func TestParseRootSupportsEqualsSyntax(t *testing.T) {
	root, remaining, err := parseRoot("doctor", []string{"--root=/tmp/demo"})
	if err != nil {
		t.Fatalf("parseRoot returned error: %v", err)
	}
	if root != "/tmp/demo" {
		t.Fatalf("expected root /tmp/demo, got %q", root)
	}
	if len(remaining) != 0 {
		t.Fatalf("expected no remaining args, got %#v", remaining)
	}
}
