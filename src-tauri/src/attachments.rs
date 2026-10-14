//! Files sent with a message (pasted, dropped or picked in the message box). A pasted image or
//! file has no path of its own, so its bytes are saved under the data folder first; the log and
//! the sidecar only ever see paths. The sidecar turns images and PDFs into content blocks.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::AppHandle;

const MAX_SAVE: usize = 50_000_000;
const MAX_PREVIEW: u64 = 25_000_000;

/// What the box shows and sends for one file: its path, name and type.
fn describe(path: &Path) -> Value {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let meta = std::fs::metadata(path).ok();
    json!({
        "path": path.to_string_lossy(),
        "name": name,
        "mime": mime_of(&name),
        "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
        "dir": meta.as_ref().is_some_and(|m| m.is_dir()),
        "exists": meta.is_some(),
    })
}

/// A file's type from its extension, as the API names it.
pub fn mime_of(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" | "csv" | "json" | "yaml" | "yml" | "toml" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// A name safe to keep in a file name: letters, digits, `.`, `-` and `_`; everything else `_`.
fn safe_name(name: &str) -> String {
    let n: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect();
    let n = n.trim_start_matches('.');
    if n.is_empty() { "pasted".into() } else { n.chars().take(80).collect() }
}

fn save_to(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}-{}", ulid::Ulid::new(), safe_name(name)));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Saves pasted bytes (the raw request body) as `<data>/attachments/<ulid>-<name>`. The name
/// comes URL-encoded in the `x-name` header.
#[tauri::command(async)]
pub fn attachment_save(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected the file's bytes".into()) };
    if bytes.len() > MAX_SAVE {
        return Err(format!("too big to attach ({} MB, 50 MB at most)", bytes.len() / 1_000_000));
    }
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).map(decode).unwrap_or_else(|| "pasted".into());
    let path = save_to(&crate::selfbuild::data_dir(&app).join("attachments"), &name, bytes)?;
    let mut d = describe(&path);
    d["name"] = name.into();
    Ok(d)
}

/// The same description for files that already have a path (dropped or picked).
#[tauri::command(async)]
pub fn attachment_info(paths: Vec<String>) -> Vec<Value> {
    paths.iter().map(|p| describe(Path::new(p))).collect()
}

/// An attached image's bytes, for its thumbnail. Images only.
#[tauri::command(async)]
pub fn attachment_read(path: String) -> Result<Response, String> {
    let p = Path::new(&path);
    if !mime_of(&path).starts_with("image/") {
        return Err("not an image".into());
    }
    let len = std::fs::metadata(p).map_err(|e| e.to_string())?.len();
    if len > MAX_PREVIEW {
        return Err("too big to preview".into());
    }
    std::fs::read(p).map(Response::new).map_err(|e| e.to_string())
}

/// `%XX` escapes back to bytes (the header carries non-ASCII names this way).
fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && let (Some(h), Some(l)) = ((b[i + 1] as char).to_digit(16), (b[i + 2] as char).to_digit(16)) {
            out.push((h * 16 + l) as u8);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_types_and_escapes() {
        assert_eq!(mime_of("Shot.PNG"), "image/png");
        assert_eq!(mime_of("spec.pdf"), "application/pdf");
        assert_eq!(mime_of("bin"), "application/octet-stream");
        assert_eq!(safe_name("my shot (1).png"), "my_shot__1_.png");
        assert_eq!(safe_name("../../etc"), "_.._etc");
        assert_eq!(safe_name(""), "pasted");
        assert_eq!(decode("Bildschirmfoto%20%C3%BC.png"), "Bildschirmfoto ü.png");
        assert_eq!(decode("100%"), "100%");
        assert_eq!(decode("%zé"), "%zé");
    }

    #[test]
    fn saves_and_describes() {
        let dir = std::env::temp_dir().join(format!("mr-att-{}", ulid::Ulid::new()));
        let p = save_to(&dir, "a b.png", b"\x89PNG").unwrap();
        assert!(p.starts_with(&dir) && p.to_string_lossy().ends_with("-a_b.png"));
        let d = describe(&p);
        assert_eq!((d["mime"].as_str(), d["size"].as_u64(), d["exists"].as_bool()), (Some("image/png"), Some(4), Some(true)));
        assert_eq!(describe(&dir.join("gone.txt"))["exists"], false);
        let _ = std::fs::remove_dir_all(dir);
    }
}
