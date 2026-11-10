//! On-disk size of a project folder for the status bar's DISK readout.
//!
//! Walking a folder touches every file (a large monorepo can hold hundreds of
//! thousands), so this never runs on a timer and never on the main thread: the
//! Tauri command hands the walk to `spawn_blocking`, at most one walk per folder
//! runs at a time (a second caller waits for the same result), and the walk
//! checks a cancel flag on every entry so leaving the project stops the disk I/O.
//!
//! What is counted (like `du`): allocated blocks on unix (`blocks * 512`), file
//! length elsewhere; symlinks are not followed (their own entry is counted);
//! other filesystems mounted inside the folder are skipped; a file with several
//! hard links inside the folder is counted once; unreadable entries are skipped.
//! The home folder and filesystem roots are only measured on an explicit click.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Instant;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    /// Allocated bytes (unix) or summed lengths (other platforms).
    pub bytes: u64,
    /// Non-directory entries counted (files and symlinks; hard links once).
    pub files: u64,
    /// Directories walked, the root included.
    pub dirs: u64,
    /// Entries that could not be read and were left out.
    pub skipped: u64,
    /// True when the walk stopped early because it was cancelled.
    pub cancelled: bool,
    /// True when an automatic request was declined because the folder is the
    /// home folder or a filesystem root (measure those only on an explicit click).
    pub not_auto: bool,
    pub elapsed_ms: u64,
}

#[cfg(unix)]
fn allocated(md: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    md.blocks().saturating_mul(512)
}

#[cfg(not(unix))]
fn allocated(md: &std::fs::Metadata) -> u64 {
    md.len()
}

#[cfg(unix)]
fn device(md: &std::fs::Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    Some(md.dev())
}

#[cfg(not(unix))]
fn device(_md: &std::fs::Metadata) -> Option<u64> {
    None
}

/// (dev, ino) for files with more than one hard link, so they count once.
#[cfg(unix)]
fn hardlink_key(md: &std::fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    if md.nlink() > 1 {
        Some((md.dev(), md.ino()))
    } else {
        None
    }
}

#[cfg(not(unix))]
fn hardlink_key(_md: &std::fs::Metadata) -> Option<(u64, u64)> {
    None
}

/// Sum the on-disk size of `root`. Blocking; call it off the main thread.
/// The root itself may be a symlink (it is resolved once); nothing below it is
/// followed. Returns Err only when the root cannot be read at all.
pub fn measure(root: &Path, cancel: &AtomicBool) -> Result<DiskUsage, String> {
    let started = Instant::now();
    let root_md = std::fs::metadata(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let mut usage = DiskUsage::default();
    if !root_md.is_dir() {
        usage.bytes = allocated(&root_md);
        usage.files = 1;
        usage.elapsed_ms = started.elapsed().as_millis() as u64;
        return Ok(usage);
    }
    let root_dev = device(&root_md);
    let mut seen_links: HashSet<(u64, u64)> = HashSet::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    usage.bytes = allocated(&root_md);

    while let Some(dir) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            usage.cancelled = true;
            break;
        }
        usage.dirs += 1;
        let entries = match std::fs::read_dir(&dir) {
            Ok(it) => it,
            Err(_) => {
                usage.skipped += 1;
                continue;
            }
        };
        for entry in entries {
            if cancel.load(Ordering::Relaxed) {
                usage.cancelled = true;
                break;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => {
                    usage.skipped += 1;
                    continue;
                }
            };
            // DirEntry::metadata does not follow symlinks.
            let md = match entry.metadata() {
                Ok(m) => m,
                Err(_) => {
                    usage.skipped += 1;
                    continue;
                }
            };
            if md.is_dir() {
                if root_dev.is_some() && device(&md) != root_dev {
                    // A mount point of another filesystem: not this folder's footprint.
                    continue;
                }
                usage.bytes = usage.bytes.saturating_add(allocated(&md));
                stack.push(entry.path());
                continue;
            }
            if let Some(key) = hardlink_key(&md) {
                if !seen_links.insert(key) {
                    continue;
                }
            }
            usage.files += 1;
            usage.bytes = usage.bytes.saturating_add(allocated(&md));
        }
        if usage.cancelled {
            break;
        }
    }
    usage.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(usage)
}

/// True for folders that are not measured automatically: a filesystem root
/// (`/`, `C:\`) or the user's home folder. Walking those reads everything the
/// user owns and, on macOS, can raise privacy prompts (Desktop, Documents,
/// other apps' containers) without any user action. Paths are compared after
/// canonicalizing, so `~/.`, trailing slashes and symlinks to home all match.
pub fn is_broad_folder(path: &Path, home: Option<&Path>) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let target = canon(path);
    if target.parent().is_none() {
        return true;
    }
    match home {
        Some(h) => canon(h) == target,
        None => false,
    }
}

// ─── One walk per folder ─────────────────────────────────────────────

struct Job {
    cancel: AtomicBool,
    result: Mutex<Option<Result<DiskUsage, String>>>,
    done: Condvar,
}

impl Job {
    fn wait(&self) -> Result<DiskUsage, String> {
        let mut guard = self.result.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(res) = guard.as_ref() {
                return res.clone();
            }
            guard = self.done.wait(guard).unwrap_or_else(|e| e.into_inner());
        }
    }
}

fn jobs() -> &'static Mutex<HashMap<PathBuf, Arc<Job>>> {
    static JOBS: OnceLock<Mutex<HashMap<PathBuf, Arc<Job>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn validate(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty path".into());
    }
    if trimmed.starts_with("ssh://") {
        return Err("remote (SSH) folders are not measured".into());
    }
    let p = PathBuf::from(trimmed);
    if !p.exists() {
        return Err(format!("{trimmed}: not found"));
    }
    Ok(p)
}

/// Measure `path`, joining a walk of the same folder that is already running
/// (unless that one was cancelled). With `auto` set, the home folder and
/// filesystem roots are not walked (`not_auto` in the result). Blocking.
pub fn measure_shared(path: &str, auto: bool) -> Result<DiskUsage, String> {
    let root = validate(path)?;
    if auto && is_broad_folder(&root, dirs::home_dir().as_deref()) {
        return Ok(DiskUsage {
            not_auto: true,
            ..DiskUsage::default()
        });
    }
    let (job, owner) = start_or_join(&root);
    if !owner {
        return job.wait();
    }
    run_owned(root.clone(), job, |cancel| measure(&root, cancel))
}

/// Register a walk of `root`, or join the one already running.
/// Returns the job and whether the caller owns (must run) it.
fn start_or_join(root: &Path) -> (Arc<Job>, bool) {
    let mut map = jobs().lock().unwrap_or_else(|e| e.into_inner());
    match map.get(root) {
        Some(job) if !job.cancel.load(Ordering::Relaxed) => (job.clone(), false),
        _ => {
            let job = Arc::new(Job {
                cancel: AtomicBool::new(false),
                result: Mutex::new(None),
                done: Condvar::new(),
            });
            map.insert(root.to_path_buf(), job.clone());
            (job, true)
        }
    }
}

/// Removes the job from the map and wakes its waiters when the owner finishes,
/// including when the walk panics (waiters then get an error instead of
/// waiting forever, and the folder can be measured again).
struct JobGuard {
    root: PathBuf,
    job: Arc<Job>,
    result: Option<Result<DiskUsage, String>>,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        {
            let mut map = jobs().lock().unwrap_or_else(|e| e.into_inner());
            if map.get(&self.root).is_some_and(|j| Arc::ptr_eq(j, &self.job)) {
                map.remove(&self.root);
            }
        }
        let res = self
            .result
            .take()
            .unwrap_or_else(|| Err("disk size measurement failed".into()));
        *self.job.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(res);
        self.job.done.notify_all();
    }
}

fn run_owned(
    root: PathBuf,
    job: Arc<Job>,
    walk: impl FnOnce(&AtomicBool) -> Result<DiskUsage, String>,
) -> Result<DiskUsage, String> {
    let mut guard = JobGuard {
        root,
        job: job.clone(),
        result: None,
    };
    let res = walk(&job.cancel);
    guard.result = Some(res.clone());
    res
}

/// Ask the running walk of `path` (or every walk when None) to stop.
/// Returns how many walks were signalled.
pub fn cancel(path: Option<&str>) -> usize {
    let map = jobs().lock().unwrap_or_else(|e| e.into_inner());
    let mut n = 0;
    for (p, job) in map.iter() {
        if path.is_none_or(|want| Path::new(want.trim()) == p.as_path()) {
            job.cancel.store(true, Ordering::Relaxed);
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "bbarit-disk-usage-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, len: usize) {
        fs::write(path, vec![b'x'; len]).unwrap();
    }

    #[test]
    fn counts_files_in_nested_dirs() {
        let dir = temp_dir("nested");
        write(&dir.join("a.bin"), 10_000);
        write(&dir.join("b.bin"), 20_000);
        fs::create_dir_all(dir.join("sub/deeper")).unwrap();
        write(&dir.join("sub/c.bin"), 30_000);
        write(&dir.join("sub/deeper/d.bin"), 40_000);

        let usage = measure(&dir, &AtomicBool::new(false)).unwrap();
        assert_eq!(usage.files, 4);
        assert_eq!(usage.dirs, 3);
        assert!(!usage.cancelled);
        assert!(usage.bytes >= 100_000, "bytes {} < sum of lens", usage.bytes);
        // Allocation rounds up per file, but not wildly.
        assert!(usage.bytes < 100_000 + 7 * 64 * 1024, "bytes {} too large", usage.bytes);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks() {
        let outside = temp_dir("outside");
        write(&outside.join("big.bin"), 2_000_000);
        let dir = temp_dir("links");
        write(&dir.join("small.bin"), 1_000);
        std::os::unix::fs::symlink(&outside, dir.join("to-dir")).unwrap();
        std::os::unix::fs::symlink(outside.join("big.bin"), dir.join("to-file")).unwrap();

        let usage = measure(&dir, &AtomicBool::new(false)).unwrap();
        // small.bin + two symlink entries; the 2 MB target is not counted.
        assert_eq!(usage.files, 3);
        assert_eq!(usage.dirs, 1);
        assert!(usage.bytes < 1_000_000, "followed a symlink: {} bytes", usage.bytes);
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn counts_hard_links_once() {
        let dir = temp_dir("hardlink");
        write(&dir.join("one.bin"), 500_000);
        let single = measure(&dir, &AtomicBool::new(false)).unwrap();
        fs::hard_link(dir.join("one.bin"), dir.join("two.bin")).unwrap();
        let linked = measure(&dir, &AtomicBool::new(false)).unwrap();
        assert_eq!(linked.files, 1);
        assert_eq!(linked.bytes, single.bytes);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cancel_flag_stops_the_walk() {
        let dir = temp_dir("cancel");
        for i in 0..20 {
            write(&dir.join(format!("f{i}.bin")), 100);
        }
        let usage = measure(&dir, &AtomicBool::new(true)).unwrap();
        assert!(usage.cancelled);
        assert_eq!(usage.files, 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_path_is_an_error() {
        let missing = std::env::temp_dir().join("bbarit-disk-usage-does-not-exist-xyz");
        assert!(measure(&missing, &AtomicBool::new(false)).is_err());
        assert!(measure_shared(missing.to_str().unwrap(), false).is_err());
    }

    #[test]
    fn rejects_ssh_and_empty_paths() {
        assert!(measure_shared("ssh://host/home/me/project", false).is_err());
        assert!(measure_shared("   ", false).is_err());
    }

    #[test]
    fn shared_measure_matches_direct_and_clears_job() {
        let dir = temp_dir("shared");
        write(&dir.join("a.bin"), 5_000);
        let direct = measure(&dir, &AtomicBool::new(false)).unwrap();
        let shared = measure_shared(dir.to_str().unwrap(), true).unwrap();
        assert!(!shared.not_auto);
        assert_eq!(shared.bytes, direct.bytes);
        assert_eq!(shared.files, 1);
        assert!(!jobs().lock().unwrap().contains_key(&dir));
        assert_eq!(cancel(Some(dir.to_str().unwrap())), 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn home_and_roots_are_broad_folders() {
        let home = temp_dir("home");
        fs::create_dir_all(home.join("project")).unwrap();
        assert!(is_broad_folder(&home, Some(&home)));
        assert!(is_broad_folder(&home.join("."), Some(&home)));
        assert!(!is_broad_folder(&home.join("project"), Some(&home)));
        assert!(!is_broad_folder(&home.join("project"), None));
        #[cfg(unix)]
        {
            assert!(is_broad_folder(Path::new("/"), None));
            assert!(is_broad_folder(Path::new("/."), None));
            let link = temp_dir("home-link-parent").join("to-home");
            std::os::unix::fs::symlink(&home, &link).unwrap();
            assert!(is_broad_folder(&link, Some(&home)));
            fs::remove_dir_all(link.parent().unwrap()).unwrap();
        }
        #[cfg(windows)]
        assert!(is_broad_folder(Path::new("C:\\"), None));
        fs::remove_dir_all(&home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn automatic_request_skips_filesystem_root() {
        let auto = measure_shared("/", true).unwrap();
        assert!(auto.not_auto);
        assert_eq!(auto.files, 0);
    }

    #[test]
    fn panicking_walk_releases_job_and_wakes_waiters() {
        let dir = temp_dir("panic");
        let (job, owner) = start_or_join(&dir);
        assert!(owner);
        let (joined, second_owner) = start_or_join(&dir);
        assert!(!second_owner);
        let waiter = std::thread::spawn(move || joined.wait());
        let root = dir.clone();
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_owned(root, job, |_| panic!("walk blew up"))
        }));
        assert!(caught.is_err());
        assert!(waiter.join().unwrap().is_err());
        assert!(!jobs().lock().unwrap().contains_key(&dir));
        let (_, owner_again) = start_or_join(&dir);
        assert!(owner_again);
        jobs().lock().unwrap().remove(&dir);
        fs::remove_dir_all(&dir).unwrap();
    }
}
