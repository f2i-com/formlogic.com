//! The plugin's windows on a Mac, through `osascript`, called by its full path because OAIY's PATH
//! for a plugin is not one to trust. The script goes in on stdin and not as an argument, so the
//! twelve words never appear in a process listing.

use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

pub const CAN_ASK: bool = true;

const TITLE: &str = "FormLogic Backups";
/// How `osascript` says the person cancelled, as against anything else going wrong.
const CANCELLED: &str = "-128";
/// UTF-8. OAIY's environment for a plugin leaves this out, and without it the script and what comes
/// back are read in the system's old encoding, which garbles an app's name or a chosen path.
const TEXT_ENCODING: &str = "0x1F5:0x8000100:0x8000100";

/// A string for AppleScript.
fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\"").replace('\r', " ").replace('\n', "\" & return & \""))
}

fn run(script: &str) -> Result<Output, String> {
    let mut child = Command::new("/usr/bin/osascript")
        .arg("-")
        .env("__CF_USER_TEXT_ENCODING", TEXT_ENCODING)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not show a window: {e}"))?;
    child.stdin.take().ok_or("Could not show a window.")?.write_all(script.as_bytes()).map_err(|e| format!("Could not show a window: {e}"))?;
    child.wait_with_output().map_err(|e| format!("Could not show a window: {e}"))
}

/// `true` if the script ran through, `false` if the person cancelled, and an error otherwise: a
/// window that never showed isn't an answer.
fn finished(output: &Output) -> Result<bool, String> {
    if output.status.success() {
        return Ok(true);
    }
    let said = String::from_utf8_lossy(&output.stderr);
    if said.contains(CANCELLED) {
        Ok(false)
    } else {
        Err(format!("Could not show a window: {}", said.trim()))
    }
}

fn ask(text: &str, yes: &str) -> Result<bool, String> {
    let script = format!(
        "activate\ndisplay dialog {} with title {} buttons {{\"Cancel\", {}}} default button \"Cancel\" cancel button \"Cancel\" with icon caution\n",
        quoted(text),
        quoted(TITLE),
        quoted(yes),
    );
    finished(&run(&script)?)
}

pub fn confirm(text: &str) -> Result<bool, String> {
    ask(text, "Continue")
}

pub fn show_words(words: &str) -> Result<bool, String> {
    ask(
        &format!("Write these twelve words down and keep them safe.\n\n{words}\n\nThey are the only way to open your backups on another computer. They won't be shown again, and they are not saved anywhere."),
        "I have written them down",
    )
}

pub fn save_as(prompt: &str, name: &str) -> Result<Option<PathBuf>, String> {
    let script = format!("activate\nPOSIX path of (choose file name with prompt {} default name {})\n", quoted(prompt), quoted(name));
    let output = run(&script)?;
    if !finished(&output)? {
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!path.is_empty()).then(|| PathBuf::from(path)))
}

pub fn choose_folder(prompt: &str) -> Result<Option<PathBuf>, String> {
    let output = run(&format!("activate\nPOSIX path of (choose folder with prompt {})\n", quoted(prompt)))?;
    if !finished(&output)? {
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!path.is_empty()).then(|| PathBuf::from(path)))
}

pub fn open_url(url: &str) -> Result<(), String> {
    let opened = Command::new("/usr/bin/open").arg(url).status().map_err(|e| format!("Could not open your browser: {e}"))?;
    if opened.success() {
        Ok(())
    } else {
        Err("Could not open your browser.".to_string())
    }
}

pub fn computer_name() -> Option<String> {
    let output = Command::new("/bin/hostname").output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim_end_matches(".local\n").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_cannot_end_the_string_it_is_put_in() {
        assert_eq!(quoted("plain"), "\"plain\"");
        assert_eq!(quoted("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(quoted("one\ntwo"), "\"one\" & return & \"two\"");
    }

    #[test]
    fn the_scripts_compile_and_a_window_that_cannot_open_is_an_error() {
        // No window here: `run script` of an invalid line stands in for a failure that isn't Cancel.
        let output = run("this is not applescript at all (\n").unwrap();
        assert!(finished(&output).is_err());
        assert_eq!(finished(&run("error number -128").unwrap()), Ok(false));
        assert_eq!(finished(&run("return 1").unwrap()), Ok(true));
    }
}
