use std::path::Path;
use std::process::Command;

fn git(args: &[&str]) -> String {
    Command::new("git").args(args).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned()).unwrap_or_default()
}

/// The commit this binary is built from, as MR_GIT_SHA (update.rs compares main against it). Reruns
/// when HEAD moves: the HEAD file, the branch it points at, packed-refs (worktrees keep refs in the
/// common dir).
fn git_sha() {
    let sha = git(&["rev-parse", "HEAD"]);
    println!("cargo:rustc-env=MR_GIT_SHA={sha}");
    let (dir, common) = (git(&["rev-parse", "--absolute-git-dir"]), git(&["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    let mut watch = vec![format!("{dir}/HEAD"), format!("{common}/packed-refs")];
    if let Some(r) = git(&["symbolic-ref", "-q", "HEAD"]).strip_prefix("refs/") {
        watch.push(format!("{common}/refs/{r}"));
    }
    // A missing path would rerun this on every build.
    for p in watch.iter().filter(|p| !dir.is_empty() && Path::new(p).exists()) {
        println!("cargo:rerun-if-changed={p}");
    }
}

/// The phone web app this build vouches for (decision 47): site/remote/current.json, built by
/// scripts/build-remote-web.sh. The Mac sends it in the welcome; the phone updates only to it.
fn remote_app() {
    let path = Path::new("../site/remote/current.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let field = |k: &str| text.split(&format!("\"{k}\": \"")).nth(1).and_then(|r| r.split('"').next()).unwrap_or("").to_owned();
    println!("cargo:rustc-env=MR_REMOTE_APP_VERSION={}", field("version"));
    println!("cargo:rustc-env=MR_REMOTE_APP_ROOT={}", field("root"));
    println!("cargo:rustc-env=MR_REMOTE_APP_SW={}", field("sw"));
}

fn main() {
    git_sha();
    remote_app();
    tauri_build::build()
}
