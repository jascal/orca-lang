/// Structured audit logging for Orca machine transitions.
///
/// LogSink trait with three implementations:
///   FileSink    — JSONL append, one entry per transition
///   ConsoleSink — human-readable [HH:MM:SS] Machine from -> to (EVENT) key=val
///   MultiSink   — fan-out to multiple sinks simultaneously

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write as IoWrite;
use std::path::Path;
use std::time::SystemTime;

/// One audit log record — one per transition across all machines.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub ts: String,
    pub run_id: String,
    pub machine: String,
    pub event: String,
    pub from: String,
    pub to: String,
    pub context_delta: HashMap<String, Value>,
}

/// Trait for audit log backends.
pub trait LogSink: Send {
    fn write(&mut self, entry: &LogEntry) -> Result<(), std::io::Error>;
    fn close(&mut self) -> Result<(), std::io::Error>;
}

/// FileSink writes JSONL audit entries to a file, appending on each write.
pub struct FileSink {
    file: Option<std::fs::File>,
}

impl FileSink {
    /// Create a FileSink writing to path (created/appended as needed).
    /// Creates parent directories if they don't exist.
    pub fn new<P: AsRef<Path>>(path: P) -> Result<Self, std::io::Error> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        Ok(Self { file: Some(file) })
    }
}

impl LogSink for FileSink {
    fn write(&mut self, entry: &LogEntry) -> Result<(), std::io::Error> {
        if let Some(ref mut f) = self.file {
            let json = serde_json::to_string(entry).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, e)
            })?;
            writeln!(f, "{}", json)?;
            f.flush()?;
        }
        Ok(())
    }

    fn close(&mut self) -> Result<(), std::io::Error> {
        // Drop the file handle by taking it
        if let Some(mut f) = self.file.take() {
            f.flush()?;
        }
        Ok(())
    }
}

/// ConsoleSink prints human-readable log entries to stdout.
pub struct ConsoleSink;

impl LogSink for ConsoleSink {
    fn write(&mut self, entry: &LogEntry) -> Result<(), std::io::Error> {
        // Extract HH:MM:SS from RFC3339 timestamp (e.g., "2024-01-15T10:30:45Z")
        let time_part = if entry.ts.len() >= 19 {
            &entry.ts[11..19]
        } else {
            &entry.ts
        };

        let event_str = if entry.event.is_empty() {
            String::new()
        } else {
            format!("  ({})", entry.event)
        };

        let delta_str = if entry.context_delta.is_empty() {
            String::new()
        } else {
            let parts: Vec<String> = entry
                .context_delta
                .iter()
                .map(|(k, v)| format!("{}={}", k, v))
                .collect();
            format!("  {}", parts.join("  "))
        };

        println!(
            "[{}] {:<14} {} \u{2192} {}{}{}",
            time_part, entry.machine, entry.from, entry.to, event_str, delta_str
        );

        Ok(())
    }

    fn close(&mut self) -> Result<(), std::io::Error> {
        Ok(())
    }
}

/// MultiSink fans out writes to multiple sinks.
pub struct MultiSink {
    sinks: Vec<Box<dyn LogSink>>,
}

impl MultiSink {
    /// Create a MultiSink wrapping the provided sinks.
    pub fn new(sinks: Vec<Box<dyn LogSink>>) -> Self {
        Self { sinks }
    }
}

impl LogSink for MultiSink {
    fn write(&mut self, entry: &LogEntry) -> Result<(), std::io::Error> {
        let mut first_err: Option<std::io::Error> = None;
        for sink in &mut self.sinks {
            if let Err(e) = sink.write(entry) {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
        match first_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    fn close(&mut self) -> Result<(), std::io::Error> {
        let mut first_err: Option<std::io::Error> = None;
        for sink in &mut self.sinks {
            if let Err(e) = sink.close() {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
        match first_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

/// Format a SystemTime as an RFC3339 UTC timestamp string.
/// Uses only std — no chrono dependency.
fn format_rfc3339(time: SystemTime) -> String {
    let dur = time
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();

    // Break epoch seconds into date/time components
    // Days since epoch
    let days = secs / 86400;
    let day_secs = secs % 86400;
    let hours = day_secs / 3600;
    let minutes = (day_secs % 3600) / 60;
    let seconds = day_secs % 60;

    // Convert days since epoch to year/month/day
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64; // day of era [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d, hours, minutes, seconds
    )
}

/// Build a LogEntry with the current UTC timestamp.
pub fn make_entry(
    run_id: &str,
    machine: &str,
    event: &str,
    from: &str,
    to: &str,
    context_delta: HashMap<String, Value>,
) -> LogEntry {
    LogEntry {
        ts: format_rfc3339(SystemTime::now()),
        run_id: run_id.to_string(),
        machine: machine.to_string(),
        event: event.to_string(),
        from: from.to_string(),
        to: to.to_string(),
        context_delta,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn test_make_entry() {
        let mut delta = HashMap::new();
        delta.insert("count".to_string(), Value::Number(serde_json::Number::from(1)));

        let entry = make_entry("run-1", "Toggle", "toggle", "off", "on", delta);

        assert_eq!(entry.run_id, "run-1");
        assert_eq!(entry.machine, "Toggle");
        assert_eq!(entry.event, "toggle");
        assert_eq!(entry.from, "off");
        assert_eq!(entry.to, "on");
        assert!(!entry.ts.is_empty(), "timestamp should be non-empty");
        // Verify RFC3339 format: YYYY-MM-DDTHH:MM:SSZ
        assert!(entry.ts.contains('T'), "timestamp should contain 'T'");
        assert!(entry.ts.ends_with('Z'), "timestamp should end with 'Z'");
        assert_eq!(entry.ts.len(), 20, "RFC3339 UTC timestamp should be 20 chars");
        assert_eq!(entry.context_delta.get("count").unwrap(), &Value::Number(serde_json::Number::from(1)));
    }

    #[test]
    fn test_file_sink_writes_jsonl() {
        let dir = std::env::temp_dir().join("orca_test_file_sink");
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("audit.jsonl");

        let mut sink = FileSink::new(&path).unwrap();

        let entry1 = make_entry("r1", "M1", "evt1", "s1", "s2", HashMap::new());
        let mut delta = HashMap::new();
        delta.insert("x".to_string(), Value::Number(serde_json::Number::from(42)));
        let entry2 = make_entry("r1", "M1", "evt2", "s2", "s3", delta);

        sink.write(&entry1).unwrap();
        sink.write(&entry2).unwrap();
        sink.close().unwrap();

        // Read back and verify valid JSONL
        let mut contents = String::new();
        std::fs::File::open(&path)
            .unwrap()
            .read_to_string(&mut contents)
            .unwrap();

        let lines: Vec<&str> = contents.trim().split('\n').collect();
        assert_eq!(lines.len(), 2, "should have 2 JSONL lines");

        // Parse each line as valid JSON
        let parsed1: LogEntry = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(parsed1.machine, "M1");
        assert_eq!(parsed1.from, "s1");
        assert_eq!(parsed1.to, "s2");

        let parsed2: LogEntry = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(parsed2.from, "s2");
        assert_eq!(parsed2.to, "s3");
        assert_eq!(parsed2.context_delta.get("x").unwrap(), &Value::Number(serde_json::Number::from(42)));

        // Cleanup
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_console_sink_write() {
        // ConsoleSink writes to stdout — just verify it doesn't panic
        let mut sink = ConsoleSink;
        let entry = make_entry("r1", "Toggle", "toggle", "off", "on", HashMap::new());
        sink.write(&entry).unwrap();
        sink.close().unwrap();
    }

    #[test]
    fn test_multi_sink() {
        // Use two FileSinks writing to different files
        let dir = std::env::temp_dir().join("orca_test_multi_sink");
        let _ = fs::remove_dir_all(&dir);
        let path1 = dir.join("sink1.jsonl");
        let path2 = dir.join("sink2.jsonl");

        let sink1 = FileSink::new(&path1).unwrap();
        let sink2 = FileSink::new(&path2).unwrap();

        let mut multi = MultiSink::new(vec![Box::new(sink1), Box::new(sink2)]);

        let entry = make_entry("r1", "M1", "evt", "a", "b", HashMap::new());
        multi.write(&entry).unwrap();
        multi.close().unwrap();

        // Both files should have exactly one line
        let contents1 = fs::read_to_string(&path1).unwrap();
        let contents2 = fs::read_to_string(&path2).unwrap();
        assert_eq!(contents1.trim().split('\n').count(), 1);
        assert_eq!(contents2.trim().split('\n').count(), 1);

        // Both should parse to the same entry
        let p1: LogEntry = serde_json::from_str(contents1.trim()).unwrap();
        let p2: LogEntry = serde_json::from_str(contents2.trim()).unwrap();
        assert_eq!(p1.machine, "M1");
        assert_eq!(p2.machine, "M1");

        // Cleanup
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_format_rfc3339() {
        let ts = format_rfc3339(SystemTime::UNIX_EPOCH);
        assert_eq!(ts, "1970-01-01T00:00:00Z");
    }
}
