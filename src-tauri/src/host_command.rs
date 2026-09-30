use crate::{with_manager, PluginManager};
use buzzodz_plugins::HostCommand;
use std::ffi::{OsStr, OsString};
#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

#[cfg(windows)]
mod windows_job {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use tokio::process::{Child, Command};
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenThread, ResumeThread, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
    };

    pub(super) struct WindowsJob(OwnedHandle);

    impl WindowsJob {
        pub(super) fn new() -> Option<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return None;
            }
            let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job.0.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            };
            if configured == 0 {
                return None;
            }
            Some(job)
        }

        pub(super) fn assign(&self, child: &Child) -> bool {
            child.raw_handle().is_some_and(|handle| unsafe {
                AssignProcessToJobObject(self.0.as_raw_handle(), handle) != 0
            })
        }

        pub(super) fn spawn(&self, command: &mut Command) -> Option<Child> {
            self.spawn_with_check(command, |_, _| {})
        }

        pub(super) fn spawn_with_check(
            &self,
            command: &mut Command,
            check: impl FnOnce(&Child, &OwnedHandle),
        ) -> Option<Child> {
            command.creation_flags(CREATE_SUSPENDED).kill_on_drop(true);
            let child = command.spawn().ok()?;
            let primary_thread = primary_thread(child.id()?)?;
            check(&child, &primary_thread);
            if !self.assign(&child) {
                return None;
            }
            if unsafe { ResumeThread(primary_thread.as_raw_handle()) } != 1 {
                return None;
            }
            Some(child)
        }
    }

    fn primary_thread(process_id: u32) -> Option<OwnedHandle> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        if unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } == 0 {
            return None;
        }
        let mut thread_id = None;
        loop {
            if entry.th32OwnerProcessID == process_id
                && thread_id.replace(entry.th32ThreadID).is_some()
            {
                return None;
            }
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            if unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } == 0 {
                break;
            }
        }
        if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
            return None;
        }
        let handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id?) };
        if handle.is_null() {
            return None;
        }
        Some(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
}

const MAX_OUTPUT_BYTES: u64 = 4096;
const DEADLINE: Duration = Duration::from_secs(5);

// Tokio kills only the direct child on future cancellation; the group also owns descendants.
#[cfg(unix)]
struct ProcessGroupGuard {
    process_id: i32,
    armed: bool,
}

#[cfg(unix)]
impl ProcessGroupGuard {
    fn kill(&self) {
        unsafe { libc::kill(-self.process_id, libc::SIGKILL) };
    }
}

#[cfg(unix)]
impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        if self.armed {
            self.kill();
        }
    }
}

#[tauri::command]
pub(crate) async fn plugin_host_run_command(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    command_id: String,
) -> Result<Option<String>, String> {
    let operation = async {
        let command = with_manager(manager, move |manager| {
            manager
                .host_grants(&id, &revision)?
                .commands
                .into_iter()
                .find(|command| command.id == command_id)
                .ok_or_else(|| "Command is not declared".into())
        })
        .await
        .ok()?;
        run_command(&command, DEADLINE).await
    };
    Ok(tokio::time::timeout(DEADLINE, operation)
        .await
        .ok()
        .flatten())
}

pub(crate) fn effective_path() -> OsString {
    let path = std::env::var_os("PATH").unwrap_or_default();
    #[cfg(target_os = "macos")]
    {
        let path = if path.is_empty() {
            OsString::from("/usr/bin:/bin")
        } else {
            path
        };
        let mut directories = std::env::split_paths(&path)
            .filter(|directory| !directory.as_os_str().is_empty())
            .collect::<Vec<_>>();
        directories.extend(["/opt/homebrew/bin".into(), "/usr/local/bin".into()]);
        std::env::join_paths(directories).unwrap_or(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        path
    }
}

pub(crate) fn resolve_program(program: &str, effective_path: &OsStr) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;

        if let Some(executable) = std::env::split_paths(effective_path)
            .map(|path| path.join(program))
            .find(|path| {
                std::fs::metadata(path).is_ok_and(|metadata| {
                    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
                })
            })
        {
            return executable;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = effective_path;
    PathBuf::from(program)
}

async fn run_command(command: &HostCommand, deadline: Duration) -> Option<String> {
    let path = effective_path();
    run(
        &resolve_program(&command.program, &path),
        &command.args,
        deadline,
        &path,
    )
    .await
}

async fn run(
    executable: &Path,
    args: &[String],
    deadline: Duration,
    path: &OsStr,
) -> Option<String> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if !path.is_empty() {
        command.env("PATH", path);
    }
    #[cfg(unix)]
    command.as_std_mut().process_group(0);

    #[cfg(windows)]
    let _job = windows_job::WindowsJob::new()?;
    #[cfg(windows)]
    let mut child = _job.spawn(&mut command)?;
    #[cfg(not(windows))]
    let mut child = command.spawn().ok()?;
    #[cfg(unix)]
    let mut process_group = ProcessGroupGuard {
        process_id: child.id()? as i32,
        armed: true,
    };
    let stdout = child.stdout.take()?;
    let output = tokio::time::timeout(deadline, async {
        let mut bytes = Vec::new();
        stdout
            .take(MAX_OUTPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .await
            .ok()?;
        if bytes.len() as u64 > MAX_OUTPUT_BYTES {
            return None;
        }
        let status = child.wait().await.ok()?;
        #[cfg(unix)]
        {
            process_group.armed = false;
        }
        Some((bytes, status.success()))
    })
    .await;

    if let Ok(Some((bytes, success))) = output {
        return if success {
            String::from_utf8(bytes).ok()
        } else {
            None
        };
    }

    #[cfg(unix)]
    process_group.kill();
    let _ = child.start_kill();
    let _ = child.wait().await;
    #[cfg(unix)]
    {
        process_group.armed = false;
    }
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::{effective_path, run as run_with_path};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    async fn run(executable: &Path, args: &[String], deadline: Duration) -> Option<String> {
        run_with_path(executable, args, deadline, &effective_path()).await
    }

    fn executable(script: &str) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tool");
        fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        (directory, path)
    }

    #[tokio::test]
    async fn passes_exact_args_without_shell_interpretation() {
        let (_directory, path) = executable(
            "[ \"$#\" -eq 2 ] && [ \"$1\" = status ] && [ \"$2\" = '--mode=ready;echo injected' ] || exit 1\nprintf 'ready \\n'",
        );
        assert_eq!(
            run(
                &path,
                &["status".into(), "--mode=ready;echo injected".into()],
                Duration::from_secs(1)
            )
            .await,
            Some("ready \n".into())
        );
    }

    #[tokio::test]
    async fn env_shebang_uses_the_path_that_resolved_the_command() {
        let directory = tempfile::tempdir().unwrap();
        let interpreter = directory.path().join("fixture-runtime");
        fs::write(&interpreter, "#!/bin/sh\nexec /bin/sh \"$@\"\n").unwrap();
        fs::set_permissions(&interpreter, fs::Permissions::from_mode(0o700)).unwrap();
        let tool = directory.path().join("tool");
        fs::write(&tool, "#!/usr/bin/env fixture-runtime\nprintf 'ready\\n'\n").unwrap();
        fs::set_permissions(&tool, fs::Permissions::from_mode(0o700)).unwrap();
        let path =
            std::env::join_paths([Path::new("/usr/bin"), Path::new("/bin"), directory.path()])
                .unwrap();

        #[cfg(target_os = "macos")]
        assert_eq!(super::resolve_program("tool", &path), tool);
        assert_eq!(
            run_with_path(&tool, &[], Duration::from_secs(5), &path).await,
            Some("ready\n".into())
        );
    }

    #[tokio::test]
    async fn returns_none_for_failures_and_invalid_utf8() {
        let (_directory, path) = executable("echo 'private stderr' >&2; exit 1");
        assert_eq!(run(&path, &[], Duration::from_secs(1)).await, None);
        let (_directory, path) = executable("printf '\\377'");
        assert_eq!(run(&path, &[], Duration::from_secs(1)).await, None);
        assert_eq!(
            run(
                PathBuf::from("missing-tool-executable").as_path(),
                &[],
                Duration::from_secs(1)
            )
            .await,
            None
        );
    }

    #[tokio::test]
    async fn rejects_large_output_without_waiting_for_the_process() {
        let (_directory, path) = executable("yes x");
        let started = Instant::now();
        assert_eq!(run(&path, &[], Duration::from_secs(1)).await, None);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn kills_a_stalled_command_at_the_deadline() {
        let (_directory, path) = executable("sleep 10");
        let started = Instant::now();
        assert_eq!(run(&path, &[], Duration::from_millis(50)).await, None);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn aborting_the_read_kills_the_cli_process() {
        let (_directory, path) = executable("printf '%s' \"$$\" > \"$0.pid\"\nexec sleep 10");
        let marker = path.with_extension("pid");
        let reader = tokio::spawn(async move { run(&path, &[], Duration::from_secs(5)).await });
        let process_id = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Ok(process_id) = fs::read_to_string(&marker) {
                    if let Ok(process_id) = process_id.parse::<i32>() {
                        break process_id;
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fake command did not start");

        reader.abort();
        assert!(reader.await.unwrap_err().is_cancelled());
        let exited = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let result =
                    unsafe { libc::waitpid(process_id, std::ptr::null_mut(), libc::WNOHANG) };
                if result == process_id
                    || (result == -1
                        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD))
                {
                    break;
                }
                assert_eq!(result, 0);
                tokio::task::yield_now().await;
            }
        })
        .await;
        if exited.is_err() {
            unsafe { libc::kill(-process_id, libc::SIGKILL) };
            unsafe { libc::waitpid(process_id, std::ptr::null_mut(), 0) };
        }
        assert!(exited.is_ok(), "aborted command left the child running");
    }

    #[tokio::test]
    async fn aborting_the_read_kills_descendants() {
        let (_directory, path) =
            executable("sleep 10 &\nprintf '%s' \"$!\" > \"$0.childpid\"\nwait");
        let marker = path.with_extension("childpid");
        let reader = tokio::spawn(async move { run(&path, &[], Duration::from_secs(5)).await });
        let process_id = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Ok(process_id) = fs::read_to_string(&marker) {
                    if let Ok(process_id) = process_id.parse::<i32>() {
                        break process_id;
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("descendant did not start");

        reader.abort();
        assert!(reader.await.unwrap_err().is_cancelled());
        let exited = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if unsafe { libc::kill(process_id, 0) } == -1
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        if exited.is_err() {
            unsafe { libc::kill(process_id, libc::SIGKILL) };
        }
        assert!(exited.is_ok(), "aborted command left a descendant running");
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::{effective_path, run, windows_job::WindowsJob};
    use std::fs;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::{Path, PathBuf};
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::process::Command;
    use windows_sys::Win32::Foundation::{ERROR_INVALID_PARAMETER, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, ResumeThread, SuspendThread, TerminateProcess, WaitForSingleObject,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    fn command_script(directory: &Path) -> (PathBuf, PathBuf) {
        let script = directory.join("spawn-child.ps1");
        let marker = directory.join("child.pid");
        let marker_literal = marker.to_string_lossy().replace('\'', "''");
        fs::write(
            &script,
            format!(
                "$child = Start-Process -FilePath ping.exe -ArgumentList '-n 30 127.0.0.1' -PassThru -WindowStyle Hidden\n[System.IO.File]::WriteAllText('{marker_literal}', [string]$child.Id)\n$child.WaitForExit()\n"
            ),
        )
        .unwrap();
        (script, marker)
    }

    async fn descendant_id(marker: &Path) -> u32 {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if let Ok(process_id) = fs::read_to_string(marker) {
                    if let Ok(process_id) = process_id.parse::<u32>() {
                        break process_id;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("descendant did not start")
    }

    fn assert_descendant_exited(process_id: u32) {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, process_id) };
        if handle.is_null() {
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(ERROR_INVALID_PARAMETER as i32),
                "failed to inspect descendant"
            );
            return;
        }
        let process = unsafe { OwnedHandle::from_raw_handle(handle) };
        let result = unsafe { WaitForSingleObject(process.as_raw_handle(), 3_000) };
        if result != WAIT_OBJECT_0 {
            unsafe { TerminateProcess(process.as_raw_handle(), 1) };
        }
        assert_eq!(result, WAIT_OBJECT_0, "command left a descendant running");
    }

    #[tokio::test]
    async fn command_starts_only_after_job_assignment() {
        let directory = tempfile::tempdir().unwrap();
        let (script, marker) = command_script(directory.path());
        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                script.to_str().unwrap(),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let job = WindowsJob::new().unwrap();
        let child = job
            .spawn_with_check(&mut command, |_, thread| {
                let previous_count = unsafe { SuspendThread(thread.as_raw_handle()) };
                let restored_count = unsafe { ResumeThread(thread.as_raw_handle()) };
                assert_eq!(previous_count, 1, "command ran before job assignment");
                assert_eq!(restored_count, 2);
                assert!(!marker.exists(), "command ran before job assignment");
            })
            .unwrap();
        let process_id = descendant_id(&marker).await;
        drop(job);
        assert_descendant_exited(process_id);
        drop(child);
    }

    #[tokio::test]
    async fn cancellation_kills_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let (script, marker) = command_script(directory.path());
        let reader = tokio::spawn(async move {
            run(
                Path::new("powershell.exe"),
                &[
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-File".into(),
                    script.to_string_lossy().into_owned(),
                ],
                Duration::from_secs(10),
                &effective_path(),
            )
            .await
        });
        let process_id = descendant_id(&marker).await;
        reader.abort();
        assert!(reader.await.unwrap_err().is_cancelled());
        assert_descendant_exited(process_id);
    }

    #[tokio::test]
    async fn timeout_kills_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let (script, marker) = command_script(directory.path());
        let reader = tokio::spawn(async move {
            run(
                Path::new("powershell.exe"),
                &[
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-File".into(),
                    script.to_string_lossy().into_owned(),
                ],
                Duration::from_secs(5),
                &effective_path(),
            )
            .await
        });
        let process_id = descendant_id(&marker).await;
        assert_eq!(reader.await.unwrap(), None);
        assert_descendant_exited(process_id);
    }
}
