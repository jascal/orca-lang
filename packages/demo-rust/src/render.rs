use crossterm::{cursor, execute, queue, style::*, terminal::*};
use std::io::{self, Write};

use crate::grid::Grid;

const BORDER: Color = Color::Rgb { r: 60, g: 80, b: 120 };
const BORDER_DIM: Color = Color::Rgb { r: 40, g: 50, b: 80 };
const BG_DEAD: Color = Color::Rgb { r: 8, g: 8, b: 16 };

pub struct Renderer {
    buf: Vec<u8>,
    initialized: bool,
}

impl Renderer {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(128 * 1024),
            initialized: false,
        }
    }

    pub fn init(&mut self) {
        let mut out = io::stdout();
        enable_raw_mode().unwrap();
        execute!(out, EnterAlternateScreen, cursor::Hide, Clear(ClearType::All)).unwrap();
        self.initialized = true;
    }

    fn do_cleanup(&mut self) {
        if self.initialized {
            let mut out = io::stdout();
            let _ = execute!(out, cursor::Show, LeaveAlternateScreen);
            let _ = disable_raw_mode();
            self.initialized = false;
        }
    }

    pub fn draw(
        &mut self,
        grid: &Grid,
        gen: u64,
        paused: bool,
        pattern: &str,
        speed_ms: u64,
        fps: f64,
    ) {
        self.buf.clear();
        let w = grid.width;
        let right_col = (w + 1) as u16;

        queue!(self.buf, cursor::MoveTo(0, 0)).unwrap();

        // === Top border with title ===
        let title = " CONWAY'S GAME OF LIFE ";
        let subtitle = " Orca State Machine Demo ";
        let dashes_left = 3;
        let dashes_right = w.saturating_sub(dashes_left + title.len() + 3 + subtitle.len() + 1);
        queue!(
            self.buf,
            SetForegroundColor(BORDER),
            Print("\u{250C}"),
            Print("\u{2500}".repeat(dashes_left)),
            SetForegroundColor(Color::White),
            SetAttribute(Attribute::Bold),
            Print(title),
            SetAttribute(Attribute::Reset),
            SetForegroundColor(BORDER_DIM),
            Print("\u{2500}\u{2500}\u{2500}"),
            SetForegroundColor(Color::Rgb { r: 100, g: 140, b: 180 }),
            Print(subtitle),
            SetForegroundColor(BORDER),
            Print("\u{2500}".repeat(dashes_right)),
            Print("\u{2510}\r\n"),
        )
        .unwrap();

        // === Grid rows (half-block rendering) ===
        for row_pair in (0..grid.height).step_by(2) {
            queue!(
                self.buf,
                SetForegroundColor(BORDER),
                SetBackgroundColor(Color::Reset),
                Print("\u{2502}")
            )
            .unwrap();

            for x in 0..w {
                let ui = row_pair * w + x;
                let li = if row_pair + 1 < grid.height {
                    (row_pair + 1) * w + x
                } else {
                    ui
                };

                let fg = cell_color(grid.alive[ui], grid.ages[ui], grid.just_died[ui]);
                let bg = cell_color(grid.alive[li], grid.ages[li], grid.just_died[li]);

                queue!(
                    self.buf,
                    SetForegroundColor(fg),
                    SetBackgroundColor(bg),
                    Print("\u{2580}") // ▀
                )
                .unwrap();
            }

            queue!(
                self.buf,
                SetBackgroundColor(Color::Reset),
                SetForegroundColor(BORDER),
                Print("\u{2502}\r\n")
            )
            .unwrap();
        }

        // === Separator ===
        queue!(
            self.buf,
            SetForegroundColor(BORDER),
            Print(format!(
                "\u{251C}{}\u{2524}\r\n",
                "\u{2500}".repeat(w)
            ))
        )
        .unwrap();

        // === Stats line ===
        let pop = grid.population();
        let total = (grid.width * grid.height) as u32;
        let status_str = if paused { "PAUSED" } else { "RUNNING" };
        let status_color = if paused {
            Color::Yellow
        } else {
            Color::Green
        };

        queue!(
            self.buf,
            SetForegroundColor(BORDER),
            Print("\u{2502}"),
            SetForegroundColor(Color::White),
            Print(format!(" Gen {:>6}", gen)),
            SetForegroundColor(BORDER_DIM),
            Print(" \u{2502} "),
            SetForegroundColor(Color::Cyan),
            Print(format!("{:>5}", pop)),
            SetForegroundColor(Color::DarkGrey),
            Print(format!("/{}", total)),
            SetForegroundColor(BORDER_DIM),
            Print(" \u{2502} "),
            SetForegroundColor(Color::Rgb { r: 80, g: 220, b: 120 }),
            Print(format!("+{:<4}", grid.births)),
            SetForegroundColor(Color::Rgb { r: 220, g: 80, b: 60 }),
            Print(format!("-{:<4}", grid.deaths)),
            SetForegroundColor(BORDER_DIM),
            Print(" \u{2502} "),
            SetForegroundColor(Color::DarkGrey),
            Print(format!("{:>3.0}fps {}ms", fps, speed_ms)),
            SetForegroundColor(BORDER_DIM),
            Print(" \u{2502} "),
            SetForegroundColor(status_color),
            SetAttribute(Attribute::Bold),
            Print(status_str),
            SetAttribute(Attribute::Reset),
            SetForegroundColor(BORDER_DIM),
            Print(" \u{2502} "),
            SetForegroundColor(Color::Rgb { r: 180, g: 160, b: 100 }),
            Print(pattern),
        )
        .unwrap();
        // Right border via column position
        queue!(
            self.buf,
            cursor::MoveToColumn(right_col),
            SetForegroundColor(BORDER),
            Print("\u{2502}\r\n")
        )
        .unwrap();

        // === Controls line ===
        queue!(
            self.buf,
            SetForegroundColor(BORDER),
            Print("\u{2502}"),
            SetForegroundColor(Color::DarkGrey),
            Print(" [Space]"),
            SetForegroundColor(Color::Rgb { r: 90, g: 90, b: 110 }),
            Print("Pause "),
            SetForegroundColor(Color::DarkGrey),
            Print("[N]"),
            SetForegroundColor(Color::Rgb { r: 90, g: 90, b: 110 }),
            Print("Step "),
            SetForegroundColor(Color::DarkGrey),
            Print("[R]"),
            SetForegroundColor(Color::Rgb { r: 90, g: 90, b: 110 }),
            Print("Reset "),
            SetForegroundColor(Color::DarkGrey),
            Print("[+/-]"),
            SetForegroundColor(Color::Rgb { r: 90, g: 90, b: 110 }),
            Print("Speed "),
            SetForegroundColor(Color::DarkGrey),
            Print("[1-7]"),
            SetForegroundColor(Color::Rgb { r: 90, g: 90, b: 110 }),
            Print("Pattern "),
            SetForegroundColor(Color::DarkGrey),
            Print("[Q]"),
            SetForegroundColor(Color::Rgb { r: 90, g: 90, b: 110 }),
            Print("Quit"),
        )
        .unwrap();
        queue!(
            self.buf,
            cursor::MoveToColumn(right_col),
            SetForegroundColor(BORDER),
            Print("\u{2502}\r\n")
        )
        .unwrap();

        // === Bottom border ===
        queue!(
            self.buf,
            SetForegroundColor(BORDER),
            Print(format!(
                "\u{2514}{}\u{2518}\r\n",
                "\u{2500}".repeat(w)
            ))
        )
        .unwrap();

        // === Machine count (outside box) ===
        queue!(
            self.buf,
            SetForegroundColor(Color::Rgb { r: 50, g: 55, b: 70 }),
            Print(format!(
                "  {} Orca state machines \u{00B7} each cell = 1 machine (dead \u{2194} alive)",
                total
            )),
            SetForegroundColor(Color::Reset),
            SetBackgroundColor(Color::Reset),
        )
        .unwrap();

        let mut out = io::stdout();
        out.write_all(&self.buf).unwrap();
        out.flush().unwrap();
    }
}

impl Drop for Renderer {
    fn drop(&mut self) {
        self.do_cleanup();
    }
}

fn cell_color(alive: bool, age: u16, just_died: bool) -> Color {
    if just_died {
        return Color::Rgb {
            r: 180,
            g: 50,
            b: 30,
        };
    }
    if !alive {
        return BG_DEAD;
    }
    match age {
        0..=1 => Color::Rgb {
            r: 200,
            g: 255,
            b: 255,
        },
        2..=3 => Color::Rgb {
            r: 100,
            g: 230,
            b: 210,
        },
        4..=8 => Color::Rgb {
            r: 50,
            g: 190,
            b: 150,
        },
        9..=20 => Color::Rgb {
            r: 30,
            g: 150,
            b: 110,
        },
        21..=50 => Color::Rgb {
            r: 20,
            g: 120,
            b: 85,
        },
        _ => Color::Rgb {
            r: 15,
            g: 95,
            b: 65,
        },
    }
}
