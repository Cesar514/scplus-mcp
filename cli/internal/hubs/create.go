// summary: Provides Go-side helpers for creating feature hubs from the operator workflow.
// FEATURE: Go hub authoring support for operator-driven feature maps.
// inputs: Requested hub metadata, filesystem paths, and operator form values.
// outputs: Materialized hub files and validation errors for authoring flows.
package hubs

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func slugify(value string) string {
	sanitized := strings.ToLower(strings.TrimSpace(value))
	sanitized = strings.ReplaceAll(sanitized, "_", "-")
	var out strings.Builder
	lastDash := false
	for _, char := range sanitized {
		isAlphaNum := char >= 'a' && char <= 'z' || char >= '0' && char <= '9'
		if isAlphaNum {
			out.WriteRune(char)
			lastDash = false
			continue
		}
		if !lastDash {
			out.WriteRune('-')
			lastDash = true
		}
	}
	slug := strings.Trim(out.String(), "-")
	if slug == "" {
		return "hub"
	}
	return slug
}

func normalizeFiles(root string, raw string) ([]string, error) {
	parts := strings.FieldsFunc(raw, func(char rune) bool {
		return char == ',' || char == '\n'
	})
	files := make([]string, 0, len(parts))
	seen := map[string]struct{}{}
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		clean := filepath.Clean(trimmed)
		if filepath.IsAbs(clean) {
			return nil, fmt.Errorf("hub file %q must be relative to the repository root", trimmed)
		}
		fullPath := filepath.Join(root, clean)
		info, err := os.Stat(fullPath)
		if err != nil {
			return nil, fmt.Errorf("hub file %q is missing: %w", clean, err)
		}
		if info.IsDir() {
			return nil, fmt.Errorf("hub file %q is a directory, not a source file", clean)
		}
		rel := filepath.ToSlash(clean)
		if _, ok := seen[rel]; ok {
			continue
		}
		seen[rel] = struct{}{}
		files = append(files, rel)
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("at least one existing repository file is required to create a hub")
	}
	return files, nil
}

func BuildHubMarkdown(title, summary string, files []string) string {
	lines := []string{
		fmt.Sprintf("# %s", strings.TrimSpace(title)),
		"",
		strings.TrimSpace(summary),
		"",
		"Human-authored hub created from the scplus-cli.",
		"",
	}
	for _, filePath := range files {
		lines = append(lines, "- [["+filePath+"]]")
	}
	lines = append(lines, "")
	return strings.Join(lines, "\n")
}

func CreateHub(root, title, summary, rawFiles string) (string, error) {
	if strings.TrimSpace(title) == "" {
		return "", fmt.Errorf("hub title is required")
	}
	if strings.TrimSpace(summary) == "" {
		return "", fmt.Errorf("hub summary is required")
	}
	files, err := normalizeFiles(root, rawFiles)
	if err != nil {
		return "", err
	}
	targetDir := filepath.Join(root, ".scplus", "hubs")
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return "", fmt.Errorf("create hub directory: %w", err)
	}
	targetPath := filepath.Join(targetDir, slugify(title)+".md")
	if _, err := os.Stat(targetPath); err == nil {
		return "", fmt.Errorf("hub %q already exists", filepath.Base(targetPath))
	}
	if writeErr := os.WriteFile(targetPath, []byte(BuildHubMarkdown(title, summary, files)), 0o644); writeErr != nil {
		return "", fmt.Errorf("write hub file: %w", writeErr)
	}
	return filepath.ToSlash(strings.TrimPrefix(targetPath, root+"/")), nil
}
