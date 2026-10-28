//! Small cross-platform helpers: child processes without a console window, the home folder, PATH
//! lists, git's paths in native form, finding a program on PATH, and the OS keychain.

use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::Command;

/// `Command::new` for every child the app runs. Windows release builds are GUI-subsystem, so a
/// console child (git, gh, claude, cmd) would flash its own window: CREATE_NO_WINDOW stops that.
pub fn cmd(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut c, 0x0800_0000);
    c
}

/// The home folder as a string, "" if unknown. Not `$HOME`: Windows doesn't set it.
pub fn home_str() -> String {
    dirs::home_dir().map(|h| h.display().to_string()).unwrap_or_default()
}

/// `first` ahead of the PATH value `rest`, joined with the OS separator (':' or ';'); empties dropped.
pub fn prepend_path(first: &[PathBuf], rest: &str) -> String {
    let all: Vec<PathBuf> = first.iter().cloned().chain(std::env::split_paths(rest)).filter(|p| !p.as_os_str().is_empty()).collect();
    std::env::join_paths(all).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| rest.to_owned())
}

/// A path git printed (`C:/Users/x/repo` on Windows) with native separators, so joining onto it
/// doesn't mix `/` and `\`. Unchanged off Windows.
pub fn native_path(s: &str) -> PathBuf {
    PathBuf::from(if cfg!(windows) { s.replace('/', "\\") } else { s.to_owned() })
}

/// `name` on `path` (a PATH value), trying each of `exts` (Windows' PATHEXT: `.exe`, `.cmd`…).
pub fn find_in(name: &str, path: &OsStr, exts: &[&str]) -> Option<PathBuf> {
    std::env::split_paths(path).filter(|d| !d.as_os_str().is_empty()).find_map(|d| exts.iter().map(|e| d.join(format!("{name}{e}"))).find(|p| p.is_file()))
}

/// `name` on this process's PATH. On Windows through PATHEXT, limited to what Command can start
/// (.exe, .com, and .cmd/.bat through cmd): std only appends `.exe`, so npm's `claude.cmd` was never found.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    if cfg!(windows) {
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        let exts: Vec<String> = pathext.split(';').map(str::to_ascii_lowercase).filter(|e| [".exe", ".com", ".cmd", ".bat"].contains(&e.as_str())).collect();
        find_in(name, &path, &exts.iter().map(String::as_str).collect::<Vec<_>>())
    } else {
        find_in(name, &path, &[""])
    }
}

/// Saves a secret in the OS keychain. macOS: through `security -i` on stdin, so it never shows up
/// in a process list. Elsewhere: Windows Credential Manager / the Linux keyring, same names.
pub fn keychain_set(service: &str, account: &str, secret: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        use std::process::Stdio;
        let mut child = cmd("security").arg("-i").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
        let line = format!("add-generic-password -U -s {service} -a {account} -w {secret}\n");
        child.stdin.take().ok_or("no stdin")?.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        child.wait().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        keyring::Entry::new(service, account).and_then(|e| e.set_password(secret)).map_err(|e| e.to_string())
    }
}

/// Reads a secret from the OS keychain (None when missing or empty).
pub fn keychain_find(service: &str, account: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    let v = {
        let out = cmd("security").args(["find-generic-password", "-s", service, "-a", account, "-w"]).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())?
    };
    #[cfg(not(target_os = "macos"))]
    let v = keyring::Entry::new(service, account).and_then(|e| e.get_password()).ok()?.trim().to_owned();
    Some(v).filter(|v| !v.is_empty())
}

/// Removes a secret from the OS keychain; missing is fine.
#[cfg(target_os = "macos")]
pub fn keychain_delete(service: &str, account: &str) {
    let _ = cmd("security").args(["delete-generic-password", "-s", service, "-a", account]).output();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepends_with_the_os_separator_and_drops_empties() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let rest = std::env::join_paths(["/usr/bin", "/bin"]).unwrap().into_string().unwrap();
        let p = prepend_path(&[PathBuf::from("/a"), PathBuf::from("/b")], &rest);
        assert_eq!(p, ["/a", "/b", "/usr/bin", "/bin"].join(sep));
        assert_eq!(prepend_path(&[PathBuf::from("/a")], ""), "/a");
    }

    #[test]
    fn git_paths_get_native_separators() {
        let p = native_path("C:/Users/x/repo");
        if cfg!(windows) {
            assert_eq!(p, PathBuf::from(r"C:\Users\x\repo"));
            assert_eq!(p.parent().unwrap().join("repo-worktrees").join("s"), PathBuf::from(r"C:\Users\x\repo-worktrees\s"));
        } else {
            assert_eq!(p, PathBuf::from("C:/Users/x/repo"));
        }
    }

    #[test]
    fn finds_a_cmd_shim_through_pathext() {
        let root = std::env::temp_dir().join(format!("mr-which-{}", ulid::Ulid::new()));
        let (a, b) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("claude.cmd"), "").unwrap();
        let path = std::env::join_paths([&a, &b]).unwrap();
        assert_eq!(find_in("claude", &path, &[".exe", ".cmd"]), Some(b.join("claude.cmd")));
        std::fs::write(a.join("claude.exe"), "").unwrap();
        assert_eq!(find_in("claude", &path, &[".exe", ".cmd"]), Some(a.join("claude.exe")), "earlier PATH entries win");
        assert_eq!(find_in("nope", &path, &[".exe", ".cmd"]), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
