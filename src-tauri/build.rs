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

fn main() {
    git_sha();
    tauri_build::build()
}
