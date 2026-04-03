use orca_runtime_rust::runtime::executor::OrcaMachine;
use orca_runtime_rust::runtime::parser::parse_orca_md;
use orca_runtime_rust::runtime::verifier::verify;

const CELL_MD: &str = include_str!("../orca/cell.orca.md");

pub struct Grid {
    pub width: usize,
    pub height: usize,
    machines: Vec<OrcaMachine>,
    pub alive: Vec<bool>,
    pub ages: Vec<u16>,
    pub just_died: Vec<bool>,
    pub births: u32,
    pub deaths: u32,
}

fn make_machine(def: &orca_runtime_rust::runtime::types::MachineDef) -> OrcaMachine {
    let mut m = OrcaMachine::new(def.clone()).expect("Failed to create cell machine");
    m.register_action_rust(
        "store_count",
        Box::new(|_ctx, event| {
            let n = event.get("neighbors").and_then(|v| v.as_i64()).unwrap_or(0);
            serde_json::json!({ "neighbors": n })
        }),
    );
    m.start().expect("Failed to start cell machine");
    m
}

impl Grid {
    pub fn new(width: usize, height: usize) -> Self {
        let def = parse_orca_md(CELL_MD).expect("Failed to parse cell.orca.md");
        verify(&def).expect("Cell machine verification failed");

        let size = width * height;
        let mut machines = Vec::with_capacity(size);
        for _ in 0..size {
            machines.push(make_machine(&def));
        }

        Grid {
            width,
            height,
            machines,
            alive: vec![false; size],
            ages: vec![0; size],
            just_died: vec![false; size],
            births: 0,
            deaths: 0,
        }
    }

    pub fn set_alive(&mut self, x: usize, y: usize) {
        if x < self.width && y < self.height {
            let idx = y * self.width + x;
            if !self.alive[idx] {
                let _ = self.machines[idx].send(r#"{"type":"spawn"}"#);
                self.alive[idx] = true;
                self.ages[idx] = 1;
            }
        }
    }

    pub fn population(&self) -> u32 {
        self.alive.iter().filter(|&&a| a).count() as u32
    }

    pub fn step(&mut self) {
        let size = self.width * self.height;

        // Phase 1: count neighbors and send count events
        let mut counts = vec![0u8; size];
        for y in 0..self.height {
            for x in 0..self.width {
                counts[y * self.width + x] = self.count_neighbors(x, y);
            }
        }
        for (idx, &count) in counts.iter().enumerate() {
            let event = format!(r#"{{"type":"count","neighbors":{}}}"#, count);
            let _ = self.machines[idx].send(&event);
        }

        // Phase 2: send evolve events and sync state
        self.births = 0;
        self.deaths = 0;
        for idx in 0..size {
            let _ = self.machines[idx].send(r#"{"type":"evolve"}"#);
            let now_alive = self.machines[idx].state() == "alive";
            let was_alive = self.alive[idx];

            self.just_died[idx] = was_alive && !now_alive;

            if now_alive && !was_alive {
                self.births += 1;
                self.ages[idx] = 1;
            } else if now_alive {
                self.ages[idx] = self.ages[idx].saturating_add(1);
            } else {
                self.ages[idx] = 0;
            }

            if was_alive && !now_alive {
                self.deaths += 1;
            }

            self.alive[idx] = now_alive;
        }
    }

    pub fn reset(&mut self) {
        let def = parse_orca_md(CELL_MD).expect("Failed to parse cell.orca.md");
        for idx in 0..self.machines.len() {
            self.machines[idx] = make_machine(&def);
            self.alive[idx] = false;
            self.ages[idx] = 0;
            self.just_died[idx] = false;
        }
        self.births = 0;
        self.deaths = 0;
    }

    fn count_neighbors(&self, x: usize, y: usize) -> u8 {
        let mut count = 0u8;
        let w = self.width as i32;
        let h = self.height as i32;
        for dy in [-1i32, 0, 1] {
            for dx in [-1i32, 0, 1] {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let nx = ((x as i32) + dx).rem_euclid(w) as usize;
                let ny = ((y as i32) + dy).rem_euclid(h) as usize;
                if self.alive[ny * self.width + nx] {
                    count += 1;
                }
            }
        }
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cell_machine_parses_and_verifies() {
        let def = parse_orca_md(CELL_MD).unwrap();
        verify(&def).unwrap();
        assert_eq!(def.name, "Cell");
        assert_eq!(def.states.len(), 2);
    }

    #[test]
    fn test_blinker_oscillates() {
        // Blinker: the simplest oscillator (period 2)
        //   Gen 0:    Gen 1:    Gen 2 (= Gen 0):
        //   .O.       ...       .O.
        //   .O.       OOO       .O.
        //   .O.       ...       .O.
        let mut grid = Grid::new(5, 5);
        grid.set_alive(2, 1);
        grid.set_alive(2, 2);
        grid.set_alive(2, 3);
        assert_eq!(grid.population(), 3);

        // Step 1: vertical blinker -> horizontal
        grid.step();
        assert_eq!(grid.population(), 3);
        assert!(!grid.alive[1 * 5 + 2]); // (2,1) should be dead
        assert!(grid.alive[2 * 5 + 1]);  // (1,2) should be alive
        assert!(grid.alive[2 * 5 + 2]);  // (2,2) stays alive
        assert!(grid.alive[2 * 5 + 3]);  // (3,2) should be alive
        assert!(!grid.alive[3 * 5 + 2]); // (2,3) should be dead

        // Step 2: horizontal -> back to vertical
        grid.step();
        assert_eq!(grid.population(), 3);
        assert!(grid.alive[1 * 5 + 2]);  // (2,1) alive again
        assert!(grid.alive[2 * 5 + 2]);  // (2,2) alive
        assert!(grid.alive[3 * 5 + 2]);  // (2,3) alive again
    }

    #[test]
    fn test_block_is_still_life() {
        // 2x2 block: stable pattern
        let mut grid = Grid::new(6, 6);
        grid.set_alive(2, 2);
        grid.set_alive(3, 2);
        grid.set_alive(2, 3);
        grid.set_alive(3, 3);
        assert_eq!(grid.population(), 4);

        for _ in 0..5 {
            grid.step();
            assert_eq!(grid.population(), 4);
            assert!(grid.alive[2 * 6 + 2]);
            assert!(grid.alive[2 * 6 + 3]);
            assert!(grid.alive[3 * 6 + 2]);
            assert!(grid.alive[3 * 6 + 3]);
        }
    }

    #[test]
    fn test_single_cell_dies() {
        let mut grid = Grid::new(5, 5);
        grid.set_alive(2, 2);
        assert_eq!(grid.population(), 1);

        grid.step();
        assert_eq!(grid.population(), 0);
        assert!(!grid.alive[2 * 5 + 2]);
    }

    #[test]
    fn test_glider_moves() {
        // Glider should move diagonally
        //  .O.
        //  ..O
        //  OOO
        let mut grid = Grid::new(10, 10);
        grid.set_alive(1, 0);
        grid.set_alive(2, 1);
        grid.set_alive(0, 2);
        grid.set_alive(1, 2);
        grid.set_alive(2, 2);
        assert_eq!(grid.population(), 5);

        // After 4 generations, a glider returns to its original shape
        // but shifted one cell diagonally
        for _ in 0..4 {
            grid.step();
        }
        assert_eq!(grid.population(), 5);
        // Shifted by (1,1) from original position
        assert!(grid.alive[1 * 10 + 2]); // (2,1)
        assert!(grid.alive[2 * 10 + 3]); // (3,2)
        assert!(grid.alive[3 * 10 + 1]); // (1,3)
        assert!(grid.alive[3 * 10 + 2]); // (2,3)
        assert!(grid.alive[3 * 10 + 3]); // (3,3)
    }

    #[test]
    fn test_births_and_deaths_tracked() {
        let mut grid = Grid::new(5, 5);
        grid.set_alive(2, 1);
        grid.set_alive(2, 2);
        grid.set_alive(2, 3);

        grid.step();
        // Blinker transition: 2 die (ends), 2 born (sides), 1 survives (center)
        assert_eq!(grid.deaths, 2);
        assert_eq!(grid.births, 2);
    }

    #[test]
    fn test_reset_clears_grid() {
        let mut grid = Grid::new(5, 5);
        grid.set_alive(2, 2);
        grid.step();
        grid.reset();
        assert_eq!(grid.population(), 0);
        assert!(grid.ages.iter().all(|&a| a == 0));
    }
}
