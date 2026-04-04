fn main() {
    let args: Vec<String> = std::env::args().collect();
    let resume = args.iter().any(|a| a == "--resume");

    if let Err(e) = orca_demo_rust_event::run_demo(resume) {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
