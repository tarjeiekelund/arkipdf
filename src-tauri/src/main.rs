// Ingen konsollvindu på Windows i release-bygg.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    blad_lib::run()
}
