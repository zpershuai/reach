use super::*;

#[cfg(unix)]
pub(super) fn signal_group(pid: u32, signal: i32) {
    unsafe extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe {
        kill(-(pid as i32), signal);
    }
}
#[cfg(not(unix))]
pub(super) fn signal_group(_pid: u32, _signal: i32) {}
#[derive(Clone, Copy, PartialEq, Eq)]
enum SignalPhase {
    Running,
    TermSent,
    KillSent,
}

pub(super) fn supervise(
    child: &mut Child,
    task: &Arc<Mutex<Task>>,
    timeout: Duration,
    grace: Duration,
) {
    let started = Instant::now();
    let mut phase = SignalPhase::Running;
    loop {
        // Do not reap the leader until all required group signaling completes:
        // its PID/group identity cannot be recycled while still owned here.
        let mut t = match task.lock() {
            Ok(task) => task,
            Err(_) => {
                signal_group(child.id(), 9);
                let _ = child.wait();
                return;
            }
        };
        if started.elapsed() >= timeout && t.stop.is_none() {
            t.stop = Some(Instant::now());
            t.timed_out = true;
            t.status.state = "stopping".into();
        }
        if let Some(at) = t.stop {
            if phase == SignalPhase::Running {
                signal_group(child.id(), 15);
                phase = SignalPhase::TermSent;
            }
            if at.elapsed() >= grace && phase != SignalPhase::KillSent {
                signal_group(child.id(), 9);
                phase = SignalPhase::KillSent;
            }
            if phase != SignalPhase::KillSent {
                drop(t);
                thread::sleep(Duration::from_millis(10));
                continue;
            }
        }
        #[cfg(unix)]
        let ready = {
            use rustix::process::{waitid, Pid, WaitId, WaitIdOptions};
            waitid(
                WaitId::Pid(Pid::from_raw(child.id() as i32).unwrap()),
                WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
            )
            .map(|status| status.is_some())
        };
        #[cfg(not(unix))]
        let ready: std::io::Result<bool> = Ok(false);
        match ready {
            Ok(false) => {
                drop(t);
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            Err(_) => {
                signal_group(child.id(), 9);
            }
            Ok(true) => {
                if phase == SignalPhase::Running {
                    signal_group(child.id(), 9);
                }
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                // A naturally exited leader may leave ordinary descendants.
                // Group cleanup happens before this terminal record is exposed.
                t.status.exit_code = status.code();
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    t.status.signal = status.signal();
                }
                t.status.state = if t.timed_out {
                    "timed_out"
                } else if t.stop.is_some() {
                    "stopped"
                } else {
                    "exited"
                }
                .into();
                t.status.ended_at = Some(timestamp());
                break;
            }
            Ok(None) => {}
            Err(_) => {
                t.status.state = "failed".into();
                t.status.reason = Some("PROCESS_WAIT_FAILED".into());
                signal_group(child.id(), 9);
                let _ = child.wait();
                break;
            }
        }
        drop(t);
        thread::sleep(Duration::from_millis(10));
    }
}
