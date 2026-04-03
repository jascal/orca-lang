mod grid;
mod patterns;
mod render;

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::terminal;
use std::time::{Duration, Instant};

const PATTERNS: &[(&str, &str)] = &[
    ("gosper", "Gosper Glider Gun"),
    ("pulsar", "Pulsar"),
    ("rpentomino", "R-Pentomino"),
    ("acorn", "Acorn"),
    ("lwss", "Spaceship (LWSS)"),
    ("glider", "Glider"),
    ("random", "Random"),
];

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // Handle --help
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Conway's Game of Life -- Orca State Machine Demo");
        println!();
        println!("Usage: gameoflife [PATTERN]");
        println!();
        println!("Patterns:");
        for (i, (name, desc)) in PATTERNS.iter().enumerate() {
            let marker = if i == 0 { " (default)" } else { "" };
            println!("  {}: {}{}", i + 1, desc, marker);
            println!("     {}", name);
        }
        println!();
        println!("Controls:");
        println!("  Space    Pause / Resume");
        println!("  N        Step one generation (when paused)");
        println!("  R        Reset current pattern");
        println!("  1-7      Switch pattern");
        println!("  + / -    Speed up / slow down");
        println!("  Q / Esc  Quit");
        println!();
        println!("Each cell in the grid is an independent Orca state machine.");
        println!("Conway's rules are encoded as guard-based transitions:");
        println!("  alive + 2 or 3 neighbors -> alive");
        println!("  alive + else             -> dead");
        println!("  dead  + 3 neighbors      -> alive");
        return;
    }

    let mut pattern_idx: usize = args
        .get(1)
        .and_then(|name| PATTERNS.iter().position(|p| p.0 == name.as_str()))
        .unwrap_or(0);

    let (term_w, term_h) = terminal::size().unwrap_or((80, 24));
    let grid_w = (term_w as usize).saturating_sub(2).min(160);
    // 6 lines overhead: top border, separator, stats, controls, bottom border, machine info
    let grid_h = ((term_h as usize).saturating_sub(6) * 2).min(100) & !1;

    if grid_w < 20 || grid_h < 10 {
        eprintln!("Terminal too small (need at least 22x13)");
        return;
    }

    eprintln!(
        "Initializing {} Orca state machines ({} x {} grid)...",
        grid_w * grid_h,
        grid_w,
        grid_h
    );

    let mut grid = grid::Grid::new(grid_w, grid_h);
    patterns::load(&mut grid, PATTERNS[pattern_idx].0);

    let mut renderer = render::Renderer::new();
    renderer.init();

    let mut paused = false;
    let mut generation: u64 = 0;
    let mut speed_ms: u64 = 80;
    let mut fps: f64 = 0.0;

    loop {
        let frame_start = Instant::now();

        renderer.draw(
            &grid,
            generation,
            paused,
            PATTERNS[pattern_idx].1,
            speed_ms,
            fps,
        );

        // Handle input until frame deadline
        let deadline = frame_start + Duration::from_millis(speed_ms);
        let mut quit = false;

        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }

            if event::poll(remaining).unwrap_or(false) {
                if let Ok(Event::Key(key)) = event::read() {
                    if key.kind == KeyEventKind::Press {
                        match key.code {
                            KeyCode::Char('q') | KeyCode::Esc => {
                                quit = true;
                                break;
                            }
                            KeyCode::Char(' ') => paused = !paused,
                            KeyCode::Char('n') if paused => {
                                grid.step();
                                generation += 1;
                            }
                            KeyCode::Char('r') => {
                                grid.reset();
                                patterns::load(&mut grid, PATTERNS[pattern_idx].0);
                                generation = 0;
                            }
                            KeyCode::Char(c @ '1'..='7') => {
                                let idx = (c as usize) - ('1' as usize);
                                if idx < PATTERNS.len() {
                                    pattern_idx = idx;
                                    grid.reset();
                                    patterns::load(&mut grid, PATTERNS[pattern_idx].0);
                                    generation = 0;
                                }
                            }
                            KeyCode::Char('+') | KeyCode::Char('=') => {
                                speed_ms = speed_ms.saturating_sub(10).max(10);
                            }
                            KeyCode::Char('-') | KeyCode::Char('_') => {
                                speed_ms = (speed_ms + 10).min(500);
                            }
                            _ => {}
                        }
                    }
                }
            } else {
                break;
            }
        }

        if quit {
            break;
        }

        if !paused {
            grid.step();
            generation += 1;
        }

        let elapsed = frame_start.elapsed().as_secs_f64();
        fps = if elapsed > 0.0 { 1.0 / elapsed } else { 0.0 };
    }
    // Renderer cleanup via Drop
}
