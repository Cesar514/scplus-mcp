// Fsnotify-backed local watcher service for batched filesystem updates.
// FEATURE: Debounced watcher batches with idempotent repeated shutdown.

package watcher

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

type BatchEvent struct {
	Paths      []string
	OccurredAt time.Time
	Err        error
}

type Service struct {
	root      string
	debounce  time.Duration
	watcher   *fsnotify.Watcher
	events    chan BatchEvent
	stop      chan struct{}
	closeOnce sync.Once
	closeErr  error
}

var ignoredPrefixes = []string{
	".contextplus",
	".git",
	".pixi",
	"build",
	"landing/.next",
	"node_modules",
}

func New(root string, debounce time.Duration) (*Service, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("create watcher: %w", err)
	}
	service := &Service{
		root:     root,
		debounce: debounce,
		watcher:  w,
		events:   make(chan BatchEvent),
		stop:     make(chan struct{}),
	}
	if err := service.addRecursive(root); err != nil {
		_ = w.Close()
		return nil, err
	}
	go service.loop()
	return service, nil
}

func (s *Service) Events() <-chan BatchEvent {
	return s.events
}

func (s *Service) Close() error {
	s.closeOnce.Do(func() {
		close(s.stop)
		s.closeErr = s.watcher.Close()
	})
	return s.closeErr
}

func (s *Service) addRecursive(root string) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(s.root, path)
		if err != nil {
			return err
		}
		if rel != "." && shouldIgnore(rel) {
			return filepath.SkipDir
		}
		if addErr := s.watcher.Add(path); addErr != nil {
			return fmt.Errorf("watch %q: %w", path, addErr)
		}
		return nil
	})
}

func shouldIgnore(relative string) bool {
	normalized := filepath.ToSlash(relative)
	for _, prefix := range ignoredPrefixes {
		if normalized == prefix || strings.HasPrefix(normalized, prefix+"/") {
			return true
		}
	}
	return false
}

func (s *Service) loop() {
	var pending map[string]struct{}
	var timer *time.Timer
	var timerCh <-chan time.Time
	flush := func() {
		if len(pending) == 0 {
			return
		}
		paths := make([]string, 0, len(pending))
		for path := range pending {
			paths = append(paths, path)
		}
		pending = nil
		s.events <- BatchEvent{
			Paths:      paths,
			OccurredAt: time.Now(),
		}
	}
	resetTimer := func() {
		if timer == nil {
			timer = time.NewTimer(s.debounce)
			timerCh = timer.C
			return
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(s.debounce)
	}
	defer close(s.events)
	for {
		select {
		case <-s.stop:
			if timer != nil {
				timer.Stop()
			}
			return
		case event, ok := <-s.watcher.Events:
			if !ok {
				return
			}
			rel, err := filepath.Rel(s.root, event.Name)
			if err != nil || rel == "." || shouldIgnore(rel) {
				continue
			}
			if event.Op&fsnotify.Create != 0 {
				if info, statErr := os.Stat(event.Name); statErr == nil && info.IsDir() {
					_ = s.addRecursive(event.Name)
				}
			}
			if event.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Remove|fsnotify.Rename) == 0 {
				continue
			}
			if pending == nil {
				pending = map[string]struct{}{}
			}
			pending[filepath.ToSlash(rel)] = struct{}{}
			resetTimer()
		case err, ok := <-s.watcher.Errors:
			if !ok {
				return
			}
			s.events <- BatchEvent{Err: err, OccurredAt: time.Now()}
		case <-timerCh:
			flush()
		}
	}
}
