package orca_runtime_go

// Pluggable persistence for Orca machine snapshots.
//
// PersistenceAdapter is an interface for saving/loading machine snapshots.
// FilePersistence stores snapshots as JSON files with atomic write-then-rename.

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// PersistenceAdapter is the interface for pluggable snapshot persistence.
type PersistenceAdapter interface {
	Save(runID string, snapshot map[string]any) error
	Load(runID string) (map[string]any, error)
	Exists(runID string) bool
}

// FilePersistence stores machine snapshots as JSON files.
// Uses atomic write-then-rename for crash safety.
type FilePersistence struct {
	baseDir string
}

// NewFilePersistence creates a FilePersistence backed by baseDir.
func NewFilePersistence(baseDir string) *FilePersistence {
	return &FilePersistence{baseDir: baseDir}
}

func (p *FilePersistence) pathFor(runID string) string {
	return filepath.Join(p.baseDir, runID+".json")
}

// Save writes a snapshot atomically via a .tmp file.
func (p *FilePersistence) Save(runID string, snapshot map[string]any) error {
	if err := os.MkdirAll(p.baseDir, 0o755); err != nil {
		return err
	}
	path := p.pathFor(runID)
	tmp := path + ".tmp"

	data, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Load reads and returns a snapshot, or nil if none exists.
func (p *FilePersistence) Load(runID string) (map[string]any, error) {
	path := p.pathFor(runID)
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var snap map[string]any
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil, err
	}
	return snap, nil
}

// Exists reports whether a snapshot for runID exists.
func (p *FilePersistence) Exists(runID string) bool {
	_, err := os.Stat(p.pathFor(runID))
	return err == nil
}
