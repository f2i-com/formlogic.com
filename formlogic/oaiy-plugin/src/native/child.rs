//! A window that is another program (`osascript` on a Mac), run so that it can be ended.
//!
//! A child is not ended with its parent there, and OAIY ends nothing more of a plugin that exits
//! when it is told to: it signals the plugin's group only when it has to kill it. So a window
//! still open when the plugin stopped stayed on the screen with nobody behind it. Answering it did
//! nothing, and the twelve words stayed up until someone closed them. A child that is running is
//! kept here, and [`end`] ends it before the plugin exits.

use std::io::{self, Read, Write as _};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Mutex, MutexGuard};

/// The windows open now, by process id. There is one at a time (`native::one_window`), but
/// nothing here depends on it.
static OPEN: Mutex<Vec<(u32, Child)>> = Mutex::new(Vec::new());

/// Tests that open a window take turns, because [`end`] ends whichever is open.
#[cfg(test)]
pub static ONE_TEST: Mutex<()> = Mutex::new(());

fn open() -> MutexGuard<'static, Vec<(u32, Child)>> {
    OPEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_all(pipe: Option<impl Read>) -> Vec<u8> {
    let mut bytes = Vec::new();
    if let Some(mut pipe) = pipe {
        let _ = pipe.read_to_end(&mut bytes);
    }
    bytes
}

/// Runs `command` with `input` on its stdin and waits for it, as `Command::output` does, but where
/// [`end`] can reach it meanwhile.
pub fn output(mut command: Command, input: &[u8]) -> io::Result<Output> {
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let (stdin, stdout, stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let id = child.id();
    open().push((id, child));
    // Both pipes are read at once, so a child that fills one is not left waiting on the other.
    let errors = std::thread::spawn(move || read_all(stderr));
    // Let go of once written: the end of its input is how the child knows it has all of it.
    let written = stdin.map_or(Ok(()), |mut stdin| stdin.write_all(input));
    let said = read_all(stdout);
    let errors = errors.join().unwrap_or_default();
    let kept = {
        let mut windows = open();
        windows.iter().position(|(pid, _)| *pid == id).map(|at| windows.swap_remove(at).1)
    };
    let mut child = kept.ok_or_else(|| io::Error::other("the window was lost"))?;
    let status = child.wait()?;
    written?;
    Ok(Output { status, stdout: said, stderr: errors })
}

/// Ends every window that is open.
pub fn end() {
    for (_, child) in open().iter_mut() {
        let _ = child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// A program that stays for half a minute, as a window does until somebody answers it.
    fn waiting() -> Command {
        let mut command = Command::new("ping");
        command.args([if cfg!(windows) { "-n" } else { "-c" }, "30", "127.0.0.1"]);
        command
    }

    #[test]
    fn a_window_gives_its_answer_and_one_still_open_is_ended_with_the_plugin() {
        let _turn = ONE_TEST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // Nothing open: nothing to end.
        end();

        // `sort` gives back the line it was sent, as a window gives back what was chosen.
        let answered = output(Command::new("sort"), b"chosen\n").unwrap();
        assert!(answered.status.success());
        assert_eq!(String::from_utf8_lossy(&answered.stdout).trim(), "chosen");
        assert!(open().is_empty(), "a window that closed is no longer kept");

        let started = Instant::now();
        let asking = std::thread::spawn(|| output(waiting(), b""));
        while open().is_empty() {
            assert!(started.elapsed() < Duration::from_secs(10), "the window never opened");
            std::thread::sleep(Duration::from_millis(10));
        }
        end();
        let ended = asking.join().unwrap().unwrap();
        assert!(!ended.status.success(), "a window that was ended is not an answer");
        assert!(started.elapsed() < Duration::from_secs(20), "it was ended, not waited for");
        assert!(open().is_empty());
    }
}
