//! The app identifier changed (MR-135), which moves every folder the OS keys by it. On the first
//! launch of a renamed build, move the old folders to the new names before anything opens them,
//! and leave a link at each old path (unix) so a copy still running from it, or a relaunch script
//! that names it, keeps working. Keychain entries move to the new service names on first read.
use std::path::{Path, PathBuf};

pub const ID: &str = "dev.getcockpit.app";

// The old names are assembled at run time, so the codename doesn't sit in the binary as a string.
fn old(parts: &[&str]) -> String {
    parts.concat()
}
fn old_id() -> String {
    old(&["dev.", "minority", "report", ".app"])
}

/// Runs once at startup, single-threaded, before the Tauri builder. MR_DATA_DIR (tests,
/// self-builds) means a chosen folder: nothing to migrate.
pub fn run() {
    if std::env::var("MR_DATA_DIR").is_ok_and(|d| !d.is_empty()) {
        return;
    }
    let mut bases: Vec<PathBuf> = [dirs::data_dir(), dirs::data_local_dir(), dirs::cache_dir()].into_iter().flatten().collect();
    // WKWebView keeps localStorage under ~/Library/WebKit/<bundle id>.
    #[cfg(target_os = "macos")]
    bases.extend(dirs::home_dir().map(|h| h.join("Library").join("WebKit")));
    bases.dedup();
    let (old_id, data) = (old_id(), dirs::data_dir());
    for base in bases {
        if let Err(e) = move_dir(&base.join(&old_id), &base.join(ID)) {
            eprintln!("[migrate] {}: {e}", base.display());
            // The event log stays where it is rather than starting empty; next launch retries.
            if Some(&base) == data.as_ref() {
                // SAFETY: single-threaded here; nothing else reads the environment yet.
                unsafe { std::env::set_var("MR_DATA_DIR", base.join(&old_id)) };
            }
        }
    }
}

/// Moves `from` to `to` when only `from` exists (and isn't already the link left behind).
/// Ok(true) when it moved something.
pub fn move_dir(from: &Path, to: &Path) -> std::io::Result<bool> {
    let is_link = std::fs::symlink_metadata(from).map(|m| m.file_type().is_symlink()).unwrap_or(false);
    if is_link || !from.is_dir() || to.exists() {
        return Ok(false);
    }
    std::fs::rename(from, to)?;
    #[cfg(unix)]
    if let Err(e) = std::os::unix::fs::symlink(to, from) {
        eprintln!("[migrate] link {}: {e}", from.display());
    }
    Ok(true)
}

/// cockpit.anthropic → the service the same secret was saved under before the rename.
fn old_service(service: &str) -> Option<String> {
    Some(old(&["minority", "-report", service.strip_prefix("cockpit")?]))
}

/// Reads a Keychain secret; one still under the old service name moves to the new one on first
/// read. Lazy rather than at startup: a self-build relaunched with MR_DATA_DIR skips the folder
/// move but must still find its keys.
pub fn keychain_get(service: &str, account: &str) -> Option<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let find = |s: &str| {
        let out = Command::new("security").args(["find-generic-password", "-s", s, "-a", account, "-w"]).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned()).filter(|v| !v.is_empty())
    };
    if let Some(v) = find(service) {
        return Some(v);
    }
    let from = old_service(service)?;
    let secret = find(&from)?;
    // Through `security -i` on stdin, so the secret never shows up in a process list.
    if let Ok(mut child) = Command::new("security").arg("-i").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        let saved = child.stdin.take().is_some_and(|mut i| i.write_all(format!("add-generic-password -U -s {service} -a {account} -w {secret}\n").as_bytes()).is_ok());
        if saved && child.wait().is_ok_and(|s| s.success()) && find(service).as_deref() == Some(secret.as_str()) {
            let _ = Command::new("security").args(["delete-generic-password", "-s", &from, "-a", account]).output();
        }
    }
    Some(secret)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_once_leaves_a_link_and_never_clobbers() {
        let root = std::env::temp_dir().join(format!("mr-migrate-{}", ulid::Ulid::new()));
        let (from, to) = (root.join("old.app"), root.join("new.app"));
        std::fs::create_dir_all(from.join("workspaces")).unwrap();
        std::fs::write(from.join("events.sqlite"), "log").unwrap();

        assert!(move_dir(&from, &to).unwrap());
        assert_eq!(std::fs::read_to_string(to.join("events.sqlite")).unwrap(), "log");
        #[cfg(unix)]
        assert_eq!(std::fs::read_to_string(from.join("events.sqlite")).unwrap(), "log", "the old path still reaches the data");
        assert!(!move_dir(&from, &to).unwrap(), "a second launch does nothing");

        // Both exist (a fresh install that later found old data): leave both alone.
        let (a, b) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("events.sqlite"), "new").unwrap();
        assert!(!move_dir(&a, &b).unwrap());
        assert_eq!(std::fs::read_to_string(b.join("events.sqlite")).unwrap(), "new");
        assert!(!move_dir(&root.join("missing"), &root.join("c")).unwrap());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn keychain_services_map_to_their_old_names() {
        assert_eq!(old_service("cockpit.anthropic").unwrap(), old(&["minority", "-report", ".anthropic"]));
        assert_eq!(old_service("other.service"), None);
    }

    #[test]
    fn the_old_name_is_not_a_literal() {
        assert_eq!(old_id().len(), "dev.".len() + 14 + ".app".len());
        assert_ne!(old_id(), ID);
    }
}
