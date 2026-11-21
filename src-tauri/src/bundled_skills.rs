//! Bundled Claude skills (resources/claude-skills) → ~/.claude/skills.
//!
//! A skill folder the app installed carries a marker file (`.bbarit-bundled`) holding the hash of
//! the files the app wrote. On start, each bundled skill is:
//! - installed (and marked) when the folder does not exist;
//! - refreshed when the bundled copy changed and the installed files still hash to the marker
//!   (nobody edited them since the app wrote them);
//! - for a folder without a marker (installed before markers existed): marked when it equals the
//!   bundled copy, refreshed when it equals a copy an earlier app version shipped
//!   (`KNOWN_SHIPPED`), else left alone;
//! - left alone, with one log line per start, when its files differ from what the app wrote
//!   (the user edited it) or it was never the app's.
//! Runs on a background thread (main.rs setup).

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const MARKER: &str = ".bbarit-bundled";

/// Tree hashes of skill folders earlier app versions installed without a marker
/// (bbarit-agents/SKILL.md as shipped from 2026-11-03 on, from git history).
const KNOWN_SHIPPED: &[&str] = &[
    "d97e3e639c4cffb2cb7d18b4964c035f2130c2ef63fde80537a01222f384e5a8",
    "b45aa7d7db99358a07da9a4965a7a821c970dbaea2929e4c638835d1dd110bbf",
    "379de20dfb91cb4366f9993a3cdfa3e60b75bdc33583aac18a19e3f05a15f0d2",
    "466c54d56d3f4780b926a1f3018d9b951894b75cd8854ded822327352ed15353",
    "1e9af1f7b72a5fdd540a9bb5fb9175495b7a2a248ac340e1a02d825d62b817ac",
    "cbdec4ec42cf319709b08d4691001b36500b28ccd1a66640a0fef088015d19a9",
    "01e2956f9330f6605840cb53548144af6a26c6cff67649aaec320d2cbfaf2c38",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Installed,
    Updated,
    /// Already the bundled copy (marker written if it was missing).
    Current,
    /// The user's own or edited folder: not touched.
    KeptUserCopy,
    Failed,
}

fn files_of(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            files_of(root, &path, out)?;
        } else if ft.is_file() {
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            if rel != MARKER {
                out.push((rel, path));
            }
        }
    }
    Ok(())
}

/// SHA-256 over the folder's files (marker excluded), sorted by relative path: for each,
/// path bytes, 0, length (u64 LE), content.
pub fn tree_hash(dir: &Path) -> std::io::Result<String> {
    let mut files = Vec::new();
    files_of(dir, dir, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut h = Sha256::new();
    for (rel, path) in files {
        let bytes = std::fs::read(&path)?;
        h.update(rel.as_bytes());
        h.update([0u8]);
        h.update((bytes.len() as u64).to_le_bytes());
        h.update(&bytes);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn read_marker(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(MARKER)).ok()?;
    let v = text.lines().next()?.trim().to_string();
    (v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit())).then_some(v)
}

/// Replace `target` with `src` (copied beside it, then renamed in) and mark it.
fn replace(src: &Path, target: &Path) -> std::io::Result<()> {
    let parent = target.parent().unwrap_or(Path::new("."));
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = parent.join(format!(".{name}.bbarit-new"));
    let old = parent.join(format!(".{name}.bbarit-old"));
    let _ = std::fs::remove_dir_all(&tmp);
    let _ = std::fs::remove_dir_all(&old);
    crate::copy_dir_all(src, &tmp)?;
    std::fs::write(tmp.join(MARKER), format!("{}\n", tree_hash(&tmp)?))?;
    if target.exists() {
        std::fs::rename(target, &old)?;
    }
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::rename(&old, target);
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

/// Bring one installed skill folder up to the bundled copy when the app owns it.
pub fn sync_skill(src: &Path, target: &Path) -> Outcome {
    let Ok(bundled) = tree_hash(src) else { return Outcome::Failed };
    if !target.exists() {
        return if replace(src, target).is_ok() { Outcome::Installed } else { Outcome::Failed };
    }
    let Ok(installed) = tree_hash(target) else { return Outcome::KeptUserCopy };
    match read_marker(target) {
        Some(written) if written == installed => {
            if installed == bundled {
                Outcome::Current
            } else if replace(src, target).is_ok() {
                Outcome::Updated
            } else {
                Outcome::Failed
            }
        }
        Some(_) => Outcome::KeptUserCopy,
        None if installed == bundled => {
            if std::fs::write(target.join(MARKER), format!("{installed}\n")).is_ok() { Outcome::Current } else { Outcome::Failed }
        }
        None if KNOWN_SHIPPED.contains(&installed.as_str()) => {
            if replace(src, target).is_ok() { Outcome::Updated } else { Outcome::Failed }
        }
        None => Outcome::KeptUserCopy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory under the system temp dir, removed on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tempdir() -> TempDir {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("bbarit-skills-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn dir_with(files: &[(&str, &str)]) -> TempDir {
        let d = tempdir();
        for (rel, body) in files {
            let p = d.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        d
    }

    fn read(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap()
    }

    #[test]
    fn tree_hash_matches_the_documented_algorithm() {
        // Same vector as computed for KNOWN_SHIPPED (sorted paths, NUL, u64 LE length, bytes).
        let d = dir_with(&[("sub/b.txt", "x"), ("a.md", "hello")]);
        assert_eq!(tree_hash(d.path()).unwrap(), "16bf752f97ccded9640686491373b35c87d62f039d156e1f446e6b02b14d239c");
        std::fs::write(d.path().join(MARKER), "ignored").unwrap();
        assert_eq!(tree_hash(d.path()).unwrap(), "16bf752f97ccded9640686491373b35c87d62f039d156e1f446e6b02b14d239c");
    }

    #[test]
    fn installs_then_refreshes_an_unedited_copy() {
        let src = dir_with(&[("SKILL.md", "v1")]);
        let home = tempdir();
        let target = home.path().join("skill");
        assert_eq!(sync_skill(src.path(), &target), Outcome::Installed);
        assert!(read_marker(&target).is_some());
        assert_eq!(sync_skill(src.path(), &target), Outcome::Current);
        std::fs::write(src.path().join("SKILL.md"), "v2 with Lead mode").unwrap();
        assert_eq!(sync_skill(src.path(), &target), Outcome::Updated);
        assert_eq!(read(&target.join("SKILL.md")), "v2 with Lead mode");
        assert_eq!(read_marker(&target).unwrap(), tree_hash(&target).unwrap());
        assert!(!home.path().join(".skill.bbarit-old").exists() && !home.path().join(".skill.bbarit-new").exists());
    }

    #[test]
    fn never_overwrites_an_edited_or_user_folder() {
        let src = dir_with(&[("SKILL.md", "v1")]);
        let home = tempdir();
        let target = home.path().join("skill");
        sync_skill(src.path(), &target);
        std::fs::write(target.join("SKILL.md"), "my edits").unwrap();
        std::fs::write(src.path().join("SKILL.md"), "v2").unwrap();
        assert_eq!(sync_skill(src.path(), &target), Outcome::KeptUserCopy);
        assert_eq!(read(&target.join("SKILL.md")), "my edits");
        // A folder the user made (no marker, unknown content).
        let mine = home.path().join("mine");
        std::fs::create_dir_all(&mine).unwrap();
        std::fs::write(mine.join("SKILL.md"), "hand written").unwrap();
        assert_eq!(sync_skill(src.path(), &mine), Outcome::KeptUserCopy);
        assert_eq!(read(&mine.join("SKILL.md")), "hand written");
        assert!(!mine.join(MARKER).exists());
    }

    #[test]
    fn adopts_unmarked_copies_equal_to_the_bundle() {
        let src = dir_with(&[("SKILL.md", "v1")]);
        let old = dir_with(&[("SKILL.md", "v1")]);
        assert_eq!(sync_skill(src.path(), old.path()), Outcome::Current);
        assert_eq!(read_marker(old.path()).unwrap(), tree_hash(old.path()).unwrap());
    }

    #[test]
    fn refreshes_unmarked_copies_an_earlier_app_shipped() {
        // The first bbarit-agents SKILL.md the app shipped (git 5bf006d4), installed without a marker.
        let shipped = std::process::Command::new("git")
            .args(["show", "5bf006d4:src-tauri/resources/claude-skills/bbarit-agents/SKILL.md"])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output();
        let Ok(out) = shipped else { return };
        if !out.status.success() {
            return; // exported source tree without git history
        }
        let home = tempdir();
        let target = home.path().join("bbarit-agents");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("SKILL.md"), &out.stdout).unwrap();
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/claude-skills/bbarit-agents");
        assert_eq!(sync_skill(&src, &target), Outcome::Updated);
        assert!(read(&target.join("SKILL.md")).contains("## Lead mode"));
    }
}
