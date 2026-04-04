use std::fs;
use std::io::Write as IoWrite;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::types::MachineDef;

/// Top-level snapshot for serialize/restore.
/// Carries everything needed to fully reconstitute a running machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub definition: MachineDef,
    pub state: String,
    pub context: Value,
    pub run_id: String,
    pub active: bool,
}

/// PersistenceAdapter is a protocol for saving and loading machine snapshots.
pub trait PersistenceAdapter {
    /// Save a snapshot for the given run ID.
    fn save(&self, run_id: &str, snapshot: &Snapshot) -> Result<(), String>;

    /// Load a snapshot for the given run ID, or None if not found.
    fn load(&self, run_id: &str) -> Result<Option<Snapshot>, String>;

    /// Returns true if a snapshot exists for the given run ID.
    fn exists(&self, run_id: &str) -> bool;
}

/// FilePersistence stores snapshots as JSON files with atomic write-then-rename.
pub struct FilePersistence {
    base_dir: String,
}

impl FilePersistence {
    pub fn new(base_dir: &str) -> Self {
        Self {
            base_dir: base_dir.to_string(),
        }
    }

    fn path_for(&self, run_id: &str) -> String {
        format!("{}/{}.json", self.base_dir, run_id)
    }
}

impl PersistenceAdapter for FilePersistence {
    fn save(&self, run_id: &str, snapshot: &Snapshot) -> Result<(), String> {
        let path = self.path_for(run_id);

        // Create parent directories if needed
        if let Some(parent) = Path::new(&path).parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create directory {:?}: {}", parent, e))?;
        }

        let json = serde_json::to_string(snapshot)
            .map_err(|e| format!("snapshot serialization failed: {}", e))?;

        // Atomic write: write to .tmp then rename
        let tmp_path = format!("{}.tmp", path);
        {
            let mut file = fs::File::create(&tmp_path)
                .map_err(|e| format!("failed to create temp file: {}", e))?;
            file.write_all(json.as_bytes())
                .map_err(|e| format!("failed to write snapshot: {}", e))?;
            file.flush()
                .map_err(|e| format!("failed to flush snapshot: {}", e))?;
        }
        fs::rename(&tmp_path, &path)
            .map_err(|e| format!("failed to rename temp file to {}: {}", path, e))?;

        Ok(())
    }

    fn load(&self, run_id: &str) -> Result<Option<Snapshot>, String> {
        let path = self.path_for(run_id);
        if !Path::new(&path).exists() {
            return Ok(None);
        }
        let contents =
            fs::read_to_string(&path).map_err(|e| format!("failed to read {}: {}", path, e))?;
        let snap: Snapshot = serde_json::from_str(&contents)
            .map_err(|e| format!("failed to parse snapshot from {}: {}", path, e))?;
        Ok(Some(snap))
    }

    fn exists(&self, run_id: &str) -> bool {
        Path::new(&self.path_for(run_id)).exists()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::{MachineDef, StateDef, Transition};
    use std::collections::HashMap;
    use std::fs;

    /// Simple temp directory that is deleted on drop.
    struct TempDir(String);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "orca_test_{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            TempDir(path.to_string_lossy().to_string())
        }

        fn path(&self) -> &str {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn counter_snapshot(run_id: &str, count: i64) -> Snapshot {
        Snapshot {
            definition: MachineDef {
                name: "Counter".to_string(),
                context: serde_json::json!({"count": count}),
                events: vec!["inc".to_string()],
                states: vec![StateDef {
                    name: "running".to_string(),
                    is_initial: true,
                    is_final: false,
                    description: None,
                    on_entry: None,
                    on_exit: None,
                    ignored_events: vec![],
                }],
                transitions: vec![Transition {
                    source: "running".to_string(),
                    event: "inc".to_string(),
                    guard: None,
                    target: "running".to_string(),
                    action: Some("increment".to_string()),
                }],
                guards: HashMap::new(),
                actions: vec![],
            },
            state: "running".to_string(),
            context: serde_json::json!({"count": count}),
            run_id: run_id.to_string(),
            active: true,
        }
    }

    #[test]
    fn test_file_persistence_save_and_load() {
        let tmp = TempDir::new();
        let adapter = FilePersistence::new(tmp.path());

        let snap = counter_snapshot("run-1", 5);
        adapter.save("run-1", &snap).unwrap();

        let loaded = adapter.load("run-1").unwrap().unwrap();
        assert_eq!(loaded.state, "running");
        assert_eq!(loaded.context["count"], 5);
        assert_eq!(loaded.run_id, "run-1");
    }

    #[test]
    fn test_file_persistence_exists() {
        let tmp = TempDir::new();
        let adapter = FilePersistence::new(tmp.path());

        assert!(!adapter.exists("run-1"));

        let snap = counter_snapshot("run-1", 0);
        adapter.save("run-1", &snap).unwrap();

        assert!(adapter.exists("run-1"));
        assert!(!adapter.exists("nonexistent"));
    }

    #[test]
    fn test_file_persistence_load_not_found() {
        let tmp = TempDir::new();
        let adapter = FilePersistence::new(tmp.path());

        let result = adapter.load("nonexistent").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_file_persistence_overwrite() {
        let tmp = TempDir::new();
        let adapter = FilePersistence::new(tmp.path());

        let snap1 = counter_snapshot("run-1", 1);
        adapter.save("run-1", &snap1).unwrap();

        let snap2 = counter_snapshot("run-1", 99);
        adapter.save("run-1", &snap2).unwrap();

        let loaded = adapter.load("run-1").unwrap().unwrap();
        assert_eq!(loaded.context["count"], 99);
    }
}