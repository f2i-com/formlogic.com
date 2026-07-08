// Prevents additional console window on Windows in release. The companion
// is a tray-resident app — there's no terminal to show.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(feature = "gui")]
    formlogic_desktop_lib::run();
    #[cfg(not(feature = "gui"))]
    eprintln!("formlogic-desktop requires the 'gui' feature; use the formlogic-server binary for headless.");
}
