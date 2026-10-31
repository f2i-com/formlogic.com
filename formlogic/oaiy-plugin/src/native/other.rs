//! Where the plugin can't show a window. OAIY gives a plugin on Linux no display, so nothing that
//! needs the person's say-so can run: there would be nobody to ask.

use std::path::PathBuf;

pub const CAN_ASK: bool = false;

const REFUSED: &str = "FormLogic Backups can't show a confirmation window on this computer, so it won't do this. It works on Windows and macOS.";

pub fn confirm(_text: &str) -> Result<bool, String> {
    Err(REFUSED.to_string())
}

pub fn show_words(_words: &str) -> Result<bool, String> {
    Err(REFUSED.to_string())
}

pub fn save_as(_prompt: &str, _name: &str) -> Result<Option<PathBuf>, String> {
    Err(REFUSED.to_string())
}

pub fn choose_folder(_prompt: &str) -> Result<Option<PathBuf>, String> {
    Err(REFUSED.to_string())
}

pub fn open_url(_url: &str) -> Result<(), String> {
    Err(REFUSED.to_string())
}

pub fn computer_name() -> Option<String> {
    std::fs::read_to_string("/etc/hostname").ok()
}
