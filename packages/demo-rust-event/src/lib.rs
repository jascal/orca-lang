//! Orca Rust Runtime Demo v2: Event-Sourced Counter
//!
//! Demonstrates:
//! - Guard-aware state machine with verification
//! - Logging via LogSink (transition audit)
//! - Snapshot/restore via PersistenceAdapter
//! - Resume from snapshot (cold boot)
//!
//! Usage:
//!   cargo run -- [--resume]  # Resume from previous snapshot

use orca_runtime_rust::runtime::executor::OrcaMachine;
use orca_runtime_rust::runtime::logging::{LogEntry, LogSink};
use orca_runtime_rust::runtime::parser::parse_orca_md;
use orca_runtime_rust::runtime::persistence::{FilePersistence, PersistenceAdapter, Snapshot};
use orca_runtime_rust::runtime::verifier::verify;
use serde_json::Value;
use std::sync::{Arc, Mutex};

const SNAPSHOT_DIR: &str = ".counter_snapshots";

/// Collect log entries for display
struct CollectorSink {
    entries: Arc<Mutex<Vec<LogEntry>>>,
}

impl CollectorSink {
    fn new() -> (Self, Arc<Mutex<Vec<LogEntry>>>) {
        let entries = Arc::new(Mutex::new(Vec::new()));
        (Self { entries: entries.clone() }, entries)
    }
}

impl LogSink for CollectorSink {
    fn write(&mut self, entry: &LogEntry) -> Result<(), std::io::Error> {
        self.entries.lock().unwrap().push(entry.clone());
        Ok(())
    }

    fn close(&mut self) -> Result<(), std::io::Error> {
        Ok(())
    }
}

/// Simple counter machine definition
const COUNTER_MD: &str = r#"# machine Counter

## context
| Field   | Type | Default |
|---------|------|---------|
| count   | int  | 0       |
| max_val | int  | 100     |

## events
- increment
- decrement
- reset

## state zero [initial]

## state positive

## state negative

## state saturated

## transitions
| Source    | Event     | Guard           | Target    | Action    |
|-----------|-----------|-----------------|-----------|-----------|
| zero      | increment | count < max_val | positive  | add_one   |
| zero      | decrement |                 | negative  | sub_one   |
| zero      | reset     |                 | zero      | clear     |
| positive  | increment | count < max_val | positive  | add_one   |
| positive  | increment | count >= max_val | saturated | saturate  |
| positive  | decrement |                 | zero      | sub_one   |
| positive  | reset     |                 | zero      | clear     |
| negative  | increment |                 | zero      | add_one   |
| negative  | decrement |                 | negative  | sub_one   |
| negative  | reset     |                 | zero      | clear     |
| saturated | decrement |                 | positive  | sub_one   |
| saturated | increment |                 | saturated |           |
| saturated | reset     |                 | zero      | clear     |

## actions
| Name     | Signature           |
|----------|---------------------|
| add_one  | `(ctx) -> Context` |
| sub_one  | `(ctx) -> Context` |
| clear    | `(ctx) -> Context` |
| saturate | `(ctx) -> Context` |
"#;

pub fn run_demo(resume: bool) -> Result<(), String> {
    println!("\n=== Orca Rust Runtime Demo v2: Event-Sourced Counter ===\n");
    println!("Features: Guard verification, transition logging, snapshot/restore, resume\n");

    // Parse and verify
    let def = parse_orca_md(COUNTER_MD).map_err(|e| e.message)?;
    println!("[+] Parsed counter.orca.md");
    verify(&def).map_err(|e| e.message)?;
    println!("[+] Verified machine definition");
    println!("    - {} states, {} transitions", def.states.len(), def.transitions.len());

    // Set up logging
    let (collector, entries) = CollectorSink::new();

    // Persistence
    let persistence = FilePersistence::new(SNAPSHOT_DIR);

    // Create machine
    let mut machine = OrcaMachine::new(def.clone()).map_err(|e| e.message)?;

    // Resume from snapshot if requested
    if resume {
        if let Ok(Some(snap)) = persistence.load("counter") {
            machine.resume(&snap).map_err(|e| e)?;
            println!("\n[+] RESUMED from snapshot at {}/counter.json", SNAPSHOT_DIR);
        } else {
            machine.start().map_err(|e| e.message)?;
            println!("\n[+] No snapshot found, started fresh");
        }
    } else {
        machine.start().map_err(|e| e.message)?;
        println!("\n[+] Started fresh machine");
    }

    // Register action handlers
    machine.register_action_rust("add_one", Box::new(|ctx: &Value, _event: &Value| {
        let count = ctx["count"].as_i64().unwrap_or(0);
        let max_val = ctx["max_val"].as_i64().unwrap_or(100);
        serde_json::json!({ "count": (count + 1).min(max_val) })
    }));

    machine.register_action_rust("sub_one", Box::new(|_ctx: &Value, _event: &Value| {
        let count = _ctx["count"].as_i64().unwrap_or(0);
        serde_json::json!({ "count": count - 1 })
    }));

    machine.register_action_rust("clear", Box::new(|_ctx: &Value, _event: &Value| {
        serde_json::json!({ "count": 0 })
    }));

    machine.register_action_rust("saturate", Box::new(|ctx: &Value, _event: &Value| {
        let max_val = ctx["max_val"].as_i64().unwrap_or(100);
        serde_json::json!({ "count": max_val })
    }));

    // Set up logging
    machine.set_log_sink(Box::new(collector));
    machine.set_run_id("counter-demo-1".to_string());

    // Set up transition callback for extra observability
    machine.on_transition(Box::new(|from, to, event| {
        println!("    TRANSITION: {} -> {} (event: {})", from, to, event);
    }));

    // Run some transitions
    println!("\n--- Running transitions ---\n");

    let ops = vec![
        ("increment", "inc #1"),
        ("increment", "inc #2"),
        ("increment", "inc #3"),
        ("decrement", "dec #1"),
        ("increment", "inc #4"),
    ];

    for (event, label) in &ops {
        let ctx = machine.context();
        let count = ctx.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
        let state = machine.state();
        println!("  [{}] state={}, count={}", label, state, count);

        let event_json = serde_json::json!({ "type": event });
        machine.send(&event_json.to_string()).map_err(|e| e.message)?;

        let new_state = machine.state();
        let new_count = machine.context().get("count").and_then(|v| v.as_i64()).unwrap_or(0);
        println!("    -> state={}, count={}", new_state, new_count);
    }

    // Take and save snapshot
    println!("\n--- Snapshot/Restore ---\n");
    let snap_json = machine.snapshot().map_err(|e| e)?;
    let snap: Snapshot =
        serde_json::from_str(&snap_json).map_err(|e| format!("failed to parse snapshot: {}", e))?;
    persistence
        .save("counter", &snap)
        .map_err(|e| e.to_string())?;
    println!(
        "[+] Saved snapshot to {}/counter.json",
        SNAPSHOT_DIR
    );

    // Show logged entries
    let logged = entries.lock().unwrap();
    println!(
        "\n--- Transition Audit Log ({} entries) ---\n",
        logged.len()
    );
    println!("  {:<12} {:<12} {:<15}", "From", "To", "Event");
    println!("  {}", "-".repeat(45));
    for entry in logged.iter().take(15) {
        println!("  {:<12} {:<12} {:<15}", entry.from, entry.to, entry.event);
    }
    drop(logged);

    // Demonstrate restore from snapshot
    println!("\n--- Restore Demo ---\n");
    drop(machine);

    let mut machine2 = OrcaMachine::new(def).map_err(|e| e.message)?;

    // Re-register action handlers (machine was dropped, need to re-register)
    machine2.register_action_rust("add_one", Box::new(|ctx: &Value, _event: &Value| {
        let count = ctx["count"].as_i64().unwrap_or(0);
        let max_val = ctx["max_val"].as_i64().unwrap_or(100);
        serde_json::json!({ "count": (count + 1).min(max_val) })
    }));
    machine2.register_action_rust("sub_one", Box::new(|_ctx: &Value, _event: &Value| {
        let count = _ctx["count"].as_i64().unwrap_or(0);
        serde_json::json!({ "count": count - 1 })
    }));
    machine2.register_action_rust("clear", Box::new(|_ctx: &Value, _event: &Value| {
        serde_json::json!({ "count": 0 })
    }));
    machine2.register_action_rust("saturate", Box::new(|ctx: &Value, _event: &Value| {
        let max_val = ctx["max_val"].as_i64().unwrap_or(100);
        serde_json::json!({ "count": max_val })
    }));

    if let Ok(Some(snap)) = persistence.load("counter") {
        machine2.resume(&snap).map_err(|e| e)?;
        let state = machine2.state();
        let count = machine2
            .context()
            .get("count")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        println!("[+] Restored from snapshot");
        println!("    state={}, count={}", state, count);
        println!("    (on_entry was NOT re-run - this is a cold boot resume)");
    }

    println!("\n=== Demo Complete ===");
    println!(
        "\nRun with --resume to continue from the saved snapshot:"
    );
    println!("  cargo run -- --resume\n");
    Ok(())
}
