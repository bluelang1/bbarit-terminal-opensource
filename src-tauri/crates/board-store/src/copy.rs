//! "Copy data" between the two stores (Settings → Agent team board): the live rows of every
//! team (teams, posts, tasks, task_deps, task_events, cursors) exported from one store and
//! inserted into the other. The target is either empty or, on request, only gets the teams it
//! does not have yet. The source is never changed. Row ids, numbers, row versions and times
//! are kept; `posts.arrival` (the local read order) is assigned by the target and read cursors
//! are converted to it.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Int,
    Text,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cell {
    Null,
    Int(i64),
    Text(String),
}

impl Cell {
    pub fn text(&self) -> Option<&str> {
        match self {
            Cell::Text(s) => Some(s),
            _ => None,
        }
    }
    pub fn int(&self) -> Option<i64> {
        match self {
            Cell::Int(n) => Some(*n),
            _ => None,
        }
    }
}

use Kind::{Int as I, Text as T};

pub type Cols = &'static [(&'static str, Kind)];

pub const TEAMS: Cols = &[
    ("uid", T), ("team", T), ("name", T), ("home_host", T), ("home_instance", T), ("created_at", I),
    ("last_post_seq", I), ("last_task_seq", I), ("last_activity_at", I), ("origin_host", T), ("updated_at", I),
    ("row_version", I), ("deleted_at", I),
];
/// `arrival` is last: the target replaces it with its own read order.
pub const POSTS: Cols = &[
    ("id", T), ("team_uid", T), ("seq", I), ("ts", I), ("author_id", T), ("author_name", T), ("author_cli", T),
    ("author_host", T), ("kind", T), ("text", T), ("task_id", T), ("origin_host", T), ("updated_at", I),
    ("row_version", I), ("deleted_at", I), ("arrival", I),
];
pub const TASKS: Cols = &[
    ("id", T), ("team_uid", T), ("seq", I), ("parent_id", T), ("title", T), ("body", T), ("state", T),
    ("priority", I), ("needs_review", I), ("created_by_id", T), ("created_by_name", T), ("created_by_host", T),
    ("owner_id", T), ("owner_name", T), ("owner_host", T), ("owner_instance", T), ("attempt", I),
    ("max_attempts", I), ("blocked_reason", T), ("last_error", T), ("result_summary", T), ("result_body", T),
    ("result_branch", T), ("result_commit", T), ("result_worktree", T), ("result_checks", T),
    ("result_artifacts", T), ("labels", T), ("meta", T), ("created_at", I), ("updated_at", I), ("claimed_at", I),
    ("started_at", I), ("submitted_at", I), ("finished_at", I), ("lease_until", I), ("heartbeat_at", I),
    ("due_at", I), ("version", I), ("origin_host", T), ("row_version", I), ("deleted_at", I),
];
pub const DEPS: Cols = &[
    ("task_id", T), ("depends_on_id", T), ("team_uid", T), ("origin_host", T), ("updated_at", I), ("row_version", I),
    ("deleted_at", I),
];
pub const EVENTS: Cols = &[
    ("id", T), ("task_id", T), ("team_uid", T), ("seq", I), ("ts", I), ("actor_id", T), ("actor_name", T),
    ("actor_host", T), ("action", T), ("from_state", T), ("to_state", T), ("attempt", I), ("note", T), ("data", T),
    ("origin_host", T), ("updated_at", I), ("row_version", I), ("deleted_at", I),
];
pub const CURSORS: Cols = &[("team_uid", T), ("tab_id", T), ("arrival", I)];

/// Every table in insert order with its columns.
pub const TABLES: [(&str, Cols); 6] =
    [("teams", TEAMS), ("tasks", TASKS), ("task_deps", DEPS), ("task_events", EVENTS), ("posts", POSTS), ("cursors", CURSORS)];

pub fn col_list(cols: Cols) -> String {
    cols.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", ")
}

pub fn col_index(cols: Cols, name: &str) -> usize {
    cols.iter().position(|(n, _)| *n == name).expect("known column")
}

/// The live rows of every live team (tombstoned rows are not copied).
#[derive(Debug, Default, Clone)]
pub struct Dump {
    pub teams: Vec<Vec<Cell>>,
    pub posts: Vec<Vec<Cell>>,
    pub tasks: Vec<Vec<Cell>>,
    pub deps: Vec<Vec<Cell>>,
    pub events: Vec<Vec<Cell>>,
    pub cursors: Vec<Vec<Cell>>,
}

impl Dump {
    pub fn rows_mut(&mut self, table: &str) -> &mut Vec<Vec<Cell>> {
        match table {
            "teams" => &mut self.teams,
            "posts" => &mut self.posts,
            "tasks" => &mut self.tasks,
            "task_deps" => &mut self.deps,
            "task_events" => &mut self.events,
            _ => &mut self.cursors,
        }
    }

    pub fn rows(&self, table: &str) -> &Vec<Vec<Cell>> {
        match table {
            "teams" => &self.teams,
            "posts" => &self.posts,
            "tasks" => &self.tasks,
            "task_deps" => &self.deps,
            "task_events" => &self.events,
            _ => &self.cursors,
        }
    }
}

/// What the target already has. `uids` / `keys` (team, home_host): live teams only. `dead`:
/// tombstoned teams (cleaned up or retired) as (uid, team, home_host) — they neither make the
/// target "not empty" nor block a copy; a dead team that would collide with a copied one is
/// removed for good first (`Plan::purge`).
#[derive(Debug, Default)]
pub struct Existing {
    pub uids: HashSet<String>,
    pub keys: HashSet<(String, Option<String>)>,
    pub dead: Vec<(String, String, Option<String>)>,
}

impl Existing {
    pub fn add(&mut self, uid: String, team: String, host: Option<String>, deleted: bool) {
        if deleted {
            self.dead.push((uid, team, host));
        } else {
            self.uids.insert(uid);
            self.keys.insert((team, host));
        }
    }
}

/// Which source rows go into the target, and which dead target teams must go first.
#[derive(Debug)]
pub struct Plan {
    pub dump: Dump,
    pub skipped: Vec<String>,
    pub purge: Vec<String>,
}

/// `merge` false: the target must have no live team. `merge` true: teams the target already
/// has live (same uid, or same root tab and home machine) are skipped with all their rows.
pub fn plan(dump: Dump, existing: &Existing, merge: bool) -> Result<Plan, String> {
    if !merge && !existing.uids.is_empty() {
        return Err(format!(
            "the target board is not empty ({} team{}): choose \"merge teams that do not exist there\" or use an empty database",
            existing.uids.len(),
            if existing.uids.len() == 1 { "" } else { "s" }
        ));
    }
    let (uid_i, team_i, host_i) = (col_index(TEAMS, "uid"), col_index(TEAMS, "team"), col_index(TEAMS, "home_host"));
    let mut keep: HashSet<String> = HashSet::new();
    let mut skipped = Vec::new();
    let mut purge = Vec::new();
    let mut out = Dump::default();
    for row in dump.teams {
        let uid = row[uid_i].text().unwrap_or_default().to_string();
        let key = (row[team_i].text().unwrap_or_default().to_string(), row[host_i].text().map(str::to_string));
        if existing.uids.contains(&uid) || existing.keys.contains(&key) {
            skipped.push(key.0);
            continue;
        }
        for (d_uid, d_team, d_host) in &existing.dead {
            if (*d_uid == uid || (*d_team == key.0 && *d_host == key.1)) && !purge.contains(d_uid) {
                purge.push(d_uid.clone());
            }
        }
        keep.insert(uid);
        out.teams.push(row);
    }
    let by_team = |rows: Vec<Vec<Cell>>, cols: Cols| -> Vec<Vec<Cell>> {
        let i = col_index(cols, "team_uid");
        rows.into_iter().filter(|r| r[i].text().is_some_and(|u| keep.contains(u))).collect()
    };
    out.posts = by_team(dump.posts, POSTS);
    // Read order, whatever order the source returned them in: the target hands out new
    // arrival positions in this order and converts cursors through it.
    let (pt, pa, ps) = (col_index(POSTS, "team_uid"), col_index(POSTS, "arrival"), col_index(POSTS, "seq"));
    out.posts.sort_by(|a, b| {
        (a[pt].text(), a[pa].int(), a[ps].int()).cmp(&(b[pt].text(), b[pa].int(), b[ps].int()))
    });
    out.tasks = by_team(dump.tasks, TASKS);
    out.deps = by_team(dump.deps, DEPS);
    out.events = by_team(dump.events, EVENTS);
    out.cursors = by_team(dump.cursors, CURSORS);
    Ok(Plan { dump: out, skipped, purge })
}

/// Tables a purged dead team is removed from (children first).
pub const PURGE_TABLES: [&str; 5] = ["posts", "task_events", "task_deps", "tasks", "cursors"];

/// Source → target read positions of one team's posts; a cursor at source position `c`
/// becomes the target position of the newest post at or before it (0 when none).
#[derive(Debug, Default)]
pub struct ArrivalMap {
    pairs: HashMap<String, Vec<(i64, i64)>>,
}

impl ArrivalMap {
    pub fn add(&mut self, team_uid: &str, src: i64, dst: i64) {
        self.pairs.entry(team_uid.to_string()).or_default().push((src, dst));
    }

    pub fn convert(&mut self, team_uid: &str, cursor: i64) -> i64 {
        let Some(list) = self.pairs.get_mut(team_uid) else { return 0 };
        list.sort_unstable();
        list.iter().filter(|(s, _)| *s <= cursor).map(|(_, d)| *d).max().unwrap_or(0)
    }
}

pub fn summary(d: &Dump, skipped: &[String]) -> Value {
    json!({
        "teams": d.teams.len(),
        "posts": d.posts.len(),
        "tasks": d.tasks.len(),
        "deps": d.deps.len(),
        "events": d.events.len(),
        "cursors": d.cursors.len(),
        "skippedTeams": skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn team(uid: &str, team: &str, host: &str) -> Vec<Cell> {
        TEAMS
            .iter()
            .map(|(n, k)| match *n {
                "uid" => Cell::Text(uid.into()),
                "team" => Cell::Text(team.into()),
                "home_host" => Cell::Text(host.into()),
                _ if *k == I => Cell::Int(0),
                _ => Cell::Null,
            })
            .collect()
    }

    fn post(team_uid: &str) -> Vec<Cell> {
        POSTS.iter().map(|(n, k)| if *n == "team_uid" { Cell::Text(team_uid.into()) } else if *k == I { Cell::Int(1) } else { Cell::Null }).collect()
    }

    #[test]
    fn plan_refuses_a_non_empty_target_unless_merging_and_skips_existing_teams() {
        let dump = Dump { teams: vec![team("u1", "r1", "h"), team("u2", "r2", "h"), team("u3", "r3", "h")], posts: vec![post("u1"), post("u2"), post("u3")], ..Default::default() };
        let empty = Existing::default();
        let all = plan(dump.clone(), &empty, false).unwrap();
        assert_eq!((all.dump.teams.len(), all.dump.posts.len(), all.skipped.len()), (3, 3, 0));
        let mut existing = Existing::default();
        existing.uids.insert("u1".into());
        existing.uids.insert("other".into());
        existing.keys.insert(("r2".into(), Some("h".into())));
        let err = plan(dump.clone(), &existing, false).unwrap_err();
        assert!(err.starts_with("the target board is not empty (2 teams)"), "{err}");
        let merged = plan(dump.clone(), &existing, true).unwrap();
        assert_eq!(merged.dump.teams.len(), 1);
        assert_eq!(merged.dump.posts.len(), 1, "rows of skipped teams are not copied");
        assert_eq!(merged.skipped, vec!["r1", "r2"]);
        // Tombstoned teams: not "not empty", and a colliding one is purged first.
        let mut dead = Existing::default();
        dead.add("u3".into(), "r3".into(), Some("h".into()), true);
        dead.add("ux".into(), "r1".into(), Some("h".into()), true);
        dead.add("uz".into(), "zz".into(), None, true);
        let p = plan(dump, &dead, false).unwrap();
        assert_eq!(p.dump.teams.len(), 3);
        assert_eq!(p.purge, vec!["ux", "u3"]);
    }

    #[test]
    fn posts_are_planned_in_read_order() {
        let p = |team: &str, arrival: i64| -> Vec<Cell> {
            POSTS
                .iter()
                .map(|(n, k)| match *n {
                    "team_uid" => Cell::Text(team.into()),
                    "arrival" => Cell::Int(arrival),
                    _ if *k == I => Cell::Int(0),
                    _ => Cell::Null,
                })
                .collect()
        };
        let dump = Dump { teams: vec![team("u1", "r1", "h"), team("u2", "r2", "h")], posts: vec![p("u2", 5), p("u1", 9), p("u1", 3), p("u2", 1)], ..Default::default() };
        let out = plan(dump, &Existing::default(), false).unwrap().dump;
        let (t, a) = (col_index(POSTS, "team_uid"), col_index(POSTS, "arrival"));
        let order: Vec<(String, i64)> = out.posts.iter().map(|r| (r[t].text().unwrap().to_string(), r[a].int().unwrap())).collect();
        assert_eq!(order, vec![("u1".into(), 3), ("u1".into(), 9), ("u2".into(), 1), ("u2".into(), 5)]);
    }

    #[test]
    fn cursors_map_to_the_newest_copied_post_at_or_before_them() {
        let mut m = ArrivalMap::default();
        m.add("t", 10, 101);
        m.add("t", 30, 103);
        m.add("t", 20, 102);
        assert_eq!(m.convert("t", 25), 102);
        assert_eq!(m.convert("t", 30), 103);
        assert_eq!(m.convert("t", 5), 0);
        assert_eq!(m.convert("unknown", 99), 0);
    }

    #[test]
    fn column_lists_match_between_tables() {
        assert_eq!(col_list(CURSORS), "team_uid, tab_id, arrival");
        assert_eq!(POSTS.last().unwrap().0, "arrival");
        for (_, cols) in TABLES {
            let mut names: Vec<&str> = cols.iter().map(|(n, _)| *n).collect();
            names.sort_unstable();
            names.dedup();
            assert_eq!(names.len(), cols.len(), "no duplicate columns");
        }
    }
}
