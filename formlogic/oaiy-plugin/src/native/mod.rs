//! Windows of the plugin's own, which only the person at this computer can answer.
//!
//! OAIY's commands can come from a flow, an app script or the agent as well as the plugin's page,
//! so a command can't tell who is asking. A confirmation here can: nothing a caller sends can press
//! its button. The twelve words are shown here too, so they are never in a command's answer.
//!
//! One window at a time, so a caller can't stack them up. Where no window can be shown (OAIY gives a
//! plugin on Linux no display) what needs one is refused, and says so.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, TryLockError};

// Only a Mac's windows are another program. Built for the tests everywhere, so what it does is
// checked on whichever system they run on.
#[cfg(any(test, all(not(feature = "scripted-dialogs"), target_os = "macos")))]
mod child;
#[cfg(all(not(feature = "scripted-dialogs"), target_os = "macos"))]
#[path = "macos.rs"]
mod system;
#[cfg(all(not(feature = "scripted-dialogs"), not(any(windows, target_os = "macos"))))]
#[path = "other.rs"]
mod system;
#[cfg(feature = "scripted-dialogs")]
#[path = "scripted.rs"]
mod system;
#[cfg(all(not(feature = "scripted-dialogs"), windows))]
#[path = "windows.rs"]
mod system;

static ONE_WINDOW: Mutex<()> = Mutex::new(());

fn one_window() -> Result<MutexGuard<'static, ()>, String> {
    match ONE_WINDOW.try_lock() {
        Ok(held) => Ok(held),
        Err(TryLockError::Poisoned(held)) => Ok(held.into_inner()),
        Err(TryLockError::WouldBlock) => Err("FormLogic Backups is already asking you something. Answer that window first.".to_string()),
    }
}

/// Whether this computer can show the plugin's windows.
pub fn can_ask() -> bool {
    system::CAN_ASK
}

/// Asks the person. `true` only if they said yes. A window can open with nothing on the screen
/// to explain it, when it was a flow or a script that asked, so each one says what to do then.
pub fn confirm(text: &str) -> Result<bool, String> {
    let _held = one_window()?;
    system::confirm(&format!("{text}\n\nIf you didn't ask for this, cancel it."))
}

/// Shows the twelve words. `true` once the person says they have them.
pub fn show_words(words: &str) -> Result<bool, String> {
    let _held = one_window()?;
    system::show_words(words)
}

/// Asks where to save a file. `None` if the person closes the window.
pub fn save_as(prompt: &str, name: &str) -> Result<Option<PathBuf>, String> {
    let _held = one_window()?;
    system::save_as(prompt, name)
}

/// Asks which folder to use. `None` if the person closes the window.
pub fn choose_folder(prompt: &str) -> Result<Option<PathBuf>, String> {
    let _held = one_window()?;
    system::choose_folder(prompt)
}

/// How long OAIY is given to say it opened a page: it starts the browser and answers at once.
#[cfg(windows)]
const OAIY_OPENS_WITHIN: std::time::Duration = std::time::Duration::from_secs(10);

/// Opens the person's browser, for a web address and nothing else.
///
/// On Windows the plugin runs inside the job OAIY ends when it exits, and a browser the plugin
/// starts itself is in that job: one first started by Connect was closed when OAIY was, with every
/// tab the person had opened in it since. So OAIY opens it, from its own process, where it says it
/// can (`oaiy.browser.open`). Where it does not, or asking fails, the plugin opens it itself, as it
/// always did.
pub fn open_url(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("That isn't a web address.".to_string());
    }
    #[cfg(windows)]
    if crate::host::OAIY.answers(crate::host::BROWSER_OPEN)
        && crate::host::OAIY.ask(crate::host::BROWSER_OPEN, serde_json::json!({"url": url}), OAIY_OPENS_WITHIN).is_ok()
    {
        return Ok(());
    }
    system::open_url(url)
}

/// Closes a window that is still open, for when the plugin stops. On Windows a window is the
/// plugin's own and goes with it. On a Mac it is another program, which would stay on the screen
/// with nobody to answer to (see `child.rs`).
pub fn close_windows() {
    #[cfg(all(not(feature = "scripted-dialogs"), target_os = "macos"))]
    child::end();
}

/// This computer's name, for FormLogic's list of what is linked.
pub fn computer_name() -> Option<String> {
    system::computer_name().map(|name| name.trim().to_string()).filter(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_web_address_reaches_the_system() {
        for url in ["file:///etc/passwd", "javascript:alert(1)", "calc.exe", "ms-settings:", ""] {
            assert_eq!(open_url(url), Err("That isn't a web address.".to_string()), "{url}");
        }
    }

    #[test]
    fn a_second_window_is_refused_while_one_is_open() {
        let held = one_window().unwrap();
        assert!(one_window().unwrap_err().contains("already asking"));
        drop(held);
        assert!(one_window().is_ok());
    }
}
