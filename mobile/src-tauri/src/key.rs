//! The phone's link key: an Ed25519 key (iroh's identity type, I147) kept in the Keychain. On a
//! real iPhone reading it needs Face ID or the passcode and it never leaves this device, so
//! opening the link is the Face ID gate. The simulator and a Mac dev build skip the presence check.

use iroh::SecretKey;

const SERVICE: &str = "dev.getcockpit.remote";
const ACCOUNT: &str = "link-key";

#[cfg(any(target_os = "ios", target_os = "macos"))]
fn read() -> Option<Vec<u8>> {
    security_framework::passwords::get_generic_password(SERVICE, ACCOUNT).ok()
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
fn write(bytes: &[u8]) -> Result<(), String> {
    use security_framework::passwords::{set_generic_password_options, PasswordOptions};
    let _ = security_framework::passwords::delete_generic_password(SERVICE, ACCOUNT);
    #[allow(unused_mut)]
    let mut opts = PasswordOptions::new_generic_password(SERVICE, ACCOUNT);
    #[cfg(all(target_os = "ios", not(target_abi = "sim")))]
    opts.set_access_control_options(security_framework::passwords_options::AccessControlOptions::USER_PRESENCE);
    set_generic_password_options(bytes, opts).map_err(|e| format!("Keychain: {e}"))
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
fn read() -> Option<Vec<u8>> {
    None
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
fn write(_: &[u8]) -> Result<(), String> {
    Err("Cockpit Remote keeps its key in the Apple Keychain".into())
}

/// This phone's key, made on first use.
pub fn load() -> Result<SecretKey, String> {
    if let Some(b) = read().and_then(|b| <[u8; 32]>::try_from(b).ok()) {
        return Ok(SecretKey::from_bytes(&b));
    }
    let key = SecretKey::generate();
    write(&key.to_bytes())?;
    Ok(key)
}

/// A fresh key (Forget this Mac): the old one can't be used again.
pub fn rotate() -> Result<SecretKey, String> {
    let key = SecretKey::generate();
    write(&key.to_bytes())?;
    Ok(key)
}
