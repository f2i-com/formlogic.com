//! Windows answered from a file, for tests/. Only in a build with the `scripted-dialogs` feature,
//! which a package never has: scripts/package-oaiy-plugin.mjs looks for the name below in the
//! binary and refuses it.
//!
//! `FORMLOGIC_BACKUPS_SCRIPTED` names a folder. `answers.txt` holds one answer a line (`yes`, `no`,
//! `save <path>`, `folder <path>`, or `slow <ms>`, a yes that takes that long), each used once; with none left the
//! answer is no. Everything asked goes in `asked.txt`, and an address that would have opened in
//! `opened.txt`.

use std::io::Write as _;
use std::path::PathBuf;

pub const CAN_ASK: bool = true;

fn folder() -> Result<PathBuf, String> {
    std::env::var_os("FORMLOGIC_BACKUPS_SCRIPTED").map(PathBuf::from).ok_or_else(|| "FORMLOGIC_BACKUPS_SCRIPTED is not set.".to_string())
}

fn note(file: &str, text: &str) -> Result<(), String> {
    let mut log = std::fs::OpenOptions::new().create(true).append(true).open(folder()?.join(file)).map_err(|e| e.to_string())?;
    writeln!(log, "{text}").map_err(|e| e.to_string())
}

fn next_answer() -> Result<String, String> {
    let path = folder()?.join("answers.txt");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines = text.lines();
    let answer = lines.next().unwrap_or("no").trim().to_string();
    std::fs::write(&path, lines.collect::<Vec<_>>().join("\n")).map_err(|e| e.to_string())?;
    if let Some(ms) = answer.strip_prefix("slow ") {
        std::thread::sleep(std::time::Duration::from_millis(ms.parse().map_err(|_| "a bad slow answer")?));
        return Ok("yes".to_string());
    }
    Ok(answer)
}

pub fn confirm(text: &str) -> Result<bool, String> {
    note("asked.txt", text)?;
    Ok(next_answer()? == "yes")
}

pub fn show_words(words: &str) -> Result<bool, String> {
    note("asked.txt", &format!("WORDS {words}"))?;
    Ok(next_answer()? == "yes")
}

pub fn save_as(prompt: &str, name: &str) -> Result<Option<PathBuf>, String> {
    note("asked.txt", &format!("SAVE {prompt} {name}"))?;
    Ok(next_answer()?.strip_prefix("save ").map(PathBuf::from))
}

pub fn choose_folder(prompt: &str) -> Result<Option<PathBuf>, String> {
    note("asked.txt", &format!("FOLDER {prompt}"))?;
    Ok(next_answer()?.strip_prefix("folder ").map(PathBuf::from))
}

pub fn open_url(url: &str) -> Result<(), String> {
    note("opened.txt", url)
}

pub fn computer_name() -> Option<String> {
    Some("Test Computer".to_string())
}
