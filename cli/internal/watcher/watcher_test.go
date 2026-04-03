// summary: Verifies watcher batching and repeated shutdown behavior for the Go CLI.
// FEATURE: Verifies repeated watcher close calls stay safe after live activity.
// inputs: Test watcher activity, synthetic filesystem writes, and shutdown sequences.
// outputs: Regression coverage for safe close behavior and emitted watch batches.

package watcher

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestServiceCloseIsIdempotent(t *testing.T) {
	root := t.TempDir()
	service, err := New(root, 25*time.Millisecond)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	if err := service.Close(); err != nil {
		t.Fatalf("first Close returned error: %v", err)
	}
	if err := service.Close(); err != nil {
		t.Fatalf("second Close returned error: %v", err)
	}
}

func TestServiceCloseIsIdempotentAfterWatchActivity(t *testing.T) {
	root := t.TempDir()
	service, err := New(root, 25*time.Millisecond)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	filePath := filepath.Join(root, "demo.ts")
	if err := os.WriteFile(filePath, []byte("export const value = 1;\n"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	select {
	case event := <-service.Events():
		if event.Err != nil {
			t.Fatalf("watcher reported error: %v", event.Err)
		}
		if len(event.Paths) != 1 || event.Paths[0] != "demo.ts" {
			t.Fatalf("unexpected paths: %#v", event.Paths)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for watcher batch event")
	}

	if err := service.Close(); err != nil {
		t.Fatalf("first Close returned error after activity: %v", err)
	}
	if err := service.Close(); err != nil {
		t.Fatalf("second Close returned error after activity: %v", err)
	}
}
