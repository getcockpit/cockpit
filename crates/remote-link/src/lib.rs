//! Cockpit Remote's link, shared by the Mac (`src-tauri`) and the phone (`mobile/`): the wire
//! protocol and the phone-side peer over iroh.

pub mod peer;
pub mod proto;

pub use peer::{Link, Peer};
