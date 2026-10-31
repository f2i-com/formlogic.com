//! The plugin's windows on Windows. The browser is opened with `ShellExecuteW`, because going
//! through `cmd /c start` would cut the address at its first `&`.

use std::path::PathBuf;

use windows_sys::Win32::System::SystemInformation::{ComputerNameDnsHostname, GetComputerNameExW};
use windows_sys::Win32::UI::Controls::Dialogs::{GetSaveFileNameW, OFN_EXPLORER, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST, OPENFILENAMEW};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDOK, MB_DEFBUTTON2, MB_ICONWARNING, MB_OKCANCEL, MB_SETFOREGROUND, MB_TOPMOST, SW_SHOWNORMAL};

pub const CAN_ASK: bool = true;

const TITLE: &str = "FormLogic Backups";

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A box in front of everything else, with Cancel as the button Enter presses.
fn ask(text: &str) -> bool {
    let (text, title) = (wide(text), wide(TITLE));
    // SAFETY: both strings end in a nul and outlive the call, and a null owner is allowed.
    let answer = unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2 | MB_TOPMOST | MB_SETFOREGROUND) };
    answer == IDOK
}

pub fn confirm(text: &str) -> Result<bool, String> {
    Ok(ask(text))
}

pub fn show_words(words: &str) -> Result<bool, String> {
    Ok(ask(&format!(
        "Write these twelve words down and keep them safe.\n\n{words}\n\nThey are the only way to open your backups on another computer. They won't be shown again, and they are not saved anywhere.\n\nPress OK once you have written them down. Cancel keeps nothing."
    )))
}

pub fn save_as(prompt: &str, name: &str) -> Result<Option<PathBuf>, String> {
    let mut path = vec![0u16; 4096];
    let suggested = wide(name);
    if suggested.len() > path.len() {
        return Err("That name is too long.".to_string());
    }
    path[..suggested.len()].copy_from_slice(&suggested);
    let (title, filter) = (wide(prompt), wide("Zip files\0*.zip\0"));
    let extension = wide("zip");
    // SAFETY: OPENFILENAMEW is plain data, and all zeros is its documented starting point.
    let mut dialog: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    dialog.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    dialog.lpstrFile = path.as_mut_ptr();
    dialog.nMaxFile = path.len() as u32;
    dialog.lpstrTitle = title.as_ptr();
    dialog.lpstrFilter = filter.as_ptr();
    dialog.lpstrDefExt = extension.as_ptr();
    dialog.Flags = OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    // SAFETY: every pointer in `dialog` is to a buffer above that outlives the call.
    let chosen = unsafe { GetSaveFileNameW(&mut dialog) } != 0;
    if !chosen {
        return Ok(None);
    }
    let end = path.iter().position(|unit| *unit == 0).unwrap_or(path.len());
    Ok(Some(PathBuf::from(String::from_utf16_lossy(&path[..end]))))
}

pub fn open_url(url: &str) -> Result<(), String> {
    let (verb, url) = (wide("open"), wide(url));
    // SAFETY: both strings end in a nul and outlive the call; the other pointers may be null.
    let result = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), url.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
    if result as usize > 32 {
        Ok(())
    } else {
        Err("Could not open your browser.".to_string())
    }
}

pub fn computer_name() -> Option<String> {
    let mut name = [0u16; 256];
    let mut length = name.len() as u32;
    // SAFETY: `name` holds `length` units, and the call writes no more than that.
    let found = unsafe { GetComputerNameExW(ComputerNameDnsHostname, name.as_mut_ptr(), &mut length) } != 0;
    found.then(|| String::from_utf16_lossy(&name[..length as usize]))
}

/// The real windows, opened and answered by another thread as a person would: they show on the
/// desktop for a moment. `cargo test windows_ -- --ignored --test-threads=1`.
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, PostMessageW, IDCANCEL, WM_COMMAND};

    /// Presses a button of the window with this title, once it appears.
    fn press(title: &str, button: i32) -> (std::thread::JoinHandle<()>, Arc<AtomicBool>) {
        let title = wide(title);
        let found = Arc::new(AtomicBool::new(false));
        let seen = found.clone();
        let thread = std::thread::spawn(move || {
            for _ in 0..500 {
                // SAFETY: the title ends in a nul and outlives the call.
                let window: HWND = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
                if !window.is_null() {
                    seen.store(true, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    // SAFETY: a window handle just found; a stale one only makes the post fail.
                    unsafe { PostMessageW(window, WM_COMMAND, button as usize, 0) };
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        });
        (thread, found)
    }

    #[test]
    #[ignore = "opens real windows on the desktop"]
    fn windows_a_confirmation_says_yes_only_to_ok() {
        let (thread, found) = press(TITLE, IDOK);
        assert!(confirm("A test of FormLogic Backups. It closes itself.").unwrap());
        thread.join().unwrap();
        assert!(found.load(Ordering::SeqCst));

        let (thread, _) = press(TITLE, IDCANCEL);
        assert!(!confirm("A test of FormLogic Backups. It closes itself.").unwrap());
        thread.join().unwrap();
    }

    #[test]
    #[ignore = "opens real windows on the desktop"]
    fn windows_closing_the_words_window_keeps_nothing() {
        let (thread, _) = press(TITLE, IDCANCEL);
        assert!(!show_words("not real words").unwrap());
        thread.join().unwrap();
    }

    #[test]
    #[ignore = "opens real windows on the desktop"]
    fn windows_cancelling_the_save_window_chooses_nothing() {
        let prompt = "A test of FormLogic Backups. It closes itself.";
        let (thread, found) = press(prompt, IDCANCEL);
        assert_eq!(save_as(prompt, "test.zip").unwrap(), None);
        thread.join().unwrap();
        assert!(found.load(Ordering::SeqCst));
    }

    #[test]
    fn windows_this_computer_has_a_name() {
        assert!(computer_name().is_some_and(|name| !name.is_empty()));
    }
}
