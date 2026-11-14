//! The link to the paired Mac. One task owns it: while paired, it dials the Mac by key, resumes
//! from the cache's cursor, stores every row and hands it to the UI as `mr-event`, and sends the
//! UI's commands. iOS drops sockets in the background, so a lost link is retried with backoff
//! and resumes from the cursor (no gaps, no repeats).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh::EndpointAddr;
use remote_link::proto::{Command, Frame, Known, Offer};
use remote_link::Peer;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot, watch};

use crate::cache::Cache;

#[derive(Clone, Serialize, Deserialize)]
struct Paired {
    mac: EndpointAddr,
    name: String,
}

#[derive(Default, Clone, Serialize)]
struct Status {
    connected: bool,
    /// Caught up: the backlog is in and rows now arrive as they happen.
    live: bool,
    error: Option<String>,
    known: Known,
}

enum Req {
    Command(Command, oneshot::Sender<Result<Value, String>>),
    Fetch(String),
}

pub struct Remote {
    pub cache: Cache,
    dir: PathBuf,
    paired: Mutex<Option<Paired>>,
    status: Mutex<Status>,
    peer: tokio::sync::Mutex<Option<Arc<Peer>>>,
    reqs: Mutex<Option<mpsc::Sender<Req>>>,
    /// Bumped when pairing changes: the link task drops what it has and looks again.
    kick: watch::Sender<u64>,
}

impl Remote {
    pub fn open(dir: &Path) -> Result<Self, String> {
        let cache = Cache::open(&dir.join("cache.sqlite")).map_err(|e| e.to_string())?;
        let paired = std::fs::read(dir.join("paired.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
        Ok(Self {
            cache,
            dir: dir.to_path_buf(),
            paired: Mutex::new(paired),
            status: Mutex::new(Status::default()),
            peer: tokio::sync::Mutex::new(None),
            reqs: Mutex::new(None),
            kick: watch::channel(0).0,
        })
    }

    pub fn state(&self) -> Value {
        let st = self.status.lock().unwrap().clone();
        serde_json::json!({
            "paired": self.paired.lock().unwrap().as_ref().map(|p| serde_json::json!({ "name": p.name })),
            "connected": st.connected,
            "live": st.live,
            "error": st.error,
            "known": st.known,
        })
    }

    async fn peer(&self) -> Result<Arc<Peer>, String> {
        let mut slot = self.peer.lock().await;
        if let Some(p) = slot.as_ref() {
            return Ok(p.clone());
        }
        // Reading the key may show Face ID on a device: off the async threads.
        let key = tokio::task::spawn_blocking(crate::key::load).await.map_err(|e| e.to_string())??;
        let p = Arc::new(Peer::bind(key, std::env::var("MR_REMOTE_LOCAL").is_ok()).await?);
        *slot = Some(p.clone());
        Ok(p)
    }
}

fn set_status(app: &AppHandle, f: impl FnOnce(&mut Status)) {
    f(&mut app.state::<Remote>().status.lock().unwrap());
    let _ = app.emit("mr-remote", ());
}

fn store(app: &AppHandle, events: Vec<Value>) {
    match app.state::<Remote>().cache.insert(&events) {
        Ok(fresh) => {
            for e in fresh {
                let _ = app.emit("mr-event", e);
            }
        }
        Err(e) => eprintln!("[remote] cache write failed: {e}"),
    }
}

pub fn start(app: AppHandle) {
    // Debug builds only: pair from MR_REMOTE_PAIR (the Mac's "Copy as text"), so a simulator run
    // needs no typing. `SIMCTL_CHILD_MR_REMOTE_PAIR=… xcrun simctl launch …` passes it in.
    #[cfg(debug_assertions)]
    if let Ok(text) = std::env::var("MR_REMOTE_PAIR") && app.state::<Remote>().paired.lock().unwrap().is_none() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = pair(&app, &text, "Simulator").await {
                eprintln!("[remote] auto-pair failed: {e}");
                set_status(&app, |s| s.error = Some(format!("pairing: {e}")));
            }
        });
    }
    tauri::async_runtime::spawn(async move {
        let mut kick = app.state::<Remote>().kick.subscribe();
        let mut backoff = Duration::from_secs(1);
        loop {
            let remote = app.state::<Remote>();
            let paired = remote.paired.lock().unwrap().clone();
            if let Some(p) = paired {
                match remote.peer().await {
                    Err(e) => set_status(&app, |s| s.error = Some(e)),
                    Ok(peer) => match peer.link(p.mac.clone(), &remote.cache.cursor()).await {
                        Err(e) => set_status(&app, |s| {
                            s.connected = false;
                            s.error = Some(e);
                        }),
                        Ok(mut link) => {
                            backoff = Duration::from_secs(1);
                            let known = link.known.clone();
                            set_status(&app, |s| {
                                *s = Status { connected: true, live: false, error: None, known };
                            });
                            run(&app, &mut link, &mut kick).await;
                            link.close();
                            set_status(&app, |s| {
                                s.connected = false;
                                s.live = false;
                            });
                        }
                    },
                }
            }
            // Wait to retry, or for pairing to change.
            let idle = app.state::<Remote>().paired.lock().unwrap().is_none();
            tokio::select! {
                _ = tokio::time::sleep(backoff), if !idle => {}
                _ = kick.changed() => { backoff = Duration::from_secs(1); continue }
            }
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    });
}

async fn run(app: &AppHandle, link: &mut remote_link::Link, kick: &mut watch::Receiver<u64>) {
    let (tx, mut rx) = mpsc::channel(16);
    *app.state::<Remote>().reqs.lock().unwrap() = Some(tx);
    let mut pending: HashMap<String, oneshot::Sender<Result<Value, String>>> = HashMap::new();
    loop {
        tokio::select! {
            frame = link.next() => match frame {
                Err(e) => {
                    set_status(app, |s| s.error = Some(e));
                    break;
                }
                Ok(Frame::Events { events }) => store(app, events),
                Ok(Frame::Event { event }) => store(app, vec![event]),
                Ok(Frame::Live { .. }) => set_status(app, |s| s.live = true),
                Ok(Frame::Ack { id, ok, result, error }) => {
                    if let Some(reply) = pending.remove(&id) {
                        let _ = reply.send(if ok { Ok(result.unwrap_or(Value::Null)) } else { Err(error.unwrap_or_default()) });
                    }
                }
                Ok(Frame::Error { error }) => set_status(app, |s| s.error = Some(error)),
                Ok(_) => {}
            },
            req = rx.recv() => match req {
                Some(Req::Command(c, reply)) => match link.send_command(c).await {
                    Ok(id) => { pending.insert(id, reply); }
                    Err(e) => { let _ = reply.send(Err(e)); break; }
                },
                Some(Req::Fetch(id)) => { if link.fetch(&id).await.is_err() { break } }
                None => break,
            },
            _ = kick.changed() => break,
        }
    }
    *app.state::<Remote>().reqs.lock().unwrap() = None;
    for (_, reply) in pending {
        let _ = reply.send(Err("the link to the Mac dropped; try again".into()));
    }
}

/// Pairs with the Mac in the QR text. The 6-digit code goes to the UI as `mr-remote-code`.
pub async fn pair(app: &AppHandle, text: &str, name: &str) -> Result<String, String> {
    let offer = Offer::from_text(text)?;
    let remote = app.state::<Remote>();
    let peer = remote.peer().await?;
    let mac = peer.pair(&offer, name, |code| { let _ = app.emit("mr-remote-code", code.to_owned()); }).await?;
    let paired = Paired { mac: offer.mac, name: mac.clone() };
    std::fs::write(remote.dir.join("paired.json"), serde_json::to_vec(&paired).unwrap_or_default()).map_err(|e| e.to_string())?;
    // Another Mac's rows don't belong with this one's.
    remote.cache.wipe().map_err(|e| e.to_string())?;
    *remote.paired.lock().unwrap() = Some(paired);
    remote.kick.send_modify(|n| *n += 1);
    let _ = app.emit("mr-remote", ());
    Ok(mac)
}

pub async fn command(app: &AppHandle, c: Command) -> Result<Value, String> {
    let tx = app.state::<Remote>().reqs.lock().unwrap().clone().ok_or("not connected to the Mac")?;
    let (reply, rx) = oneshot::channel();
    tx.send(Req::Command(c, reply)).await.map_err(|_| "not connected to the Mac".to_string())?;
    tokio::time::timeout(Duration::from_secs(30), rx).await.map_err(|_| "the Mac didn't answer in 30 s".to_string())?.map_err(|_| "the link to the Mac dropped".to_string())?
}

pub async fn fetch(app: &AppHandle, id: String) -> Result<(), String> {
    let tx = app.state::<Remote>().reqs.lock().unwrap().clone().ok_or("not connected to the Mac")?;
    tx.send(Req::Fetch(id)).await.map_err(|_| "not connected to the Mac".to_string())
}

pub async fn forget(app: &AppHandle) -> Result<(), String> {
    let remote = app.state::<Remote>();
    *remote.paired.lock().unwrap() = None;
    let _ = std::fs::remove_file(remote.dir.join("paired.json"));
    remote.cache.wipe().map_err(|e| e.to_string())?;
    // A new key: the Mac's pin on the old one is now useless even if it never unpairs.
    tokio::task::spawn_blocking(crate::key::rotate).await.map_err(|e| e.to_string())??;
    *remote.peer.lock().await = None;
    remote.kick.send_modify(|n| *n += 1);
    *remote.status.lock().unwrap() = Status::default();
    let _ = app.emit("mr-remote", ());
    Ok(())
}
