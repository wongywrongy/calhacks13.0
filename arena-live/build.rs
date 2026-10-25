use std::{env, fs, path::PathBuf};

fn main() {
    let source = "../shared/fleet.json";
    println!("cargo:rerun-if-changed={source}");
    let config: serde_json::Value = serde_json::from_str(&fs::read_to_string(source).unwrap()).unwrap();
    let drones = config["drones"].as_u64().unwrap();
    let columns = config["columns"].as_u64().unwrap();
    let max = config["maxDrones"].as_u64().unwrap();
    let spacing = config["spacing"].as_f64().unwrap();
    assert!(drones > 0 && drones <= max && columns > 1 && columns <= drones && spacing > 0.0);
    let generated = format!("pub const DRONES: u32 = {drones};\npub const COLUMNS: u32 = {columns};\npub const MAX_DRONES: u32 = {max};\npub const SPACING: f32 = {spacing:?};\n");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("fleet_config.rs"), generated).unwrap();
}
