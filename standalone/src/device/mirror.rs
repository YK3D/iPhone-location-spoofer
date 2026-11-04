//! More than one iPhone at a time: extra phones ("mirrors") follow the main one.
//!
//! The player only ever talks to the main phone (through `DeviceManager`). Every position it sends
//! is also handed to each mirror, which sends it from its own task: a slow or lost mirror never
//! holds up playback on the main phone. A mirror that is behind skips straight to the newest
//! position, and a mirror that stops answering is marked as lost (the others keep going) until it
//! is removed. Same behaviour as the browser version's `mirrors.py`.

use super::{idev::IdeviceDriver, mock::MockDriver, DeviceInfo};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

const SEND_TIMEOUT: Duration = Duration::from_secs(20);

/// The connection a mirror owns: a real iPhone or a simulated one.
pub enum Backend {
    Idevice(IdeviceDriver),
    Mock(MockDriver),
}

impl Backend {
    async fn set(&mut self, lat: f64, lon: f64) -> Result<(), String> {
        match self {
            Self::Idevice(d) => d.set_location(lat, lon).await,
            Self::Mock(d) => d.set_location(lat, lon),
        }
    }
    async fn clear(&mut self) -> Result<(), String> {
        match self {
            Self::Idevice(d) => d.clear_location().await,
            Self::Mock(d) => d.clear_location(),
        }
    }
    async fn disconnect(&mut self) {
        match self {
            Self::Idevice(d) => d.disconnect().await,
            Self::Mock(d) => d.info = None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Cmd {
    Idle,
    Set(f64, f64),
    Clear,
    Close { clear: bool },
}

/// What the mirror's task reports back.
#[derive(Default)]
pub struct Shared {
    pub error: Option<String>,
    pub sent: usize,
    /// the last position this phone accepted (None after a clear)
    pub location: Option<(f64, f64)>,
    pub history: usize,
    done_seq: u64,
    /// test hooks: a delay before each send, and every send failing
    pub delay_ms: u64,
    pub fail: bool,
}

pub struct Mirror {
    pub info: DeviceInfo,
    tx: watch::Sender<(u64, Cmd)>,
    seq: u64,
    pub shared: Arc<Mutex<Shared>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Mirror {
    pub fn start(info: DeviceInfo, backend: Backend) -> Self {
        let (tx, rx) = watch::channel((0, Cmd::Idle));
        let shared = Arc::new(Mutex::new(Shared::default()));
        let task = tokio::spawn(run(backend, rx, shared.clone()));
        Self { info, tx, seq: 0, shared, task: Some(task) }
    }

    pub fn lost(&self) -> bool {
        self.shared.lock().unwrap().error.is_some()
    }

    fn push(&mut self, cmd: Cmd) {
        self.seq += 1;
        self.tx.send_replace((self.seq, cmd)); // replaces a position the task has not sent yet
    }

    pub fn push_set(&mut self, lat: f64, lon: f64) {
        if !self.lost() {
            self.push(Cmd::Set(lat, lon));
        }
    }

    pub fn push_clear(&mut self) {
        if !self.lost() {
            self.push(Cmd::Clear);
        }
    }

    /// Waits until the newest position has been sent (or the phone is lost).
    pub async fn settle(&self, max: Duration) {
        let end = tokio::time::Instant::now() + max;
        loop {
            {
                let s = self.shared.lock().unwrap();
                if s.error.is_some() || s.done_seq >= self.seq {
                    return;
                }
            }
            if tokio::time::Instant::now() > end {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Stops following; with `clear`, the phone goes back to its real location first.
    pub async fn close(mut self, clear: bool) {
        if clear {
            self.settle(Duration::from_secs(2)).await;
        }
        self.push(Cmd::Close { clear });
        if let Some(t) = self.task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(15), t).await;
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        let mut v = serde_json::to_value(&self.info).unwrap_or_default();
        let err = self.shared.lock().unwrap().error.clone();
        v["state"] = serde_json::json!(if err.is_some() { "lost" } else { "ok" });
        v["error"] = serde_json::json!(err);
        v
    }
}

async fn run(mut backend: Backend, mut rx: watch::Receiver<(u64, Cmd)>, shared: Arc<Mutex<Shared>>) {
    loop {
        if rx.changed().await.is_err() {
            break; // the mirror was dropped without closing
        }
        let (seq, cmd) = *rx.borrow_and_update();
        let (delay, fail) = {
            let s = shared.lock().unwrap();
            (s.delay_ms, s.fail)
        };
        let res = match cmd {
            Cmd::Idle => Ok(()),
            Cmd::Close { clear } => {
                if clear && shared.lock().unwrap().error.is_none() {
                    let _ = tokio::time::timeout(Duration::from_secs(10), backend.clear()).await;
                    shared.lock().unwrap().location = None;
                }
                break;
            }
            Cmd::Set(..) | Cmd::Clear => {
                if delay > 0 {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
                let send = async {
                    if fail {
                        return Err("Lost the connection to the iPhone".to_string());
                    }
                    match cmd {
                        Cmd::Set(lat, lon) => backend.set(lat, lon).await,
                        _ => backend.clear().await,
                    }
                };
                match tokio::time::timeout(SEND_TIMEOUT, send).await {
                    Ok(r) => r,
                    Err(_) => Err("The iPhone stopped answering.".to_string()),
                }
            }
        };
        let lost = {
            let mut s = shared.lock().unwrap();
            s.done_seq = seq;
            match res {
                Ok(()) => {
                    match cmd {
                        Cmd::Set(lat, lon) => {
                            s.location = Some((lat, lon));
                            s.history += 1;
                            s.sent += 1;
                        }
                        Cmd::Clear => {
                            s.location = None;
                            s.sent += 1;
                        }
                        _ => {}
                    }
                    false
                }
                Err(e) => {
                    s.error = Some(e);
                    true
                }
            }
        };
        if lost {
            // wait until the mirror is removed, then let go of the connection
            while rx.changed().await.is_ok() {
                if matches!(rx.borrow_and_update().1, Cmd::Close { .. }) {
                    break;
                }
            }
            break;
        }
    }
    backend.disconnect().await;
}
