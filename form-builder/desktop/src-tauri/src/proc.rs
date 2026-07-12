//! DESK-PROC-001 — supervise + terminate the whole local service tree.
//!
//! Two OS-level guarantees, both Windows-specific (the shipped platform;
//! Unix already gets equivalents — CLOEXEC sockets + per-child process groups):
//!
//! 1. **Kill-on-close Job Object.** At startup the desktop creates a Windows
//!    Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and assigns ITSELF
//!    to it. On Windows a child process automatically joins its parent's job,
//!    so every service / plugin / python / llama process the desktop spawns is
//!    captured. When the desktop exits — cleanly OR by a crash — the last job
//!    handle closes and the OS terminates the entire job, so no orphaned child
//!    keeps running (or keeps a port bound). This replaces the manual
//!    four-process kill in the ops runbook.
//!
//! 2. **Non-inheritable listener socket.** The desktop's `:17872` API listener
//!    socket is marked non-inheritable, so a spawned child can never receive a
//!    duplicate of it and wedge the port after the child (or the desktop) dies.
//!    This is the direct fix for the "zombie :17872 socket" gotcha.
//!
//! Both are best-effort: a failure is logged and startup continues (the other
//! guarantee still applies, and on an exotic host the previous behaviour is no
//! worse than before).
//!
//! PROC-001 handle-scoping posture beyond these two: every other handle class
//! this process creates is non-inheritable by default — Rust `std`/`tokio`
//! open files with `bInheritHandle = FALSE`, sockets with
//! `WSA_FLAG_NO_HANDLE_INHERIT`, and child stdio pipes are created
//! non-inheritable with only the child's own ends briefly marked inheritable
//! under std's process-spawn lock. The API listener above gets the explicit
//! belt-and-braces treatment because it predates that guarantee (created by
//! the async stack) and was the one observed wedge; the Job Object is the
//! backstop for anything that still slips through — an inherited handle dies
//! with the job. A stricter `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` allow-list
//! would require hand-rolling `CreateProcessW` (std doesn't expose it on
//! stable) — deliberately not worth that risk while nothing inheritable
//! remains to scope.

#[cfg(windows)]
mod imp {
    use std::os::windows::io::RawSocket;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    /// Holds the job handle for the process lifetime. We never close it — the OS
    /// closes it when the process exits, which is exactly the kill-on-close
    /// trigger. Raw HANDLE isn't Send/Sync, but we only ever store it once and
    /// never touch it again, so sharing it across threads is sound.
    ///
    /// The field is deliberately never read: keeping it OWNED (unclosed) for the
    /// process lifetime IS its whole job — dropping/closing it early would fire
    /// kill-on-close prematurely.
    #[allow(dead_code)]
    struct JobHandle(HANDLE);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    static JOB: OnceLock<JobHandle> = OnceLock::new();

    pub fn install_kill_on_close_group() -> Result<(), String> {
        if JOB.get().is_some() {
            return Ok(()); // idempotent
        }
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err("CreateJobObjectW returned null".to_string());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err("SetInformationJobObject(kill-on-close) failed".to_string());
            }
            if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
                // Most commonly: already inside a job that forbids nesting (rare
                // on Win10/11, which allows nested jobs). Not fatal — the
                // non-inheritable socket below still frees the port on exit.
                return Err(
                    "AssignProcessToJobObject failed (already in a non-nestable job?)".to_string(),
                );
            }
            let _ = JOB.set(JobHandle(job));
        }
        Ok(())
    }

    pub fn set_socket_non_inheritable(sock: RawSocket) -> Result<(), String> {
        // SetHandleInformation takes a HANDLE; a SOCKET is a valid handle here.
        let handle = sock as HANDLE;
        if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
            return Err("SetHandleInformation(HANDLE_FLAG_INHERIT, 0) failed".to_string());
        }
        Ok(())
    }

    /// Test helper: is `process` running inside a job? (`IsProcessInJob` with a
    /// null job tests membership in the caller's job.)
    #[cfg(test)]
    pub fn process_is_in_a_job(process: &std::process::Child) -> bool {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        let mut in_job = 0i32;
        let ok = unsafe {
            IsProcessInJob(
                process.as_raw_handle() as HANDLE,
                std::ptr::null_mut(),
                &mut in_job,
            )
        };
        ok != 0 && in_job != 0
    }
}

#[cfg(windows)]
pub use imp::{install_kill_on_close_group, set_socket_non_inheritable};

/// Non-Windows: Unix already puts each service in its own process group
/// (`Command::process_group`) and its sockets are CLOEXEC by default, so this
/// is a no-op. Kept as a stable cross-platform entry point.
#[cfg(not(windows))]
pub fn install_kill_on_close_group() -> Result<(), String> {
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn kill_on_close_group_installs_idempotently_and_captures_children() {
        let first = install_kill_on_close_group();
        // Idempotent: a second call must agree with the first and never panic.
        let second = install_kill_on_close_group();
        assert_eq!(first.is_ok(), second.is_ok());

        if first.is_err() {
            // A constrained host (already inside a non-nestable job) — nothing
            // more to assert; the non-inheritable socket still applies.
            return;
        }

        // A child spawned after we joined the job is auto-captured by it.
        let mut child = std::process::Command::new("cmd")
            .args(["/c", "ping -n 2 127.0.0.1 >NUL"])
            .spawn()
            .expect("spawn a short-lived child");
        let captured = imp::process_is_in_a_job(&child);
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            captured,
            "a child spawned by the desktop should be captured by the kill-on-close job"
        );
    }
}
