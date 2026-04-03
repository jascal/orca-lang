use crate::grid::Grid;

pub fn load(grid: &mut Grid, name: &str) {
    if name == "random" {
        load_random(grid);
        return;
    }

    let cells = match name {
        "gosper" => gosper_glider_gun(),
        "pulsar" => pulsar(),
        "rpentomino" => rpentomino(),
        "acorn" => acorn(),
        "lwss" => lwss(),
        "glider" => glider(),
        _ => gosper_glider_gun(),
    };

    if cells.is_empty() {
        return;
    }

    // Center the pattern on the grid
    let min_x = cells.iter().map(|c| c.0).min().unwrap();
    let max_x = cells.iter().map(|c| c.0).max().unwrap();
    let min_y = cells.iter().map(|c| c.1).min().unwrap();
    let max_y = cells.iter().map(|c| c.1).max().unwrap();
    let pw = (max_x - min_x + 1) as usize;
    let ph = (max_y - min_y + 1) as usize;
    let ox = (grid.width / 2).saturating_sub(pw / 2) as i32 - min_x;
    let oy = (grid.height / 2).saturating_sub(ph / 2) as i32 - min_y;

    for &(x, y) in &cells {
        let gx = (x + ox) as usize;
        let gy = (y + oy) as usize;
        grid.set_alive(gx, gy);
    }
}

fn load_random(grid: &mut Grid) {
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(42);
    let mut state = seed;
    for y in 0..grid.height {
        for x in 0..grid.width {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            if (state >> 33) % 4 == 0 {
                grid.set_alive(x, y);
            }
        }
    }
}

fn parse_cells(s: &str) -> Vec<(i32, i32)> {
    let mut cells = Vec::new();
    for (y, line) in s.lines().enumerate() {
        for (x, ch) in line.chars().enumerate() {
            if ch == 'O' {
                cells.push((x as i32, y as i32));
            }
        }
    }
    cells
}

// ---- Classic patterns ----

fn gosper_glider_gun() -> Vec<(i32, i32)> {
    // 36x9 — the classic infinite growth pattern
    vec![
        // Left block
        (0, 4), (0, 5), (1, 4), (1, 5),
        // Left ship
        (10, 4), (10, 5), (10, 6),
        (11, 3), (11, 7),
        (12, 2), (12, 8),
        (13, 2), (13, 8),
        (14, 5),
        (15, 3), (15, 7),
        (16, 4), (16, 5), (16, 6),
        (17, 5),
        // Right ship
        (20, 2), (20, 3), (20, 4),
        (21, 2), (21, 3), (21, 4),
        (22, 1), (22, 5),
        (24, 0), (24, 1), (24, 5), (24, 6),
        // Right block
        (34, 2), (34, 3), (35, 2), (35, 3),
    ]
}

fn pulsar() -> Vec<(i32, i32)> {
    // Period-3 oscillator, 13x13
    parse_cells(
        "\
..OOO...OOO..
.............
O....O.O....O
O....O.O....O
O....O.O....O
..OOO...OOO..
.............
..OOO...OOO..
O....O.O....O
O....O.O....O
O....O.O....O
.............
..OOO...OOO..",
    )
}

fn rpentomino() -> Vec<(i32, i32)> {
    // Methuselah — stabilizes after 1103 generations
    parse_cells(
        "\
.OO
OO.
.O.",
    )
}

fn acorn() -> Vec<(i32, i32)> {
    // Methuselah — runs for 5206 generations
    parse_cells(
        "\
.O.....
...O...
OO..OOO",
    )
}

fn lwss() -> Vec<(i32, i32)> {
    // Lightweight spaceship
    parse_cells(
        "\
.O..O
O....
O...O
OOOO.",
    )
}

fn glider() -> Vec<(i32, i32)> {
    parse_cells(
        "\
.O.
..O
OOO",
    )
}
