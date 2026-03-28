package orca_runtime_go

// Structured audit logging for Orca machine transitions.
//
// LogSink interface with three implementations:
//   FileSink    — JSONL append, one entry per transition
//   ConsoleSink — human-readable [HH:MM:SS] Machine from → to (EVENT) key=val
//   MultiSink   — fan-out to multiple sinks simultaneously

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// LogEntry is one audit log record — one per transition across all machines.
type LogEntry struct {
	Ts           string         `json:"ts"`
	RunID        string         `json:"run_id"`
	Machine      string         `json:"machine"`
	Event        string         `json:"event"`
	From         string         `json:"from"`
	To           string         `json:"to"`
	ContextDelta map[string]any `json:"context_delta"`
}

// LogSink is the interface for audit log backends.
type LogSink interface {
	Write(entry LogEntry) error
	Close() error
}

// FileSink writes JSONL audit entries to a file, appending on each write.
type FileSink struct {
	path string
	f    *os.File
}

// NewFileSink creates a FileSink writing to path (created/appended as needed).
func NewFileSink(path string) (*FileSink, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	return &FileSink{path: path, f: f}, nil
}

// Write appends a JSONL entry to the file.
func (s *FileSink) Write(entry LogEntry) error {
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(s.f, "%s\n", data)
	return err
}

// Close closes the underlying file.
func (s *FileSink) Close() error {
	if s.f != nil {
		return s.f.Close()
	}
	return nil
}

// ConsoleSink prints human-readable log entries to stdout.
type ConsoleSink struct{}

// Write prints a formatted log line.
func (s *ConsoleSink) Write(entry LogEntry) error {
	timePart := ""
	if len(entry.Ts) >= 19 {
		timePart = entry.Ts[11:19]
	}
	machine := fmt.Sprintf("%-14s", entry.Machine)
	eventStr := ""
	if entry.Event != "" {
		eventStr = fmt.Sprintf("  (%s)", entry.Event)
	}
	var deltaParts []string
	for k, v := range entry.ContextDelta {
		deltaParts = append(deltaParts, fmt.Sprintf("%s=%v", k, v))
	}
	deltaStr := ""
	if len(deltaParts) > 0 {
		deltaStr = "  " + strings.Join(deltaParts, "  ")
	}
	fmt.Printf("[%s] %s %s → %s%s%s\n", timePart, machine, entry.From, entry.To, eventStr, deltaStr)
	return nil
}

// Close is a no-op for ConsoleSink.
func (s *ConsoleSink) Close() error { return nil }

// MultiSink fans out writes to multiple sinks.
type MultiSink struct {
	sinks []LogSink
}

// NewMultiSink creates a MultiSink wrapping the provided sinks.
func NewMultiSink(sinks ...LogSink) *MultiSink {
	return &MultiSink{sinks: sinks}
}

// Write writes to all sinks. Returns the first error encountered.
func (s *MultiSink) Write(entry LogEntry) error {
	var firstErr error
	for _, sink := range s.sinks {
		if err := sink.Write(entry); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// Close closes all sinks. Returns the first error encountered.
func (s *MultiSink) Close() error {
	var firstErr error
	for _, sink := range s.sinks {
		if err := sink.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// MakeEntry builds a LogEntry with the current UTC timestamp.
func MakeEntry(runID, machine, event, from, to string, contextDelta map[string]any) LogEntry {
	return LogEntry{
		Ts:           time.Now().UTC().Format(time.RFC3339),
		RunID:        runID,
		Machine:      machine,
		Event:        event,
		From:         from,
		To:           to,
		ContextDelta: contextDelta,
	}
}
