//! Behavior suite for the team board, written against `BoardStore` only (no SQL), so stage 3
//! can run the same tests against PostgreSQL by giving `Fixture` a PostgreSQL variant. The
//! `sqlite_only` module at the bottom covers what is specific to the SQLite file (migration
//! from a stage-1 database, file modes, WAL, a corrupt file).

use super::model::*;
use super::config::PgTarget;
use super::pg::PgStore;
use super::sqlite::{SqliteStore, SCHEMA_VERSION};
use super::store::BoardStore;
use sqlx::Connection;
use serde_json::Value;
use std::future::Future;
use std::path::{Path, PathBuf};

/// One runtime for the whole test binary (a PostgreSQL pool stays on the runtime it was made on).
fn run<T>(f: impl Future<Output = T>) -> T {
    static RT: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RT.get_or_init(|| tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("test runtime")).block_on(f)
}

/// Which engine a shared test runs on. PostgreSQL runs only when `BBARIT_TEST_PG_URL` is set
/// (a throwaway server; every fixture gets its own schema, removed afterwards).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Engine {
    Sqlite,
    Pg,
}

fn pg_url() -> Option<String> {
    std::env::var("BBARIT_TEST_PG_URL").ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// `BBARIT_TEST_PG_REQUIRED=1`: a missing URL fails the PostgreSQL tests instead of skipping
/// them (an unreachable server fails them anyway).
fn pg_required() -> bool {
    std::env::var("BBARIT_TEST_PG_REQUIRED").is_ok_and(|v| v.trim() == "1")
}

/// Should a PostgreSQL test run? Skips (passing, with a note) without a URL unless required.
fn pg_enabled() -> bool {
    if pg_url().is_some() {
        return true;
    }
    assert!(!pg_required(), "BBARIT_TEST_PG_REQUIRED=1 but BBARIT_TEST_PG_URL is not set");
    eprintln!("skipped: set BBARIT_TEST_PG_URL to run the PostgreSQL store tests");
    false
}

/// The app instance id the sync tests run as (the app passes its own, random per start).
const TEST_INSTANCE: &str = "i-test-instance";

/// The program version the tests pass to the stores (recorded in the board).
const TEST_APP_VERSION: &str = "9.8.7-test";

/// The stores take the machine name and program version explicitly; the tests name this
/// machine `default_board_host()` (environment override or host name), like `here()`.
fn test_host() -> super::sqlite::HostFn {
    std::sync::Arc::new(super::model::default_board_host)
}

fn test_sqlite(path: PathBuf) -> SqliteStore {
    SqliteStore::new(path, test_host(), TEST_APP_VERSION)
}

fn test_sqlite_limits(path: PathBuf, limits: Limits) -> SqliteStore {
    SqliteStore::with_limits(path, limits, test_host(), TEST_APP_VERSION)
}

fn test_pg(target: PgTarget) -> PgStore {
    PgStore::new(target, TEST_APP_VERSION)
}

fn test_pg_limits(target: PgTarget, limits: Limits) -> PgStore {
    PgStore::with_limits(target, limits, TEST_APP_VERSION)
}

fn test_open_db(path: &Path) -> Result<rusqlite::Connection, String> {
    super::sqlite::open_db(path, &here(), TEST_APP_VERSION)
}

static FIXTURE_N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// A fresh board. `store()` opens a new store (its own connection or pool) on the same board,
/// the way two app windows or two machines would.
struct Fixture {
    dir: PathBuf,
    limits: Limits,
    engine: Engine,
    pg: Option<PgTarget>,
}

impl Fixture {
    fn new(e: Engine, tag: &str) -> Fixture {
        Self::with_limits(e, tag, Limits::default())
    }

    fn with_limits(e: Engine, tag: &str, limits: Limits) -> Fixture {
        let n = FIXTURE_N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "bbarit-board-{tag}-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let pg = match e {
            Engine::Sqlite => None,
            Engine::Pg => {
                let target = pg_test_target(&test_schema(tag, n));
                run(test_pg_limits(target.clone(), limits).migrate(true)).expect("create the test schema");
                Some(target)
            }
        };
        Fixture { dir, limits, engine: e, pg }
    }

    fn db(&self) -> PathBuf {
        self.dir.join(super::config::DB_FILE)
    }

    fn store(&self) -> B {
        match self.engine {
            Engine::Sqlite => B(BoardStore::Sqlite(test_sqlite_limits(self.db(), self.limits))),
            Engine::Pg => B(BoardStore::Pg(test_pg_limits(self.pg.clone().expect("pg target"), self.limits))),
        }
    }

    /// Run `sql` on the raw board (no app rules) and return the first column of every row.
    fn raw_strings(&self, sql: &str) -> Vec<String> {
        match &self.pg {
            None => {
                let c = rusqlite::Connection::open(self.db()).unwrap();
                let mut stmt = c.prepare(sql).unwrap();
                let rows: Vec<String> = stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
                rows
            }
            Some(t) => run(async {
                let mut c = pg_raw(t).await;
                sqlx::query_scalar::<_, String>(sql).fetch_all(&mut c).await.unwrap()
            }),
        }
    }

    fn raw_count(&self, sql: &str) -> i64 {
        match &self.pg {
            None => rusqlite::Connection::open(self.db()).unwrap().query_row(sql, [], |r| r.get(0)).unwrap(),
            Some(t) => run(async {
                let mut c = pg_raw(t).await;
                sqlx::query_scalar::<_, i64>(sql).fetch_one(&mut c).await.unwrap()
            }),
        }
    }

    fn raw_exec(&self, sql: &str) {
        match &self.pg {
            None => {
                rusqlite::Connection::open(self.db()).unwrap().execute_batch(sql).unwrap();
            }
            Some(t) => run(async {
                let mut c = pg_raw(t).await;
                sqlx::raw_sql(sql).execute(&mut c).await.unwrap();
            }),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
        if let Some(t) = &self.pg {
            remove_test_schema(t);
        }
    }
}

/// `bbt_<pid>_<n>_<tag>`: unique per fixture and run, a valid schema name.
fn test_schema(tag: &str, n: usize) -> String {
    let clean: String = tag.chars().filter(|c| c.is_ascii_alphanumeric()).take(20).collect::<String>().to_ascii_lowercase();
    format!("bbt_{}_{n}_{clean}", std::process::id())
}

fn remove_test_schema(t: &PgTarget) {
    let statement = format!("DROP SCHEMA IF EXISTS {} CASCADE", super::config::quote_ident(&t.schema));
    run(async {
        if let Ok(mut c) = sqlx::PgConnection::connect_with(&t.opts).await {
            let _ = sqlx::query(&statement).execute(&mut c).await;
            let _ = c.close().await;
        }
    });
}

/// The test server with `schema` as the board schema.
fn pg_test_target(schema: &str) -> PgTarget {
    let url = pg_url().expect("BBARIT_TEST_PG_URL");
    let settings = super::config::PgSettings { schema: schema.to_string(), ..Default::default() };
    super::config::pg_target(&settings, Some(&url), None).unwrap()
}

/// A plain connection whose search_path is the fixture's schema (for raw checks).
async fn pg_raw(t: &PgTarget) -> sqlx::PgConnection {
    let mut c = sqlx::PgConnection::connect_with(&t.opts).await.unwrap();
    sqlx::query(&format!("SET search_path TO {}", super::config::quote_ident(&t.schema))).execute(&mut c).await.unwrap();
    c
}

/// Every shared test once per engine: `on_sqlite::<name>` always, `on_postgres::<name>` when
/// `BBARIT_TEST_PG_URL` is set (otherwise it passes after printing that it was skipped).
macro_rules! shared_tests {
    ($($name:ident),* $(,)?) => {
        mod on_sqlite {
            $( #[test] fn $name() { super::$name(super::Engine::Sqlite) } )*
        }
        mod on_postgres {
            $( #[test] fn $name() {
                if super::pg_enabled() {
                    super::$name(super::Engine::Pg)
                }
            } )*
        }
    };
}

/// This machine's host id (what the app records, and what a migrated team's home is).
fn here() -> String {
    super::model::default_board_host()
}

fn cx(now: i64) -> Ctx {
    Ctx { now, host: Some(here()), instance: "inst-a".into() }
}

fn cx_other(now: i64) -> Ctx {
    Ctx { now, host: Some("host-b".into()), instance: "inst-b".into() }
}

fn member(id: &str) -> Actor {
    Actor { id: id.into(), name: Some(format!("{id} name")), cli: Some("claude".into()), host: Some(here()), root: false, human: false }
}

/// A tab on another machine.
fn remote(id: &str) -> Actor {
    Actor { host: Some("host-b".into()), ..member(id) }
}

fn root(id: &str) -> Actor {
    Actor { root: true, ..member(id) }
}

fn human() -> Actor {
    Actor { id: "user".into(), name: Some("user".into()), cli: None, host: Some(here()), root: false, human: true }
}

fn op(name: &str) -> TaskOpInput {
    TaskOpInput { op: name.into(), ..Default::default() }
}

fn on(name: &str, task: i64) -> TaskOpInput {
    TaskOpInput { op: name.into(), task: Some(task), ..Default::default() }
}

fn done_op(task: i64, summary: &str) -> TaskOpInput {
    TaskOpInput { result: Some(ResultInput { summary: Some(summary.into()), ..Default::default() }), ..on("done", task) }
}

fn input(author: &str, kind: &str, text: &str) -> PostInput {
    PostInput {
        team_name: Some("lead".into()),
        author_id: author.into(),
        author_name: Some(format!("{author} name")),
        author_cli: Some("claude".into()),
        kind: kind.into(),
        text: text.into(),
        task: None,
        root: false,
    }
}

fn seqs(v: &Value) -> Vec<i64> {
    v["posts"].as_array().unwrap().iter().map(|p| p["seq"].as_i64().unwrap()).collect()
}

fn task_seqs(v: &Value) -> Vec<i64> {
    v["tasks"].as_array().unwrap().iter().map(|t| t["seq"].as_i64().unwrap()).collect()
}

/// Synchronous wrappers over the async interface (tests only).
struct B(BoardStore);

impl B {
    fn post(&self, team: &str, p: PostInput, now: i64) -> Result<Value, String> {
        run(self.0.post(team.into(), p, cx(now)))
    }
    fn read(&self, team: &str, q: ReadQuery) -> Result<Value, String> {
        run(self.0.read(team.into(), q, Some(here())))
    }
    fn teams(&self) -> Vec<Value> {
        run(self.0.teams()).unwrap()
    }
    fn clear(&self, team: &str, now: i64) -> Result<Value, String> {
        run(self.0.clear(team.into(), cx(now)))
    }
    fn w(&self, team: &str, o: TaskOpInput, a: &Actor, c: Ctx) -> Result<Value, String> {
        run(self.0.task_write(team.into(), o, a.clone(), c))
    }
    fn add(&self, team: &str, title: &str, a: &Actor, now: i64) -> i64 {
        let o = TaskOpInput { title: Some(title.into()), ..op("add") };
        self.w(team, o, a, cx(now)).unwrap()["task"]["seq"].as_i64().unwrap()
    }
    fn list(&self, team: &str, q: TaskListQuery, now: i64) -> Value {
        run(self.0.task_list(team.into(), q, cx(now))).unwrap()
    }
    fn show(&self, team: &str, seq: i64, now: i64) -> Value {
        run(self.0.task_show(team.into(), seq, true, None, cx(now))).unwrap()
    }
    fn state(&self, team: &str, seq: i64, now: i64) -> String {
        self.show(team, seq, now)["task"]["state"].as_str().unwrap().to_string()
    }
}

// ── Notes ────────────────────────────────────────────────────────────────

#[test]
fn dev_build_uses_the_dev_database() {
    assert_eq!(super::config::DB_FILE, "agent-board.dev.db", "tests are debug builds");
}

fn posts_get_increasing_seqs_and_read_back_in_order(e: Engine) {
    let fx = Fixture::new(e, "basic");
    let s = fx.store();
    let a = s.post("root1", input("t1", "note", "first"), 1_000).unwrap();
    let b = s.post("root1", input("t2", "finding", "second\nline two"), 2_000).unwrap();
    let other = s.post("root2", input("t9", "note", "elsewhere"), 3_000).unwrap();
    assert_eq!(a["seq"], 1);
    assert_eq!(b["seq"], 2);
    assert_eq!(other["seq"], 1, "seq is per team");
    assert_eq!(b["author"]["id"], "t2");
    assert_eq!(b["author"]["cliType"], "claude");
    assert_eq!(b["author"]["host"], here());
    let r = s.read("root1", ReadQuery::default()).unwrap();
    assert_eq!(seqs(&r), vec![1, 2]);
    assert_eq!(r["posts"][1]["text"], "second\nline two");
    assert_eq!(r["teamName"], "lead");
    assert_eq!(r["lastSeq"], 2);
    assert_eq!(r["total"], 2);
}

fn concurrent_posts_never_share_a_seq(e: Engine) {
    let fx = Fixture::new(e, "concurrent");
    fx.store().post("team-x", input("t0", "note", "first"), 1).unwrap();
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let s = fx.store();
            std::thread::spawn(move || {
                (0..5)
                    .map(|j| s.post("team-x", input(&format!("t{i}"), "note", &format!("p{i}-{j}")), 1_000).unwrap()["seq"].as_i64().unwrap())
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    let mut all: Vec<i64> = handles.into_iter().flat_map(|h| h.join().unwrap()).collect();
    all.sort_unstable();
    assert_eq!(all, (2..=41).collect::<Vec<_>>());
}

fn refuses_bad_team_ids_kinds_and_text(e: Engine) {
    let fx = Fixture::new(e, "refuse");
    let s = fx.store();
    for bad in ["", "../x", "a/b", "a b", ".", "t1;drop", &"x".repeat(129)] {
        assert!(s.post(bad, input("t1", "note", "hi"), 1).is_err(), "{bad:?}");
        assert!(s.read(bad, ReadQuery::default()).is_err(), "{bad:?}");
        assert!(s.clear(bad, 1).is_err(), "{bad:?}");
        assert!(s.w(bad, TaskOpInput { title: Some("x".into()), ..op("add") }, &member("t1"), cx(1)).is_err(), "{bad:?}");
    }
    assert!(valid_team_id("1731000000000abc_DEF-9"));
    assert!(s.post("t", input("t1", "shout", "hi"), 1).unwrap_err().contains("invalid kind"));
    assert_eq!(s.post("t", input("t1", "note", " \n\t "), 1).unwrap_err(), "text required");
    let long = "y".repeat(MAX_TEXT_CHARS + 1);
    assert!(s.post("t", input("t1", "note", &long), 1).unwrap_err().contains("too long"));
    let many = vec!["l"; MAX_TEXT_LINES + 1].join("\n");
    assert!(s.post("t", input("t1", "note", &many), 1).unwrap_err().contains("too many lines"));
    assert!(s.post("t", input(" ", "note", "x"), 1).is_err(), "author required");
    let max = "z".repeat(MAX_TEXT_CHARS);
    assert!(s.post("t", input("t1", "note", &max), 1).is_ok());
    let p = s.post("t", input("t1", "NOTE", "a\u{1b}[31mb\r\nc\u{7}\td"), 1).unwrap();
    assert_eq!(p["text"], "a[31mb\nc d");
    assert_eq!(p["kind"], "note");
}

fn keeps_only_the_newest_posts_per_team(e: Engine) {
    let fx = Fixture::with_limits(e, "cap", Limits { posts: 5, ..Limits::default() });
    let s = fx.store();
    for i in 1..=5 {
        s.post("cap", input("t1", "note", &format!("p{i}")), i).unwrap();
    }
    s.post("other", input("t2", "note", "untouched"), 2).unwrap();
    let p = s.post("cap", input("t1", "done", "newest"), 9).unwrap();
    assert_eq!(p["seq"], 6);
    let r = s.read("cap", ReadQuery { limit: Some(500), ..Default::default() }).unwrap();
    assert_eq!(seqs(&r), vec![2, 3, 4, 5, 6], "the oldest post was dropped");
    assert_eq!(s.read("other", ReadQuery::default()).unwrap()["total"], 1);
}

fn read_filters_since_limit_kind_author_and_search(e: Engine) {
    let fx = Fixture::new(e, "filters");
    let s = fx.store();
    s.post("f", input("t1", "note", "build is green"), 1).unwrap();
    s.post("f", input("t2", "finding", "100% of tests pass"), 2).unwrap();
    s.post("f", input("t2", "decision", "use snake_case names"), 3).unwrap();
    s.post("f", input("t3", "done", "ALL DONE"), 4).unwrap();
    s.post("f", input("t1", "note", "path C:\\tmp\\x"), 5).unwrap();
    let r = |rq: ReadQuery| seqs(&s.read("f", ReadQuery { limit: Some(500), ..rq }).unwrap());
    assert_eq!(r(ReadQuery { since: Some(3), ..Default::default() }), vec![4, 5]);
    assert_eq!(r(ReadQuery { kind: Some("Finding".into()), ..Default::default() }), vec![2]);
    assert_eq!(r(ReadQuery { author: Some("t2".into()), ..Default::default() }), vec![2, 3]);
    assert_eq!(r(ReadQuery { author: Some("T3 NAME".into()), ..Default::default() }), vec![4], "names match without case");
    assert_eq!(r(ReadQuery { search: Some("done".into()), ..Default::default() }), vec![4], "ASCII case-insensitive");
    assert_eq!(r(ReadQuery { search: Some("100%".into()), ..Default::default() }), vec![2]);
    assert_eq!(r(ReadQuery { search: Some("%".into()), ..Default::default() }), vec![2]);
    assert_eq!(r(ReadQuery { search: Some("e_c".into()), ..Default::default() }), vec![3]);
    assert_eq!(r(ReadQuery { search: Some("_".into()), ..Default::default() }), vec![3]);
    assert_eq!(r(ReadQuery { search: Some("C:\\tmp".into()), ..Default::default() }), vec![5]);
    assert!(r(ReadQuery { search: Some("' OR 1=1 --".into()), ..Default::default() }).is_empty());
    assert_eq!(r(ReadQuery { exclude_author: Some("t1".into()), ..Default::default() }), vec![2, 3, 4]);
    let tail = s.read("f", ReadQuery { limit: Some(2), ..Default::default() }).unwrap();
    assert_eq!(seqs(&tail), vec![4, 5], "limit keeps the newest");
    assert_eq!(tail["matched"], 5);
    assert_eq!(tail["more"], 3);
    assert!(s.read("f", ReadQuery { kind: Some("bad".into()), ..Default::default() }).is_err());
    assert_eq!(like_pattern("a%b_c\\"), "%a\\%b\\_c\\\\%");
    let empty = s.read("nothing", ReadQuery::default()).unwrap();
    assert_eq!(empty["lastSeq"], 0);
    assert!(empty["posts"].as_array().unwrap().is_empty());
}

fn cursors_move_on_new_reads_skip_own_posts_and_survive_a_reopen(e: Engine) {
    let fx = Fixture::new(e, "cursor");
    let newq = || ReadQuery { cursor_tab: Some("t1".into()), exclude_author: Some("t1".into()), ..Default::default() };
    {
        let s = fx.store();
        s.post("c", input("t1", "note", "mine"), 1).unwrap();
        s.post("c", input("t2", "note", "theirs"), 2).unwrap();
        let first = s.read("c", newq()).unwrap();
        assert_eq!(seqs(&first), vec![2]);
        assert_eq!(first["cursor"], 0);
        assert!(first["nextCursor"].as_i64().unwrap() > 0);
        assert!(seqs(&s.read("c", newq()).unwrap()).is_empty(), "nothing new");
        s.post("c", input("t3", "note", "later"), 3).unwrap();
        assert_eq!(seqs(&s.read("c", ReadQuery::default()).unwrap()), vec![1, 2, 3]);
    }
    // App restart: a fresh store still knows t1 has read up to seq 2.
    let s = fx.store();
    let again = s.read("c", newq()).unwrap();
    assert_eq!(seqs(&again), vec![3]);
    assert!(again["cursor"].as_i64().unwrap() > 0, "the cursor survived the reopen");
}

fn new_reads_page_oldest_first_and_never_skip_unread_posts(e: Engine) {
    let fx = Fixture::new(e, "paging");
    let s = fx.store();
    for seq in 1..=40 {
        let author = if seq % 2 == 1 { "t2" } else { "t1" };
        s.post("p", input(author, "note", &format!("post {seq}")), seq).unwrap();
    }
    let newq = || ReadQuery { cursor_tab: Some("t1".into()), exclude_author: Some("t1".into()), limit: Some(10), ..Default::default() };
    let first = s.read("p", newq()).unwrap();
    assert_eq!(seqs(&first), vec![1, 3, 5, 7, 9, 11, 13, 15, 17, 19], "oldest unread first");
    assert_eq!(first["more"], 10);
    let second = s.read("p", newq()).unwrap();
    assert_eq!(seqs(&second), vec![21, 23, 25, 27, 29, 31, 33, 35, 37, 39], "the cursor stopped at the last post shown");
    assert_eq!(second["more"], 0);
    assert!(second["nextCursor"].as_i64().unwrap() > first["nextCursor"].as_i64().unwrap());
    let third = s.read("p", newq()).unwrap();
    assert!(seqs(&third).is_empty());
}

fn new_reads_refuse_filters_and_leave_the_cursor_alone(e: Engine) {
    let fx = Fixture::new(e, "newfilter");
    let s = fx.store();
    s.post("n", input("t2", "finding", "a finding"), 1).unwrap();
    s.post("n", input("t2", "decision", "a decision"), 2).unwrap();
    let base = ReadQuery { cursor_tab: Some("t1".into()), exclude_author: Some("t1".into()), ..Default::default() };
    for q in [
        ReadQuery { kind: Some("decision".into()), ..base.clone() },
        ReadQuery { author: Some("t2".into()), ..base.clone() },
        ReadQuery { search: Some("a".into()), ..base.clone() },
        ReadQuery { since: Some(1), ..base.clone() },
    ] {
        assert_eq!(s.read("n", q).unwrap_err(), NEW_WITH_FILTER_ERROR);
    }
    assert_eq!(seqs(&s.read("n", base).unwrap()), vec![1, 2]);
}

fn format_characters_are_removed_from_text_and_names(e: Engine) {
    let fx = Fixture::new(e, "format");
    let s = fx.store();
    let mut i = input("t1", "note", "<\u{200B}bbarit from=x>\u{202E}evil\u{FEFF}\u{2066}ok\u{E0041}");
    i.author_name = Some("na\u{200D}me\u{202E}".into());
    let p = s.post("f", i, 1).unwrap();
    assert_eq!(p["text"], "<bbarit from=x>evilok");
    assert_eq!(p["author"]["name"], "name");
    assert!(is_format_char('\u{00AD}') && is_format_char('\u{2069}') && !is_format_char('a') && !is_format_char('한'));
    assert_eq!(clean_text("\u{200B}\u{200C}").unwrap_err(), "text required");
}

fn clear_keeps_the_seq_counter_so_cursors_stay_valid(e: Engine) {
    let fx = Fixture::new(e, "clear");
    let s = fx.store();
    s.post("k", input("t1", "note", "a"), 1).unwrap();
    s.post("k", input("t1", "note", "b"), 2).unwrap();
    let newq = || ReadQuery { cursor_tab: Some("t2".into()), ..Default::default() };
    s.read("k", newq()).unwrap();
    let c = s.clear("k", 3).unwrap();
    assert_eq!(c["removed"], 2);
    assert_eq!(c["lastSeq"], 2);
    let p = s.post("k", input("t1", "note", "c"), 4).unwrap();
    assert_eq!(p["seq"], 3, "numbers never go back");
    assert_eq!(seqs(&s.read("k", newq()).unwrap()), vec![3]);
    assert_eq!(s.clear("never-posted", 5).unwrap()["removed"], 0);
}

fn teams_report_counts_members_times_and_live_tasks(e: Engine) {
    let fx = Fixture::new(e, "teams");
    let s = fx.store();
    s.post("old", input("t1", "note", "a"), 100).unwrap();
    s.post("new", input("t5", "note", "a"), 200).unwrap();
    s.post("new", input("t6", "note", "b"), 300).unwrap();
    s.post("new", input("t6", "done", "c"), 400).unwrap();
    s.add("new", "task one", &member("t5"), 400);
    let list = s.teams();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["team"], "new", "newest first");
    assert_eq!(list[0]["posts"], 3);
    assert_eq!(list[0]["members"], 2);
    assert_eq!(list[0]["firstTs"], 200);
    assert_eq!(list[0]["lastTs"], 400);
    assert_eq!(list[0]["teamName"], "lead");
    assert_eq!(list[0]["liveTasks"], 1);
    s.clear("old", 500).unwrap();
    let list = s.teams();
    let old = list.iter().find(|t| t["team"] == "old").unwrap();
    assert_eq!(old["posts"], 0);
    assert!(old["lastTs"].is_null());
}

fn prunes_teams_idle_for_thirty_days_with_their_tasks(e: Engine) {
    let fx = Fixture::new(e, "prune");
    let s = fx.store();
    let day = 24 * 60 * 60 * 1000;
    let now = 100 * day;
    s.post("stale", input("t1", "note", "old"), now - 31 * day).unwrap();
    let t = s.add("stale", "old task", &member("t1"), now - 31 * day);
    s.w("stale", on("claim", t), &member("t1"), cx(now - 31 * day)).unwrap();
    s.post("fresh", input("t2", "note", "old"), now - 40 * day).unwrap();
    s.post("fresh", input("t2", "note", "recent"), now - day).unwrap();
    s.add("busy", "a task added recently", &member("t3"), now - day);
    s.read("stale", ReadQuery { cursor_tab: Some("t9".into()), ..Default::default() }).unwrap();
    assert_eq!(run(s.0.prune_stale(now, STALE_AFTER_MS)).unwrap(), 1);
    let mut names: Vec<String> = s.teams().iter().map(|t| t["team"].as_str().unwrap().to_string()).collect();
    names.sort();
    assert_eq!(names, vec!["busy", "fresh"]);
    assert!(task_seqs(&s.list("stale", TaskListQuery { all: true, ..Default::default() }, now)).is_empty());
    assert_eq!(s.read("fresh", ReadQuery::default()).unwrap()["total"], 2, "a live board keeps old posts");
}

fn announcements_are_root_only_and_pinned_first(e: Engine) {
    let fx = Fixture::new(e, "announce");
    let s = fx.store();
    assert!(s.post("a", input("c1", "announce", "plan"), 1).unwrap_err().contains("only the team's root tab"));
    s.post("a", PostInput { root: true, ..input("root", "announce", "the plan: split by module") }, 1).unwrap();
    s.post("a", input("c1", "note", "started"), 2).unwrap();
    let r = s.read("a", ReadQuery::default()).unwrap();
    assert_eq!(seqs(&r), vec![2], "announcements are not repeated in the list");
    assert_eq!(r["announcements"][0]["text"], "the plan: split by module");
    // --new shows them in order like any unread post.
    let n = s.read("a", ReadQuery { cursor_tab: Some("c2".into()), exclude_author: Some("c2".into()), ..Default::default() }).unwrap();
    assert_eq!(seqs(&n), vec![1, 2]);
    // A kind filter shows them as plain posts.
    assert_eq!(seqs(&s.read("a", ReadQuery { kind: Some("announce".into()), ..Default::default() }).unwrap()), vec![1]);
}

fn posts_link_to_a_task_of_the_same_team(e: Engine) {
    let fx = Fixture::new(e, "link");
    let s = fx.store();
    let t = s.add("l", "write docs", &member("c1"), 1);
    let p = s.post("l", PostInput { task: Some(t), ..input("c1", "finding", "docs need a schema section") }, 2).unwrap();
    assert_eq!(p["task"], t);
    assert_eq!(s.read("l", ReadQuery::default()).unwrap()["posts"][0]["task"], t);
    assert_eq!(s.post("l", PostInput { task: Some(99), ..input("c1", "note", "x") }, 3).unwrap_err(), "no task #99 in team l");
    assert!(s.post("other", PostInput { task: Some(t), ..input("c1", "note", "x") }, 3).is_err(), "same team only");
}

// ── Tasks: transitions ───────────────────────────────────────────────────

fn add_list_and_show_a_task(e: Engine) {
    let fx = Fixture::new(e, "add");
    let s = fx.store();
    let o = TaskOpInput {
        title: Some("  Fix the login test ".into()),
        body: Some("steps:\n1. run it\n2. fix it".into()),
        priority: Some(2),
        labels: Some(vec!["tests".into(), "tests".into(), "auth".into()]),
        team_name: Some("lead".into()),
        ..op("add")
    };
    let r = s.w("t", o, &member("lead"), cx(10)).unwrap();
    assert_eq!(r["action"], "add");
    assert_eq!(r["to"], "open");
    let t = &r["task"];
    assert_eq!(t["seq"], 1);
    assert_eq!(t["title"], "Fix the login test");
    assert_eq!(t["body"], "steps:\n1. run it\n2. fix it");
    assert_eq!(t["priority"], 2);
    assert_eq!(t["labels"], serde_json::json!(["tests", "auth"]));
    assert_eq!(t["createdBy"]["id"], "lead");
    assert_eq!(t["createdBy"]["host"], here());
    assert_eq!(t["owner"], Value::Null);
    assert_eq!(t["attempt"], 0);
    assert_eq!(t["maxAttempts"], 3);
    assert_eq!(s.add("t", "second", &member("lead"), 11), 2);
    assert_eq!(s.add("u", "other team", &member("x"), 11), 1, "numbers are per team");
    let l = s.list("t", TaskListQuery::default(), 12);
    assert_eq!(task_seqs(&l), vec![1, 2], "priority first");
    assert_eq!(l["counts"]["open"], 2);
    assert_eq!(l["teamName"], "lead");
    let shown = s.show("t", 1, 12);
    assert_eq!(shown["events"][0]["action"], "add");
    assert_eq!(shown["events"][0]["to"], "open");
    // Refused inputs.
    for (o, msg) in [
        (op("add"), "title required"),
        (TaskOpInput { title: Some("x".repeat(201)), ..op("add") }, "title too long"),
        (TaskOpInput { title: Some("x".into()), priority: Some(4), ..op("add") }, "priority must be 0-3"),
        (TaskOpInput { title: Some("x".into()), parent: Some(9), ..op("add") }, "no task #9 in team t"),
        (TaskOpInput { title: Some("x".into()), after: vec![7], ..op("add") }, "no task #7 in team t"),
        (TaskOpInput { title: Some("x".into()), body: Some("y".repeat(MAX_BODY_CHARS + 1)), ..op("add") }, "body too long"),
    ] {
        let e = s.w("t", o, &member("lead"), cx(13)).unwrap_err();
        assert!(e.contains(msg), "{e}");
    }
    assert!(s.w("t", on("frobnicate", 1), &member("lead"), cx(13)).unwrap_err().contains("unknown task operation"));
    assert_eq!(s.w("t", on("claim", 42), &member("lead"), cx(13)).unwrap_err(), "no task #42 in team t");
    assert!(s.w("t", op("claim"), &member("lead"), cx(13)).unwrap_err().contains("task number required"));
}

fn claim_block_unblock_done_writes_history_and_a_done_note(e: Engine) {
    let fx = Fixture::new(e, "flow");
    let s = fx.store();
    let t = s.add("f", "build the parser", &member("lead"), 1);
    let c = s.w("f", TaskOpInput { lease_ms: Some(60_000), ..on("claim", t) }, &member("c1"), cx(100)).unwrap();
    assert_eq!((c["from"].as_str(), c["to"].as_str()), (Some("open"), Some("claimed")));
    let task = &c["task"];
    assert_eq!(task["owner"]["id"], "c1");
    assert_eq!(task["owner"]["instance"], "inst-a");
    assert_eq!(task["owner"]["host"], here());
    assert_eq!(task["leaseUntil"], 60_100);
    assert_eq!(task["claimedAt"], 100);
    assert_eq!(task["startedAt"], 100);
    let e = s.w("f", on("block", t), &member("c1"), cx(110)).unwrap_err();
    assert!(e.starts_with("reason required"), "{e}");
    let b = s.w("f", TaskOpInput { reason: Some("needs the API key from the user".into()), ..on("block", t) }, &member("c1"), cx(120)).unwrap();
    assert_eq!(b["task"]["state"], "blocked");
    assert_eq!(b["task"]["blockedReason"], "needs the API key from the user");
    assert!(s.w("f", done_op(t, "x"), &member("c1"), cx(125)).unwrap_err().contains("unblock it first"));
    s.w("f", on("unblock", t), &member("c1"), cx(130)).unwrap();
    assert!(s.w("f", on("done", t), &member("c1"), cx(135)).unwrap_err().starts_with("summary required"));
    let d = s
        .w(
            "f",
            TaskOpInput {
                result: Some(ResultInput {
                    summary: Some("parser done, 12 tests".into()),
                    body: Some("details\nmore".into()),
                    branch: Some("agent/parser".into()),
                    commit: Some("abc1234".into()),
                    worktree: Some("/repo/.bbarit/worktrees/parser".into()),
                    checks: Some("passed".into()),
                    artifacts: [("pr".to_string(), "https://example.invalid/pr/7".to_string())].into_iter().collect(),
                }),
                ..on("done", t)
            },
            &member("c1"),
            cx(140),
        )
        .unwrap();
    assert_eq!(d["to"], "done");
    let r = &d["task"]["result"];
    assert_eq!(r["summary"], "parser done, 12 tests");
    assert_eq!(r["branch"], "agent/parser");
    assert_eq!(r["checks"], "passed");
    assert_eq!(r["artifacts"]["pr"], "https://example.invalid/pr/7");
    assert_eq!(d["task"]["finishedAt"], 140);
    assert_eq!(d["task"]["leaseUntil"], Value::Null);
    // The linked done note.
    let post_seq = d["post"].as_i64().unwrap();
    let posts = s.read("f", ReadQuery::default()).unwrap();
    let note = posts["posts"].as_array().unwrap().iter().find(|p| p["seq"] == post_seq).unwrap().clone();
    assert_eq!(note["kind"], "done");
    assert_eq!(note["task"], t);
    assert_eq!(note["author"]["id"], "c1");
    assert!(note["text"].as_str().unwrap().starts_with("#1 done: build the parser\nparser done, 12 tests\nbranch agent/parser, commit abc1234, checks passed"));
    let actions: Vec<String> = s.show("f", t, 150)["events"].as_array().unwrap().iter().map(|e| e["action"].as_str().unwrap().to_string()).collect();
    assert_eq!(actions, vec!["add", "claim", "block", "unblock", "done"]);
    let ev = s.show("f", t, 150)["events"][2].clone();
    assert_eq!(ev["note"], "needs the API key from the user");
    assert_eq!(ev["from"], "claimed");
    assert_eq!(ev["to"], "blocked");
    assert_eq!(ev["actor"]["id"], "c1");
}

fn refusals_name_the_current_state_and_owner(e: Engine) {
    let fx = Fixture::new(e, "refusals");
    let s = fx.store();
    let t = s.add("r", "a task", &member("lead"), 1);
    s.w("r", on("claim", t), &member("b2"), cx(2)).unwrap();
    assert_eq!(s.w("r", on("claim", t), &member("c3"), cx(3)).unwrap_err(), "#1 is already claimed by b2 (b2 name)");
    assert_eq!(
        s.w("r", on("release", t), &member("c3"), cx(3)).unwrap_err(),
        "#1 is claimed by b2 (b2 name): only its owner can release it"
    );
    assert!(s.w("r", done_op(t, "x"), &member("c3"), cx(3)).unwrap_err().contains("only its owner can finish it"));
    assert!(s.w("r", TaskOpInput { error: Some("x".into()), ..on("fail", t) }, &member("c3"), cx(3)).is_err());
    assert!(s.w("r", on("approve", t), &member("c3"), cx(3)).unwrap_err().contains("only a task in review"));
    assert!(s.w("r", on("reopen", t), &root("lead"), cx(3)).unwrap_err().contains("only a done task"));
    assert!(s.w("r", on("cancel", t), &member("c3"), cx(3)).unwrap_err().contains("who added it (lead)"));
    // Still claimed by b2: refusals changed nothing.
    assert_eq!(s.state("r", t, 4), "claimed");
    s.w("r", on("release", t), &member("b2"), cx(5)).unwrap();
    let after = s.show("r", t, 6);
    assert_eq!(after["task"]["state"], "open");
    assert_eq!(after["task"]["owner"], Value::Null);
    assert_eq!(after["task"]["attempt"], 0, "release keeps the attempt");
    s.w("r", on("cancel", t), &member("lead"), cx(7)).unwrap();
    assert!(s.w("r", on("cancel", t), &root("lead"), cx(8)).unwrap_err().contains("cannot be cancelled"));
    assert!(s.w("r", on("claim", t), &member("c3"), cx(8)).unwrap_err().contains("nothing to claim"));
}

fn cancel_by_creator_root_or_person_but_never_done(e: Engine) {
    let fx = Fixture::new(e, "cancel");
    let s = fx.store();
    let a = s.add("c", "a", &member("c1"), 1);
    let b = s.add("c", "b", &member("c1"), 1);
    let d = s.add("c", "d", &member("c1"), 1);
    s.w("c", on("claim", b), &member("c2"), cx(2)).unwrap();
    assert_eq!(s.w("c", on("cancel", a), &root("lead"), cx(3)).unwrap()["to"], "cancelled");
    assert_eq!(s.w("c", on("cancel", b), &human(), cx(3)).unwrap()["task"]["leaseUntil"], Value::Null, "a claimed task can be cancelled");
    s.w("c", on("claim", d), &member("c2"), cx(4)).unwrap();
    s.w("c", done_op(d, "ok"), &member("c2"), cx(5)).unwrap();
    assert!(s.w("c", on("cancel", d), &human(), cx(6)).unwrap_err().contains("is done: it cannot be cancelled"));
    let ev = s.show("c", b, 7)["events"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(ev["actor"]["id"], "user");
    assert_eq!(ev["action"], "cancel");
}

fn eight_claimers_on_one_task_exactly_one_wins(e: Engine) {
    let fx = Fixture::new(e, "race");
    let t = fx.store().add("race", "only one", &member("lead"), 1);
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let s = fx.store();
            std::thread::spawn(move || s.w("race", on("claim", t), &member(&format!("c{i}")), cx(10)))
        })
        .collect();
    let results: Vec<Result<Value, String>> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let winners: Vec<&Value> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
    assert_eq!(winners.len(), 1, "{results:?}");
    let owner = winners[0]["task"]["owner"]["id"].as_str().unwrap().to_string();
    for e in results.iter().filter_map(|r| r.as_ref().err()) {
        assert_eq!(e, &format!("#1 is already claimed by {owner} ({owner} name)"));
    }
    let events = fx.store().show("race", t, 20)["events"].as_array().unwrap().iter().filter(|e| e["action"] == "claim").count();
    assert_eq!(events, 1);
}

fn eight_next_claimers_over_eight_tasks_all_get_different_ones(e: Engine) {
    let fx = Fixture::new(e, "next");
    let s = fx.store();
    for i in 1..=8 {
        s.add("n", &format!("task {i}"), &member("lead"), i);
    }
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let s = fx.store();
            std::thread::spawn(move || {
                s.w("n", TaskOpInput { next: true, ..op("claim") }, &member(&format!("c{i}")), cx(100)).unwrap()["task"]["seq"].as_i64().unwrap()
            })
        })
        .collect();
    let mut got: Vec<i64> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    got.sort_unstable();
    assert_eq!(got, (1..=8).collect::<Vec<_>>());
    let none = s.w("n", TaskOpInput { next: true, ..op("claim") }, &member("c9"), cx(101)).unwrap();
    assert_eq!(none["task"], Value::Null);
    assert_eq!(none["none"], "no open task to claim");
}

fn next_picks_priority_then_number_and_skips_waiting_tasks(e: Engine) {
    let fx = Fixture::new(e, "order");
    let s = fx.store();
    let low = s.add("o", "low", &member("lead"), 1);
    let first = s.add("o", "first", &member("lead"), 1);
    let w = s.w("o", TaskOpInput { title: Some("urgent but waiting".into()), priority: Some(3), after: vec![first], ..op("add") }, &member("lead"), cx(1)).unwrap();
    let waiting = w["task"]["seq"].as_i64().unwrap();
    assert_eq!(w["task"]["waiting"], true);
    assert_eq!(w["task"]["waitingOn"], serde_json::json!([first]));
    let high = s.w("o", TaskOpInput { title: Some("high".into()), priority: Some(2), ..op("add") }, &member("lead"), cx(1)).unwrap()["task"]["seq"].as_i64().unwrap();
    let next = |who: &str| s.w("o", TaskOpInput { next: true, ..op("claim") }, &member(who), cx(5)).unwrap()["task"]["seq"].as_i64();
    assert_eq!(next("a"), Some(high));
    assert_eq!(next("b"), Some(low), "same priority: lower number first");
    assert_eq!(next("c"), Some(first));
    let none = s.w("o", TaskOpInput { next: true, ..op("claim") }, &member("d"), cx(5)).unwrap();
    assert_eq!(none["none"], "no open task is ready: 1 wait for dependencies");
    let e = s.w("o", on("claim", waiting), &member("d"), cx(5)).unwrap_err();
    assert_eq!(e, format!("#{waiting} is waiting for #{first} (claimed): claim a ready task (agent task list --ready)"));
    s.w("o", done_op(first, "done"), &member("c"), cx(6)).unwrap();
    assert_eq!(next("d"), Some(waiting), "ready once its dependency is done");
}

fn next_with_labels_only_takes_tasks_carrying_one_of_them(e: Engine) {
    let fx = Fixture::new(e, "labels");
    let s = fx.store();
    let add = |title: &str, labels: &[&str], priority: i64| {
        s.w("l", TaskOpInput { title: Some(title.into()), priority: Some(priority), labels: Some(labels.iter().map(|l| l.to_string()).collect()), ..op("add") }, &member("lead"), cx(1)).unwrap()["task"]["seq"].as_i64().unwrap()
    };
    let impl_low = add("impl low", &["impl"], 1);
    let test_high = add("test high", &["test", "ci"], 3);
    let impl_high = add("impl high", &["impl", "backend"], 2);
    let review = add("review", &["review"], 3);
    let plain = add("no label", &[], 3);
    let next = |who: &str, labels: &[&str]| {
        s.w("l", TaskOpInput { next: true, labels: Some(labels.iter().map(|l| l.to_string()).collect()), ..op("claim") }, &member(who), cx(5)).unwrap()
    };
    // Same order rules (priority, then number) within the matching tasks.
    assert_eq!(next("i1", &["impl"])["task"]["seq"].as_i64(), Some(impl_high));
    assert_eq!(next("i2", &["impl"])["task"]["seq"].as_i64(), Some(impl_low));
    let none = next("i3", &["impl"]);
    assert_eq!(none["task"], Value::Null);
    assert_eq!(none["none"], "no open task to claim", "other roles' open tasks do not count");
    // Several labels: any of them; labels are trimmed like stored ones.
    assert_eq!(next("t1", &[" ci ", "review"])["task"]["seq"].as_i64(), Some(test_high));
    assert_eq!(next("t2", &["ci", "review"])["task"]["seq"].as_i64(), Some(review));
    // No label filter: any ready task, the unlabeled one included.
    assert_eq!(next("any", &[])["task"]["seq"].as_i64(), Some(plain));
    // --label without --next is refused.
    let e = s.w("l", TaskOpInput { labels: Some(vec!["impl".into()]), ..on("claim", impl_low) }, &member("x"), cx(6)).unwrap_err();
    assert_eq!(e, "agent task claim: --label goes with --next");
}

fn dependencies_gate_claims_and_cycles_are_refused(e: Engine) {
    let fx = Fixture::new(e, "deps");
    let s = fx.store();
    let a = s.add("d", "a", &member("lead"), 1);
    let b = s.add("d", "b", &member("lead"), 1);
    let c = s.add("d", "c", &member("lead"), 1);
    let dep = |task: i64, onto: i64, name: &str| s.w("d", TaskOpInput { on: Some(onto), ..on(name, task) }, &member("lead"), cx(2));
    dep(b, a, "dep_add").unwrap();
    dep(c, b, "dep_add").unwrap();
    assert_eq!(dep(a, c, "dep_add").unwrap_err(), format!("#{c} already depends on #{a} (directly or through other tasks): that would be a cycle"));
    assert_eq!(dep(b, a, "dep_add").unwrap_err(), format!("#{b} already depends on #{a}"));
    assert_eq!(dep(a, a, "dep_add").unwrap_err(), format!("#{a} cannot depend on itself"));
    assert!(dep(a, 99, "dep_add").unwrap_err().contains("no task #99"));
    let shown = s.show("d", b, 3);
    assert_eq!(shown["deps"][0]["seq"], a);
    assert_eq!(shown["dependents"][0]["seq"], c);
    let waiting = s.list("d", TaskListQuery { states: vec!["waiting".into()], ..Default::default() }, 3);
    assert_eq!(task_seqs(&waiting), vec![b, c]);
    assert_eq!(task_seqs(&s.list("d", TaskListQuery { ready: true, ..Default::default() }, 3)), vec![a]);
    assert!(s.w("d", on("claim", c), &member("x"), cx(3)).unwrap_err().contains(&format!("waiting for #{b} (open)")));
    dep(c, b, "dep_remove").unwrap();
    assert_eq!(dep(c, b, "dep_remove").unwrap_err(), format!("#{c} does not depend on #{b}"));
    assert_eq!(s.w("d", on("claim", c), &member("x"), cx(4)).unwrap()["to"], "claimed");
    let actions: Vec<String> = s.show("d", c, 5)["events"].as_array().unwrap().iter().map(|e| e["action"].as_str().unwrap().to_string()).collect();
    assert_eq!(actions, vec!["add", "dep_add", "dep_remove", "claim"]);
    // Dependency changes are refused once a task is finished.
    s.w("d", done_op(c, "ok"), &member("x"), cx(6)).unwrap();
    assert!(dep(c, a, "dep_add").unwrap_err().contains("dependencies change only"));
}

fn a_dependency_chain_deeper_than_the_bound_is_refused(e: Engine) {
    let fx = Fixture::new(e, "depth");
    let s = fx.store();
    // `add --after` runs the same bounded walk as `dep add`: a chain longer than the bound stops.
    let mut last = 0;
    let mut refused = None;
    for i in 1..=(MAX_DEP_DEPTH as i64 + 5) {
        let after = if i > 1 { vec![i - 1] } else { vec![] };
        match s.w("z", TaskOpInput { title: Some(format!("t{i}")), after, ..op("add") }, &member("lead"), cx(1)) {
            Ok(_) => last = i,
            Err(e) => {
                refused = Some(e);
                break;
            }
        }
    }
    assert_eq!(refused.as_deref(), Some("dependency chain deeper than 64 levels: refused"));
    assert!(last >= MAX_DEP_DEPTH as i64, "{last}");
    let extra = s.add("z", "extra", &member("lead"), 1);
    // extra → the chain's end walks the whole chain: deeper than the bound, refused.
    let e = s.w("z", TaskOpInput { on: Some(last), ..on("dep_add", extra) }, &member("lead"), cx(2)).unwrap_err();
    assert_eq!(e, "dependency chain deeper than 64 levels: refused");
    // #1 → extra walks extra's (empty) chain: fine.
    assert!(s.w("z", TaskOpInput { on: Some(extra), ..on("dep_add", 1) }, &member("lead"), cx(3)).is_ok());
}

fn retries_are_limited_for_members_but_not_for_root(e: Engine) {
    let fx = Fixture::new(e, "retry");
    let s = fx.store();
    let t = s.add("r", "flaky", &member("lead"), 1);
    let fail = |n: i64| {
        s.w("r", on("claim", t), &member("c1"), cx(n)).unwrap();
        assert!(s.w("r", on("fail", t), &member("c1"), cx(n)).unwrap_err().starts_with("error required"));
        s.w("r", TaskOpInput { error: Some(format!("boom {n}")), ..on("fail", t) }, &member("c1"), cx(n)).unwrap();
    };
    for n in 1..=3 {
        fail(n);
        let r = s.w("r", on("retry", t), &member("c2"), cx(n)).unwrap();
        assert_eq!(r["task"]["attempt"], n);
        assert_eq!(r["task"]["lastError"], format!("boom {n}"), "the previous error stays visible");
    }
    fail(4);
    let e = s.w("r", on("retry", t), &member("c2"), cx(5)).unwrap_err();
    assert_eq!(e, "#1 has used its retries (attempt 3 of 3): only the root tab or a person can retry it again");
    assert_eq!(s.w("r", on("retry", t), &root("lead"), cx(6)).unwrap()["task"]["attempt"], 4);
    let retries: Vec<Value> = s.show("r", t, 7)["events"].as_array().unwrap().iter().filter(|e| e["action"] == "retry").cloned().collect();
    assert_eq!(retries.len(), 4);
    assert_eq!(retries[0]["data"]["previousError"], "boom 1");
}

fn review_flow_submit_approve_reject(e: Engine) {
    let fx = Fixture::new(e, "review");
    let s = fx.store();
    let t = s.w("v", TaskOpInput { title: Some("risky change".into()), review: Some(true), ..op("add") }, &member("lead"), cx(1)).unwrap()["task"]["seq"].as_i64().unwrap();
    s.w("v", on("claim", t), &member("c1"), cx(2)).unwrap();
    assert!(s.w("v", done_op(t, "x"), &member("c1"), cx(3)).unwrap_err().contains("use agent task submit"));
    let sub = TaskOpInput { result: Some(ResultInput { summary: Some("first try".into()), ..Default::default() }), ..on("submit", t) };
    let r = s.w("v", sub.clone(), &member("c1"), cx(4)).unwrap();
    assert_eq!(r["to"], "review");
    assert_eq!(r["task"]["submittedAt"], 4);
    assert_eq!(r["post"], Value::Null, "no done note before approval");
    assert!(s.w("v", on("approve", t), &member("c1"), cx(5)).unwrap_err().contains("someone else"));
    assert!(s.w("v", on("reject", t), &member("c2"), cx(5)).unwrap_err().starts_with("reason required"));
    let rj = s.w("v", TaskOpInput { reason: Some("missing tests".into()), ..on("reject", t) }, &member("c2"), cx(6)).unwrap();
    assert_eq!(rj["to"], "open");
    assert_eq!(rj["task"]["attempt"], 1);
    assert_eq!(rj["task"]["lastError"], "rejected: missing tests");
    assert_eq!(rj["task"]["owner"], Value::Null);
    s.w("v", on("claim", t), &member("c1"), cx(7)).unwrap();
    let sub2 = TaskOpInput { result: Some(ResultInput { summary: Some("with tests".into()), ..Default::default() }), ..on("submit", t) };
    s.w("v", sub2, &member("c1"), cx(8)).unwrap();
    let ap = s.w("v", on("approve", t), &root("lead"), cx(9)).unwrap();
    assert_eq!(ap["to"], "done");
    assert_eq!(ap["task"]["finishedAt"], 9);
    let note = s.read("v", ReadQuery::default()).unwrap()["posts"].as_array().unwrap().last().unwrap().clone();
    assert!(note["text"].as_str().unwrap().starts_with("#1 done (approved by lead name): risky change\nwith tests"));
    assert_eq!(note["task"], t);
    // Reopen: root or a person only.
    assert!(s.w("v", on("reopen", t), &member("c2"), cx(10)).unwrap_err().contains("only the root tab or a person"));
    let ro = s.w("v", on("reopen", t), &human(), cx(11)).unwrap();
    assert_eq!(ro["to"], "open");
    assert_eq!(ro["task"]["attempt"], 2);
    assert_eq!(ro["task"]["finishedAt"], Value::Null);
}

fn edit_changes_fields_checks_permissions_and_versions(e: Engine) {
    let fx = Fixture::new(e, "edit");
    let s = fx.store();
    let t = s.add("e", "old title", &member("lead"), 1);
    let v1 = s.show("e", t, 2)["task"]["version"].as_i64().unwrap();
    assert!(s.w("e", TaskOpInput { title: Some("x".into()), ..on("edit", t) }, &member("c9"), cx(2)).unwrap_err().contains("can be changed only"));
    assert!(s.w("e", on("edit", t), &member("lead"), cx(2)).unwrap_err().starts_with("nothing to edit"));
    let r = s
        .w(
            "e",
            TaskOpInput { title: Some("new title".into()), body: Some("new body".into()), priority: Some(0), labels: Some(vec!["x".into()]), expected_version: Some(v1), ..on("edit", t) },
            &member("lead"),
            cx(3),
        )
        .unwrap();
    assert_eq!(r["task"]["title"], "new title");
    assert_eq!(r["task"]["body"], "new body");
    assert_eq!(r["task"]["priority"], 0);
    assert_eq!(r["task"]["labels"], serde_json::json!(["x"]));
    assert_eq!(r["task"]["version"], v1 + 1);
    let stale = s.w("e", TaskOpInput { title: Some("again".into()), expected_version: Some(v1), ..on("edit", t) }, &human(), cx(4)).unwrap_err();
    assert_eq!(stale, format!("#1 changed since you loaded it (version {v1}, now {}): load it again", v1 + 1));
    let ev = s.show("e", t, 5)["events"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(ev["action"], "edit");
    assert_eq!(ev["data"]["fields"], serde_json::json!(["title", "body", "priority", "labels"]));
    // Clearing the body with an empty string.
    let cleared = s.w("e", TaskOpInput { body: Some(" ".into()), ..on("edit", t) }, &member("lead"), cx(6)).unwrap();
    assert_eq!(cleared["task"]["body"], Value::Null);
}

fn list_filters_states_mine_search_stale_and_all(e: Engine) {
    let fx = Fixture::new(e, "list");
    let s = fx.store();
    let a = s.add("l", "Write the parser", &member("lead"), 1);
    let b = s.add("l", "Write docs", &member("lead"), 1);
    let c = s.add("l", "Ship it", &member("lead"), 1);
    s.w("l", on("claim", a), &member("c1"), cx(10)).unwrap();
    s.w("l", on("claim", c), &member("c2"), cx(10)).unwrap();
    s.w("l", done_op(c, "shipped"), &member("c2"), cx(11)).unwrap();
    assert_eq!(task_seqs(&s.list("l", TaskListQuery::default(), 12)), vec![a, b], "done is hidden by default");
    assert_eq!(task_seqs(&s.list("l", TaskListQuery { all: true, ..Default::default() }, 12)), vec![a, b, c]);
    assert_eq!(task_seqs(&s.list("l", TaskListQuery { mine: Some("c1".into()), ..Default::default() }, 12)), vec![a]);
    assert_eq!(task_seqs(&s.list("l", TaskListQuery { states: vec!["done".into()], ..Default::default() }, 12)), vec![c]);
    assert_eq!(task_seqs(&s.list("l", TaskListQuery { search: Some("write".into()), ..Default::default() }, 12)), vec![a, b]);
    assert_eq!(task_seqs(&s.list("l", TaskListQuery { search: Some("%".into()), all: true, ..Default::default() }, 12)), Vec::<i64>::new());
    let stale_at = 10 + DEFAULT_STALE_MS + 1;
    // Renew the lease so it is not expired, only stale (no progress).
    run(s.0.lease_tick("inst-a".into(), vec!["c1".into()], stale_at - 1, 3_600_000)).unwrap();
    let st = s.list("l", TaskListQuery { states: vec!["stale".into()], ..Default::default() }, stale_at);
    assert_eq!(task_seqs(&st), vec![a]);
    assert_eq!(st["tasks"][0]["stale"], true);
    assert_eq!(st["counts"]["stale"], 1);
    assert_eq!(st["counts"]["claimed"], 1);
    assert_eq!(st["counts"]["done"], 1);
    let limited = s.list("l", TaskListQuery { all: true, limit: Some(1), ..Default::default() }, 12);
    assert_eq!(limited["matched"], 3);
    assert_eq!(limited["more"], 2);
    assert!(run(s.0.task_list("l".into(), TaskListQuery { states: vec!["sleeping".into()], ..Default::default() }, cx(12))).unwrap_err().starts_with("invalid state"));
}

// ── Leases ───────────────────────────────────────────────────────────────

fn leases_expire_lazily_and_an_owner_write_renews_its_own(e: Engine) {
    let fx = Fixture::new(e, "lease");
    let s = fx.store();
    let a = s.add("l", "a", &member("lead"), 1);
    let b = s.add("l", "b", &member("lead"), 1);
    s.w("l", TaskOpInput { lease_ms: Some(60_000), ..on("claim", a) }, &member("c1"), cx(1_000)).unwrap();
    s.w("l", TaskOpInput { lease_ms: Some(60_000), ..on("claim", b) }, &member("c2"), cx(1_000)).unwrap();
    // Before expiry nothing changes.
    assert_eq!(s.state("l", a, 60_000), "claimed");
    // c2 writes after its lease ran out: its own task is kept (it proves it is alive)…
    let late = s.w("l", TaskOpInput { reason: Some("waiting on a".into()), lease_ms: Some(60_000), ..on("block", b) }, &member("c2"), cx(70_000)).unwrap();
    assert_eq!(late["to"], "blocked");
    assert_eq!(late["task"]["leaseUntil"], 70_000 + 60_000);
    // …while c1's expired task was released in the same transaction.
    assert_eq!(late["expired"][0]["seq"], a);
    let shown = s.show("l", a, 70_001);
    assert_eq!(shown["task"]["state"], "open");
    let last = shown["events"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["action"], "lease_expired");
    assert_eq!(last["actor"]["id"], "app");
    assert_eq!(last["data"]["ownerId"], "c1");
    // Another machine's reader expires an abandoned task on list.
    let s2 = fx.store();
    let l = run(s2.0.task_list("l".into(), TaskListQuery::default(), cx_other(70_000 + 60_001))).unwrap();
    assert_eq!(l["expired"][0]["seq"], b);
    assert_eq!(s.state("l", b, 200_000), "open");
}

fn lease_tick_renews_only_alive_owners_of_this_instance(e: Engine) {
    let fx = Fixture::new(e, "tick");
    let s = fx.store();
    for i in 1..=3 {
        s.add("k", &format!("t{i}"), &member("lead"), 1);
    }
    s.w("k", TaskOpInput { lease_ms: Some(60_000), ..on("claim", 1) }, &member("c1"), cx(1_000)).unwrap();
    s.w("k", TaskOpInput { lease_ms: Some(60_000), ..on("claim", 2) }, &member("c2"), cx(1_000)).unwrap();
    s.w("k", TaskOpInput { lease_ms: Some(60_000), ..on("claim", 3) }, &remote("c3"), cx_other(1_000)).unwrap();
    let r = run(s.0.lease_tick("inst-a".into(), vec!["c1".into(), "c3".into()], 50_000, 60_000)).unwrap();
    assert_eq!(r["renewed"], 1, "c2 is not alive, c3 belongs to another instance");
    let mut holders: Vec<String> = r["holders"].as_array().unwrap().iter().map(|h| h.as_str().unwrap().to_string()).collect();
    holders.sort();
    assert_eq!(holders, vec!["c1", "c2"]);
    assert_eq!(s.show("k", 1, 50_000)["task"]["leaseUntil"], 110_000);
    assert_eq!(s.show("k", 2, 50_000)["task"]["leaseUntil"], 61_000);
    // The app releases c2 (tab gone) right away.
    let rel = run(s.0.release_owner("inst-a".into(), "c2".into(), 50_001, Some(here()), "owner tab closed".into())).unwrap();
    assert_eq!(rel["released"][0]["seq"], 2);
    let ev = s.show("k", 2, 50_002)["events"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(ev["action"], "auto_release");
    assert_eq!(ev["note"], "owner tab closed");
    // Another instance's tab with the same id is not touched.
    let none = run(s.0.release_owner("inst-a".into(), "c3".into(), 50_003, None, "x".into())).unwrap();
    assert!(none["released"].as_array().unwrap().is_empty());
    // Nothing held by this instance any more after c1 finishes: holders is empty.
    s.w("k", done_op(1, "ok"), &member("c1"), cx(50_004)).unwrap();
    let r = run(s.0.lease_tick("inst-a".into(), vec!["c1".into()], 50_005, 60_000)).unwrap();
    assert_eq!(r["renewed"], 0);
    assert!(r["holders"].as_array().unwrap().is_empty());
}

fn startup_adopts_recovered_owners_and_releases_the_rest(e: Engine) {
    let fx = Fixture::new(e, "adopt");
    let s = fx.store();
    for i in 1..=3 {
        s.add("s", &format!("t{i}"), &member("lead"), 1);
    }
    s.w("s", on("claim", 1), &member("kept"), cx(1_000)).unwrap();
    s.w("s", on("claim", 2), &member("gone"), cx(1_000)).unwrap();
    s.w("s", on("claim", 3), &remote("remote"), cx_other(1_000)).unwrap();
    let held = run(s.0.held_on_host(here())).unwrap();
    assert_eq!(held.len(), 2, "only this host's tasks");
    assert!(held.iter().all(|h| h["ownerInstance"] == "inst-a"));
    let item = |seq: i64| LeaseItem { id: held.iter().find(|h| h["seq"] == seq).unwrap()["id"].as_str().unwrap().to_string(), instance: "inst-a".into() };
    let r = run(s.0.lease_apply("inst-new".into(), vec![item(1)], vec![item(2)], 2_000, 60_000, Some(here()))).unwrap();
    assert_eq!(r["adopted"], 1);
    assert_eq!(r["released"][0]["seq"], 2);
    let t1 = s.show("s", 1, 2_001)["task"].clone();
    assert_eq!(t1["owner"]["instance"], "inst-new");
    assert_eq!(t1["leaseUntil"], 62_000);
    assert_eq!(s.state("s", 2, 2_001), "open");
    assert_eq!(s.state("s", 3, 2_001), "claimed", "another host's task is left to its lease");
    // A stale decision (the instance changed meanwhile) does nothing.
    let again = run(s.0.lease_apply("inst-x".into(), vec![item(1)], vec![item(1)], 3_000, 60_000, None)).unwrap();
    assert_eq!(again["adopted"], 0);
    assert!(again["released"].as_array().unwrap().is_empty());
}

// ── Caps ─────────────────────────────────────────────────────────────────

fn task_cap_prunes_oldest_finished_and_never_live_tasks(e: Engine) {
    let fx = Fixture::with_limits(e, "taskcap", Limits { tasks: 4, ..Limits::default() });
    let s = fx.store();
    let finish = |seq: i64, now: i64| {
        s.w("c", on("claim", seq), &member("w"), cx(now)).unwrap();
        s.w("c", done_op(seq, "ok"), &member("w"), cx(now)).unwrap();
    };
    let t1 = s.add("c", "t1", &member("lead"), 1);
    let t2 = s.add("c", "t2", &member("lead"), 2);
    let keep = s.add("c", "dependent", &member("lead"), 3);
    s.w("c", TaskOpInput { on: Some(t2), ..on("dep_add", keep) }, &member("lead"), cx(3)).unwrap();
    finish(t1, 10);
    s.w("c", on("claim", t2), &member("w"), cx(11)).unwrap();
    s.w("c", TaskOpInput { error: Some("x".into()), ..on("fail", t2) }, &member("w"), cx(11)).unwrap();
    let t4 = s.add("c", "t4", &member("lead"), 12);
    // Full (4). The next add prunes t1 (oldest finished); t2 is failed but a live task
    // depends on it, so it stays.
    let t5 = s.add("c", "t5", &member("lead"), 13);
    let all = s.list("c", TaskListQuery { all: true, ..Default::default() }, 14);
    let mut got = task_seqs(&all);
    got.sort_unstable();
    assert_eq!(got, vec![t2, keep, t4, t5]);
    // Everything left is live or protected: the cap refuses instead of pruning live tasks.
    let e = s.w("c", TaskOpInput { title: Some("t6".into()), ..op("add") }, &member("lead"), cx(15)).unwrap_err();
    assert!(e.starts_with("task limit reached: team c has 4 tasks"), "{e}");
    assert_eq!(s.add("c2", "other team is separate", &member("lead"), 15), 1);
}

fn event_cap_drops_whole_finished_tasks_first(e: Engine) {
    let fx = Fixture::with_limits(e, "eventcap", Limits { events: 12, ..Limits::default() });
    let s = fx.store();
    let old = s.add("e", "old", &member("lead"), 1); // 1 event
    s.w("e", on("claim", old), &member("w"), cx(2)).unwrap(); // 2
    s.w("e", done_op(old, "ok"), &member("w"), cx(3)).unwrap(); // 3
    let live = s.add("e", "live", &member("lead"), 4); // 4
    for i in 0..4 {
        s.w("e", TaskOpInput { title: Some(format!("v{i}")), ..on("edit", live) }, &member("lead"), cx(5 + i)).unwrap(); // 5..8
    }
    s.w("e", on("claim", live), &member("w"), cx(20)).unwrap(); // 9
    for i in 0..3 {
        s.w("e", TaskOpInput { reason: Some("r".into()), ..on("block", live) }, &member("w"), cx(30 + i)).unwrap();
        s.w("e", on("unblock", live), &member("w"), cx(40 + i)).unwrap();
    } // 15 → over the cap: the finished task and its 3 events go first.
    assert!(task_seqs(&s.list("e", TaskListQuery { all: true, ..Default::default() }, 50)).iter().all(|n| *n != old));
    let live_events = s.show("e", live, 50)["events"].as_array().unwrap().len();
    assert_eq!(live_events, 12, "a live task's history is never trimmed");
    assert_eq!(s.read("e", ReadQuery::default()).unwrap()["posts"][0]["task"], Value::Null, "its done note stays, unlinked");
}

// ── Review fixes ─────────────────────────────────────────────────────────

fn an_owner_cannot_skip_review_by_editing_it_away(e: Engine) {
    let fx = Fixture::new(e, "bypass");
    let s = fx.store();
    let t = s.w("b", TaskOpInput { title: Some("risky".into()), review: Some(true), ..op("add") }, &member("c1"), cx(1)).unwrap()["task"]["seq"].as_i64().unwrap();
    s.w("b", on("claim", t), &member("c1"), cx(2)).unwrap();
    let e = s.w("b", TaskOpInput { review: Some(false), ..on("edit", t) }, &member("c1"), cx(3)).unwrap_err();
    assert!(e.contains("its owner cannot change whether it needs review"), "{e}");
    assert!(s.w("b", done_op(t, "x"), &member("c1"), cx(4)).unwrap_err().contains("needs review"));
    // The owner may still fix the title while working on it.
    assert!(s.w("b", TaskOpInput { title: Some("risky change".into()), ..on("edit", t) }, &member("c1"), cx(5)).is_ok());
    // The root tab can drop the review step while it is not in review.
    s.w("b", TaskOpInput { review: Some(false), ..on("edit", t) }, &root("lead"), cx(6)).unwrap();
    // Nobody approves their own work, the root tab included.
    let r = s.w("b", TaskOpInput { title: Some("lead's own".into()), review: Some(true), ..op("add") }, &root("lead"), cx(7)).unwrap()["task"]["seq"].as_i64().unwrap();
    s.w("b", on("claim", r), &root("lead"), cx(8)).unwrap();
    s.w("b", TaskOpInput { result: Some(ResultInput { summary: Some("s".into()), ..Default::default() }), ..on("submit", r) }, &root("lead"), cx(9)).unwrap();
    assert!(s.w("b", on("approve", r), &root("lead"), cx(10)).unwrap_err().contains("someone else"));
    assert_eq!(s.w("b", on("approve", r), &human(), cx(11)).unwrap()["to"], "done");
}

fn a_cancelled_dependency_counts_as_met_and_is_flagged(e: Engine) {
    let fx = Fixture::new(e, "canceldep");
    let s = fx.store();
    let a = s.add("c", "a", &member("lead"), 1);
    let f = s.add("c", "f", &member("lead"), 1);
    let b = s.w("c", TaskOpInput { title: Some("b".into()), after: vec![a, f], ..op("add") }, &member("lead"), cx(1)).unwrap()["task"]["seq"].as_i64().unwrap();
    s.w("c", on("cancel", a), &member("lead"), cx(2)).unwrap();
    s.w("c", on("claim", f), &member("w"), cx(3)).unwrap();
    s.w("c", TaskOpInput { error: Some("broke".into()), ..on("fail", f) }, &member("w"), cx(3)).unwrap();
    let shown = s.show("c", b, 4)["task"].clone();
    assert_eq!(shown["cancelledDeps"], serde_json::json!([a]));
    assert_eq!(shown["waitingOn"], serde_json::json!([f]), "a failed dependency still blocks");
    assert!(s.w("c", on("claim", b), &member("x"), cx(5)).unwrap_err().contains(&format!("#{f} (failed)")));
    s.w("c", TaskOpInput { on: Some(f), ..on("dep_remove", b) }, &member("lead"), cx(6)).unwrap();
    assert_eq!(s.w("c", on("claim", b), &member("x"), cx(7)).unwrap()["to"], "claimed", "only the cancelled one is left: met");
    let d = s.add("c", "d", &member("lead"), 8);
    assert_eq!(s.w("c", TaskOpInput { on: Some(a), ..on("dep_add", d) }, &member("lead"), cx(9)).unwrap_err(), format!("#{a} is cancelled: it cannot be a dependency"));
    assert!(s.w("c", TaskOpInput { title: Some("e".into()), after: vec![a], ..op("add") }, &member("lead"), cx(9)).unwrap_err().contains("cancelled"));
}

fn dependency_changes_follow_the_edit_permission(e: Engine) {
    let fx = Fixture::new(e, "depperm");
    let s = fx.store();
    let a = s.add("p", "a", &member("lead"), 1);
    let b = s.add("p", "b", &member("lead"), 1);
    let add = |who: &Actor, name: &str| s.w("p", TaskOpInput { on: Some(a), ..on(name, b) }, who, cx(2));
    assert!(add(&member("x"), "dep_add").unwrap_err().contains("can be changed only"));
    add(&member("lead"), "dep_add").unwrap();
    assert!(add(&member("x"), "dep_remove").unwrap_err().contains("can be changed only"));
    add(&root("root"), "dep_remove").unwrap();
}

fn a_person_cannot_claim_or_work_on_a_task(e: Engine) {
    let fx = Fixture::new(e, "person");
    let s = fx.store();
    let t = s.add("h", "t", &human(), 1);
    assert!(s.w("h", on("claim", t), &human(), cx(2)).unwrap_err().starts_with("a person cannot claim"));
    assert!(s.w("h", TaskOpInput { next: true, ..op("claim") }, &human(), cx(2)).unwrap_err().starts_with("a person cannot claim"));
    assert_eq!(s.w("h", on("cancel", t), &human(), cx(3)).unwrap()["to"], "cancelled");
}

fn another_member_claims_after_a_lease_expired(e: Engine) {
    let fx = Fixture::new(e, "reclaim");
    let s = fx.store();
    let t = s.add("r", "t", &member("lead"), 1);
    s.w("r", TaskOpInput { lease_ms: Some(60_000), ..on("claim", t) }, &member("c1"), cx(1_000)).unwrap();
    assert!(s.w("r", on("claim", t), &member("c2"), cx(30_000)).unwrap_err().contains("already claimed"));
    let c = s.w("r", on("claim", t), &member("c2"), cx(61_001)).unwrap();
    assert_eq!(c["expired"][0]["seq"], t);
    assert_eq!(c["task"]["owner"]["id"], "c2");
    // The first owner learns it lost the task.
    assert!(s.w("r", done_op(t, "x"), &member("c1"), cx(61_002)).unwrap_err().contains("only its owner"));
}

fn block_moves_the_claim_to_the_acting_instance(e: Engine) {
    let fx = Fixture::new(e, "blockinst");
    let s = fx.store();
    let t = s.add("i", "t", &member("lead"), 1);
    s.w("i", on("claim", t), &member("c1"), cx(1)).unwrap();
    let other = Ctx { instance: "inst-z".into(), ..cx(2) };
    let b = s.w("i", TaskOpInput { reason: Some("r".into()), ..on("block", t) }, &member("c1"), other).unwrap();
    assert_eq!(b["task"]["owner"]["instance"], "inst-z");
}

fn live_history_over_the_event_cap_does_not_wipe_finished_tasks(e: Engine) {
    let fx = Fixture::with_limits(e, "livecap", Limits { events: 5, ..Limits::default() });
    let s = fx.store();
    let live = s.add("e", "live", &member("lead"), 1);
    s.w("e", on("claim", live), &member("w"), cx(2)).unwrap();
    for i in 0..4 {
        s.w("e", TaskOpInput { reason: Some("r".into()), ..on("block", live) }, &member("w"), cx(3 + i)).unwrap();
        s.w("e", on("unblock", live), &member("w"), cx(20 + i)).unwrap();
    }
    let done = s.add("e", "done one", &member("lead"), 30);
    s.w("e", on("claim", done), &member("w"), cx(31)).unwrap();
    s.w("e", done_op(done, "ok"), &member("w"), cx(32)).unwrap();
    s.add("e", "one more write", &member("lead"), 33);
    // The live task has 10 events (over the cap of 5 alone): pruning the finished task would
    // not help, so it is kept.
    assert!(task_seqs(&s.list("e", TaskListQuery { all: true, ..Default::default() }, 50)).contains(&done));
}

#[test]
fn tombstones_are_kept_while_a_sync_consumer_exists() {
    let fx = Fixture::new(Engine::Sqlite, "purgeguard");
    let s = fx.store();
    let day = 24 * 60 * 60 * 1000;
    s.post("g", input("t1", "note", "x"), 1).unwrap();
    s.clear("g", 2).unwrap();
    s.post("g", input("t1", "note", "keep the team alive"), 40 * day).unwrap();
    let c = raw(&fx);
    c.execute("INSERT INTO sync_state(key, value) VALUES ('consumer', 'test')", []).unwrap();
    run(s.0.prune_stale(40 * day, STALE_AFTER_MS)).unwrap();
    assert_eq!(count(&c, "SELECT count(*) FROM posts"), 2, "the old tombstone stays for the consumer");
    c.execute("DELETE FROM sync_state", []).unwrap();
    run(s.0.prune_stale(40 * day, STALE_AFTER_MS)).unwrap();
    assert_eq!(count(&c, "SELECT count(*) FROM posts"), 1);
}

fn read_refuses_a_malformed_cursor_tab(e: Engine) {
    let fx = Fixture::new(e, "cursorid");
    let s = fx.store();
    let e = s.read("g", ReadQuery { cursor_tab: Some("x".repeat(129)), ..Default::default() }).unwrap_err();
    assert!(e.starts_with("invalid read cursor tab id"), "{e}");
}

// ── Sync groundwork: ids, tombstones, change log, arrival cursors ────────

fn team_events_list_every_task_newest_window_oldest_first(e: Engine) {
    let fx = Fixture::new(e, "events");
    let s = fx.store();
    let a = s.add("ev", "first", &member("lead"), 10);
    let b = s.add("ev", "second", &member("lead"), 20);
    s.w("ev", on("claim", a), &member("c1"), cx(30)).unwrap();
    s.w("ev", done_op(a, "did it"), &member("c1"), cx(40)).unwrap();
    s.w("ev", on("cancel", b), &human(), cx(50)).unwrap();
    s.add("other", "not mine", &member("x"), 60);
    let ev = |q: EventsQuery| run(s.0.team_events("ev".into(), q, Some(here()))).unwrap();
    let all = ev(EventsQuery::default());
    let rows = all["events"].as_array().unwrap();
    let got: Vec<(i64, String, i64)> =
        rows.iter().map(|r| (r["task"].as_i64().unwrap(), r["action"].as_str().unwrap().to_string(), r["ts"].as_i64().unwrap())).collect();
    assert_eq!(
        got,
        vec![(a, "add".into(), 10), (b, "add".into(), 20), (a, "claim".into(), 30), (a, "done".into(), 40), (b, "cancel".into(), 50)]
    );
    assert_eq!(all["more"], 0);
    assert_eq!(rows[3]["from"], "claimed");
    assert_eq!(rows[3]["to"], "done");
    assert_eq!(rows[3]["actor"]["id"], "c1");
    assert_eq!(rows[4]["actor"]["id"], "user");
    // The newest two, still oldest first; `more` counts the rest.
    let last2 = ev(EventsQuery { limit: Some(2), since: None });
    assert_eq!(last2["events"].as_array().unwrap().iter().map(|r| r["ts"].as_i64().unwrap()).collect::<Vec<_>>(), vec![40, 50]);
    assert_eq!(last2["more"], 3);
    // Only after `since`.
    let after = ev(EventsQuery { limit: None, since: Some(30) });
    assert_eq!(after["events"].as_array().unwrap().len(), 2);
    // An unknown team is empty, a bad id is refused.
    assert_eq!(run(s.0.team_events("nobody".into(), EventsQuery::default(), Some(here()))).unwrap()["events"], serde_json::json!([]));
    assert!(run(s.0.team_events("bad id!".into(), EventsQuery::default(), Some(here()))).is_err());
}

fn a_person_reviews_retries_reopens_cancels_and_edits(e: Engine) {
    let fx = Fixture::new(e, "viewer");
    let s = fx.store();
    let t = s.w("pv", TaskOpInput { title: Some("needs eyes".into()), review: Some(true), ..op("add") }, &member("lead"), cx(1)).unwrap()["task"]["seq"].as_i64().unwrap();
    s.w("pv", on("claim", t), &member("c1"), cx(2)).unwrap();
    let sub = TaskOpInput { result: Some(ResultInput { summary: Some("done".into()), ..Default::default() }), ..on("submit", t) };
    s.w("pv", sub.clone(), &member("c1"), cx(3)).unwrap();
    let rj = s.w("pv", TaskOpInput { reason: Some("add a test".into()), ..on("reject", t) }, &human(), cx(4)).unwrap();
    assert_eq!(rj["to"], "open");
    s.w("pv", on("claim", t), &member("c1"), cx(5)).unwrap();
    s.w("pv", sub, &member("c1"), cx(6)).unwrap();
    assert_eq!(s.w("pv", on("approve", t), &human(), cx(7)).unwrap()["to"], "done");
    assert_eq!(s.w("pv", on("reopen", t), &human(), cx(8)).unwrap()["to"], "open");
    // Retry past the limit: a person may.
    let f = s.w("pv", TaskOpInput { title: Some("flaky".into()), max_attempts: Some(1), ..op("add") }, &human(), cx(9)).unwrap()["task"]["seq"].as_i64().unwrap();
    s.w("pv", on("claim", f), &member("c1"), cx(10)).unwrap();
    s.w("pv", TaskOpInput { error: Some("exit 1".into()), ..on("fail", f) }, &member("c1"), cx(11)).unwrap();
    s.w("pv", on("retry", f), &member("c2"), cx(12)).unwrap();
    s.w("pv", on("claim", f), &member("c1"), cx(13)).unwrap();
    s.w("pv", TaskOpInput { error: Some("exit 1 again".into()), ..on("fail", f) }, &member("c1"), cx(14)).unwrap();
    assert!(s.w("pv", on("retry", f), &member("c2"), cx(15)).unwrap_err().contains("only the root tab or a person"));
    assert_eq!(s.w("pv", on("retry", f), &human(), cx(16)).unwrap()["to"], "open");
    let ed = s.w("pv", TaskOpInput { title: Some("flaky, renamed".into()), priority: Some(3), ..on("edit", f) }, &human(), cx(17)).unwrap();
    assert_eq!(ed["task"]["title"], "flaky, renamed");
    assert_eq!(s.w("pv", on("cancel", f), &human(), cx(18)).unwrap()["to"], "cancelled");
    let actors: Vec<String> = s.show("pv", t, 20)["events"].as_array().unwrap().iter()
        .filter(|e| matches!(e["action"].as_str(), Some("reject" | "approve" | "reopen")))
        .map(|e| e["actor"]["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(actors, vec!["user", "user", "user"]);
}

fn raw(fx: &Fixture) -> rusqlite::Connection {
    rusqlite::Connection::open(fx.db()).unwrap()
}

fn count(c: &rusqlite::Connection, sql: &str) -> i64 {
    c.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn row_ids_are_uuid_v7_in_creation_order(e: Engine) {
    let fx = Fixture::new(e, "ids");
    let s = fx.store();
    for i in 0..5 {
        s.post("u", input("t1", "note", &format!("p{i}")), i).unwrap();
    }
    let t = s.add("u", "task", &member("t1"), 10);
    s.w("u", on("claim", t), &member("t1"), cx(11)).unwrap();
    for (sql, n) in [
        ("SELECT id FROM posts ORDER BY seq", 5),
        ("SELECT id FROM task_events ORDER BY seq", 2),
        ("SELECT id FROM tasks", 1),
        ("SELECT uid FROM teams", 1),
    ] {
        let ids = fx.raw_strings(sql);
        assert_eq!(ids.len(), n, "{sql}");
        for id in &ids {
            assert_eq!(uuid::Uuid::parse_str(id).unwrap().get_version_num(), 7, "{id}");
        }
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(sorted, ids, "ids sort by creation: {sql}");
    }
    assert_eq!(fx.raw_strings("SELECT home_host FROM teams"), vec![here()]);
    assert_eq!(fx.raw_strings("SELECT origin_host FROM teams"), vec![here()]);
    assert_eq!(fx.raw_strings("SELECT team_uid FROM tasks"), fx.raw_strings("SELECT uid FROM teams"), "rows reference the team uid");
}

#[test]
fn every_write_path_appends_to_the_change_log() {
    let fx = Fixture::new(Engine::Sqlite, "changes");
    let s = fx.store();
    s.post("w", input("t1", "note", "first"), 0).unwrap();
    let c = raw(&fx);
    let mut last = 0;
    let mut step = |what: &str, f: &dyn Fn()| {
        f();
        let now = count(&c, "SELECT coalesce(max(local_seq), 0) FROM changes");
        assert!(now > last, "{what} logged no change");
        last = now;
    };
    step("post", &|| { s.post("w", input("t1", "note", "x"), 1).unwrap(); });
    step("add", &|| { s.add("w", "a", &member("t1"), 2); });
    step("add 2", &|| { s.add("w", "b", &member("t1"), 2); });
    step("dep add", &|| { s.w("w", TaskOpInput { on: Some(1), ..on("dep_add", 2) }, &member("t1"), cx(3)).unwrap(); });
    step("dep rm", &|| { s.w("w", TaskOpInput { on: Some(1), ..on("dep_remove", 2) }, &member("t1"), cx(3)).unwrap(); });
    step("claim", &|| { s.w("w", on("claim", 1), &member("t1"), cx(4)).unwrap(); });
    step("lease tick", &|| { run(s.0.lease_tick("inst-a".into(), vec!["t1".into()], 5, 60_000)).unwrap(); });
    step("done", &|| { s.w("w", done_op(1, "ok"), &member("t1"), cx(6)).unwrap(); });
    step("claim 2", &|| { s.w("w", on("claim", 2), &member("t2"), cx(7)).unwrap(); });
    step("release owner", &|| { run(s.0.release_owner("inst-a".into(), "t2".into(), 8, None, "closed".into())).unwrap(); });
    step("clear", &|| { s.clear("w", 9).unwrap(); });
    // Each logged row is one of the synced tables; deps are keyed task/depends_on.
    let tables: Vec<String> = {
        let mut stmt = c.prepare("SELECT DISTINCT tbl FROM changes ORDER BY tbl").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
    };
    assert_eq!(tables, vec!["posts", "task_deps", "task_events", "tasks", "teams"]);
    assert_eq!(count(&c, "SELECT count(*) FROM changes WHERE tbl = 'task_deps' AND row_id LIKE '%/%'"), count(&c, "SELECT count(*) FROM changes WHERE tbl = 'task_deps'"));
    // Every update bumps row_version.
    assert!(count(&c, "SELECT row_version FROM tasks WHERE seq = 1") >= 3);
}

#[test]
fn the_change_log_stays_bounded_without_a_consumer() {
    let fx = Fixture::with_limits(Engine::Sqlite, "changecap", Limits { changes: 10, ..Limits::default() });
    let s = fx.store();
    for i in 0..20 {
        s.post("b", input("t1", "note", &format!("p{i}")), i).unwrap();
    }
    let c = raw(&fx);
    assert!(count(&c, "SELECT count(*) FROM changes") <= 11);
    c.execute("INSERT INTO sync_state(key, value) VALUES ('consumer', 'test')", []).unwrap();
    for i in 0..20 {
        s.post("b", input("t1", "note", &format!("q{i}")), 100 + i).unwrap();
    }
    assert!(count(&c, "SELECT count(*) FROM changes") > 30, "a consumer keeps the log");
}

fn tombstones_hide_rows_and_are_purged_after_thirty_days(e: Engine) {
    let fx = Fixture::with_limits(e, "tomb", Limits { posts: 3, ..Limits::default() });
    let s = fx.store();
    let day = 24 * 60 * 60 * 1000;
    for i in 1..=4 {
        s.post("t", input("t1", "note", &format!("p{i}")), i).unwrap();
    }
    assert_eq!(fx.raw_count("SELECT count(*) FROM posts"), 4, "the cap tombstones, it does not delete");
    assert_eq!(fx.raw_count("SELECT count(*) FROM posts WHERE deleted_at IS NOT NULL"), 1);
    assert_eq!(seqs(&s.read("t", ReadQuery::default()).unwrap()), vec![2, 3, 4]);
    s.clear("t", 10).unwrap();
    assert!(seqs(&s.read("t", ReadQuery::default()).unwrap()).is_empty());
    assert_eq!(fx.raw_count("SELECT count(*) FROM posts"), 4);
    // Still active: nothing purged before 30 days; afterwards the tombstones go for good.
    s.post("t", input("t1", "note", "later"), 20 * day).unwrap();
    run(s.0.prune_stale(20 * day + 1, STALE_AFTER_MS)).unwrap();
    assert_eq!(fx.raw_count("SELECT count(*) FROM posts"), 5);
    run(s.0.prune_stale(45 * day, STALE_AFTER_MS)).unwrap();
    assert_eq!(fx.raw_count("SELECT count(*) FROM posts"), 1, "only the live post is left");
    assert_eq!(seqs(&s.read("t", ReadQuery::default()).unwrap()), vec![5]);
}

#[test]
fn new_reads_follow_local_arrival_so_a_late_row_is_not_skipped() {
    let fx = Fixture::new(Engine::Sqlite, "arrival");
    let s = fx.store();
    s.post("a", input("t2", "note", "one"), 1).unwrap();
    s.post("a", input("t2", "note", "two"), 2).unwrap();
    let newq = || ReadQuery { cursor_tab: Some("t1".into()), exclude_author: Some("t1".into()), ..Default::default() };
    assert_eq!(seqs(&s.read("a", newq()).unwrap()), vec![1, 2]);
    // A row with a lower seq arrives later (as a sync would deliver it): it is still unread.
    let c = raw(&fx);
    c.execute("INSERT INTO changes(tbl, row_id, at) VALUES ('posts', 'late-row', 3)", []).unwrap();
    let arrival = c.last_insert_rowid();
    let uid: String = c.query_row("SELECT uid FROM teams", [], |r| r.get(0)).unwrap();
    c.execute(
        "INSERT INTO posts(id, team_uid, seq, ts, author_id, kind, text, arrival, origin_host, updated_at)
         VALUES ('late-row', ?1, 0, 3, 't9', 'note', 'from another machine', ?2, 'host-b', 3)",
        rusqlite::params![uid, arrival],
    )
    .unwrap();
    let late = s.read("a", newq()).unwrap();
    assert_eq!(seqs(&late), vec![0]);
    assert!(seqs(&s.read("a", newq()).unwrap()).is_empty());
}

// ── SQLite file specifics ────────────────────────────────────────────────

mod sqlite_only {
    use super::*;
    use rusqlite::{Connection, TransactionBehavior};
    use std::time::Duration;

    /// A database exactly as stage 1 left it (schema 1 in user_version, old column names).
    fn write_stage1_db(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE posts (id INTEGER PRIMARY KEY, team TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
              author_id TEXT, author_name TEXT, author_cli TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, UNIQUE(team, seq));
            CREATE INDEX posts_team_ts ON posts(team, ts);
            CREATE TABLE teams (team TEXT PRIMARY KEY NOT NULL, name TEXT, last_seq INTEGER NOT NULL DEFAULT 0, updated_ts INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE cursors (team TEXT NOT NULL, tab_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(team, tab_id));
            INSERT INTO posts(team, seq, ts, author_id, author_name, author_cli, kind, text) VALUES
              ('r1', 1, 100, 't1', 'lead', 'claude', 'note', 'first'),
              ('r1', 2, 200, 't2', 'kid', 'codex', 'finding', 'second');
            INSERT INTO teams(team, name, last_seq, updated_ts) VALUES ('r1', 'lead', 3, 300);
            INSERT INTO cursors(team, tab_id, seq) VALUES ('r1', 't2', 1);
            PRAGMA user_version = 1;
            "#,
        )
        .unwrap();
    }

    /// Several connections opening one brand-new file at the same moment: switching it to WAL
    /// is a read upgraded to a write, which SQLite refuses at once (no busy wait) while
    /// another connection has the file open; every opener must still get a working board.
    #[test]
    fn many_connections_open_one_new_file_at_once() {
        for round in 0..10 {
            let fx = Fixture::new(Engine::Sqlite, &format!("newfile{round}"));
            let gate = std::sync::Arc::new(std::sync::Barrier::new(12));
            let handles: Vec<_> = (0..12)
                .map(|_| {
                    let (path, gate) = (fx.db(), gate.clone());
                    std::thread::spawn(move || {
                        gate.wait();
                        test_open_db(&path).map(|c| c.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0)).unwrap())
                    })
                })
                .collect();
            for h in handles {
                assert_eq!(h.join().unwrap().as_deref(), Ok("wal"), "round {round}");
            }
        }
    }

    #[test]
    fn a_new_file_records_the_program_version_it_was_given() {
        let fx = Fixture::new(Engine::Sqlite, "appver");
        fx.store().post("r1", input("t1", "note", "hi"), 1_000).unwrap();
        let conn = Connection::open(fx.db()).unwrap();
        let v: String = conn.query_row("SELECT value FROM board_meta WHERE key = 'created_by_app_version'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, TEST_APP_VERSION);
    }

    #[test]
    fn a_stage1_database_migrates_forward_without_losing_data() {
        let fx = Fixture::new(Engine::Sqlite, "migrate");
        write_stage1_db(&fx.db());
        let s = fx.store();
        let r = s.read("r1", ReadQuery { limit: Some(50), ..Default::default() }).unwrap();
        assert_eq!(seqs(&r), vec![1, 2]);
        assert_eq!(r["posts"][1]["author"]["cliType"], "codex");
        assert_eq!(r["lastSeq"], 3);
        assert_eq!(r["teamName"], "lead");
        // The cursor survived: t2 has read seq 1.
        let n = s.read("r1", ReadQuery { cursor_tab: Some("t2".into()), ..Default::default() }).unwrap();
        assert_eq!(seqs(&n), vec![2]);
        // Counters continue; tasks work.
        assert_eq!(s.post("r1", input("t1", "note", "third"), 400).unwrap()["seq"], 4);
        assert_eq!(s.add("r1", "first task", &member("t1"), 400), 1);
        let teams = s.teams();
        assert_eq!(teams[0]["updatedTs"], 400);
        drop(s);
        let conn = Connection::open(fx.db()).unwrap();
        let (v, user): (String, i64) = conn
            .query_row("SELECT (SELECT value FROM board_meta WHERE key='schema_version'), (SELECT user_version FROM pragma_user_version)", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION.to_string());
        assert_eq!(user, SCHEMA_VERSION, "mirrored so a stage-1 app refuses this file");
        let created: i64 = conn.query_row("SELECT created_at FROM teams WHERE team = 'r1'", [], |r| r.get(0)).unwrap();
        assert_eq!(created, 100, "created_at from the oldest post");
        let journal: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(journal.to_ascii_lowercase(), "wal");
        for idx in ["tasks_next", "tasks_owner", "tasks_parent", "tasks_lease", "task_deps_on", "task_events_task", "task_events_team_ts", "posts_team_kind_seq", "posts_team_ts"] {
            let n: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = ?1", [idx], |r| r.get(0)).unwrap();
            assert_eq!(n, 1, "index {idx}");
        }
    }

    #[test]
    fn opening_needs_no_write_lock_and_refuses_a_newer_schema() {
        let fx = Fixture::new(Engine::Sqlite, "version");
        drop(test_open_db(&fx.db()).unwrap());
        let mut holder = Connection::open(fx.db()).unwrap();
        let tx = holder.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
        let start = std::time::Instant::now();
        let conn = test_open_db(&fx.db()).unwrap();
        assert!(start.elapsed() < Duration::from_secs(2), "open waited for the write lock");
        drop(conn);
        tx.rollback().unwrap();
        drop(holder);
        let newer = Connection::open(fx.db()).unwrap();
        newer.execute("UPDATE board_meta SET value = ?1 WHERE key = 'schema_version'", [(SCHEMA_VERSION + 1).to_string()]).unwrap();
        drop(newer);
        let err = test_open_db(&fx.db()).err().expect("must refuse");
        assert!(err.starts_with("team board unavailable: database is from a newer app version"), "{err}");
        let e = fx.store().post("t", input("t1", "note", "x"), 1).unwrap_err();
        assert!(e.starts_with("team board unavailable:"), "{e}");
    }

    #[cfg(unix)]
    #[test]
    fn database_and_wal_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let fx = Fixture::new(Engine::Sqlite, "mode");
        let s = fx.store();
        s.post("m", input("t1", "note", "x"), 1).unwrap();
        s.add("m", "a task", &member("t1"), 1);
        let mode = |suffix: &str| {
            let mut p = fx.db().into_os_string();
            p.push(suffix);
            std::fs::metadata(PathBuf::from(p)).map(|m| m.permissions().mode() & 0o777).ok()
        };
        assert_eq!(mode(""), Some(0o600));
        assert_eq!(mode("-wal"), Some(0o600));
        assert_eq!(mode("-shm"), Some(0o600));
        drop(s);
        std::fs::set_permissions(fx.db(), std::fs::Permissions::from_mode(0o644)).unwrap();
        drop(test_open_db(&fx.db()).unwrap());
        assert_eq!(mode(""), Some(0o600), "a wider file is tightened");
    }

    #[test]
    fn a_corrupt_database_reports_unavailable() {
        let fx = Fixture::new(Engine::Sqlite, "corrupt");
        std::fs::create_dir_all(&fx.dir).unwrap();
        std::fs::write(fx.db(), b"this is not a sqlite database, just bytes........................................................").unwrap();
        let err = test_open_db(&fx.db()).err().expect("must fail");
        assert!(err.starts_with("team board unavailable:"), "{err}");
    }
}

shared_tests!(
    posts_get_increasing_seqs_and_read_back_in_order,
    concurrent_posts_never_share_a_seq,
    refuses_bad_team_ids_kinds_and_text,
    keeps_only_the_newest_posts_per_team,
    read_filters_since_limit_kind_author_and_search,
    cursors_move_on_new_reads_skip_own_posts_and_survive_a_reopen,
    new_reads_page_oldest_first_and_never_skip_unread_posts,
    new_reads_refuse_filters_and_leave_the_cursor_alone,
    format_characters_are_removed_from_text_and_names,
    clear_keeps_the_seq_counter_so_cursors_stay_valid,
    teams_report_counts_members_times_and_live_tasks,
    prunes_teams_idle_for_thirty_days_with_their_tasks,
    announcements_are_root_only_and_pinned_first,
    posts_link_to_a_task_of_the_same_team,
    add_list_and_show_a_task,
    claim_block_unblock_done_writes_history_and_a_done_note,
    refusals_name_the_current_state_and_owner,
    cancel_by_creator_root_or_person_but_never_done,
    eight_claimers_on_one_task_exactly_one_wins,
    eight_next_claimers_over_eight_tasks_all_get_different_ones,
    next_picks_priority_then_number_and_skips_waiting_tasks,
    next_with_labels_only_takes_tasks_carrying_one_of_them,
    dependencies_gate_claims_and_cycles_are_refused,
    a_dependency_chain_deeper_than_the_bound_is_refused,
    retries_are_limited_for_members_but_not_for_root,
    review_flow_submit_approve_reject,
    edit_changes_fields_checks_permissions_and_versions,
    list_filters_states_mine_search_stale_and_all,
    leases_expire_lazily_and_an_owner_write_renews_its_own,
    lease_tick_renews_only_alive_owners_of_this_instance,
    startup_adopts_recovered_owners_and_releases_the_rest,
    task_cap_prunes_oldest_finished_and_never_live_tasks,
    event_cap_drops_whole_finished_tasks_first,
    an_owner_cannot_skip_review_by_editing_it_away,
    a_cancelled_dependency_counts_as_met_and_is_flagged,
    dependency_changes_follow_the_edit_permission,
    a_person_cannot_claim_or_work_on_a_task,
    another_member_claims_after_a_lease_expired,
    block_moves_the_claim_to_the_acting_instance,
    live_history_over_the_event_cap_does_not_wipe_finished_tasks,
    read_refuses_a_malformed_cursor_tab,
    team_events_list_every_task_newest_window_oldest_first,
    a_person_reviews_retries_reopens_cancels_and_edits,
    row_ids_are_uuid_v7_in_creation_order,
    tombstones_hide_rows_and_are_purged_after_thirty_days,
    copy_data_moves_every_team_and_refuses_or_merges_into_a_board_with_data,
    many_writers_create_one_new_team_at_once,
    copy_keeps_read_cursors_when_posts_are_stored_out_of_read_order,
    copy_ignores_cleaned_up_teams_in_the_target,
);

fn many_writers_create_one_new_team_at_once(e: Engine) {
    let fx = Fixture::new(e, "newteam");
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let s = fx.store();
            std::thread::spawn(move || {
                if i % 2 == 0 {
                    s.post("brand-new", input(&format!("t{i}"), "note", "hello"), 1_000).map(|v| v["seq"].as_i64().unwrap())
                } else {
                    s.w("brand-new", TaskOpInput { title: Some(format!("task {i}")), ..op("add") }, &member(&format!("t{i}")), cx(1_000))
                        .map(|v| v["task"]["seq"].as_i64().unwrap())
                }
            })
        })
        .collect();
    let results: Vec<Result<i64, String>> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert!(results.iter().all(Result::is_ok), "{results:?}");
    let s = fx.store();
    assert_eq!(s.teams().len(), 1, "one team row");
    assert_eq!(fx.raw_count("SELECT count(*) FROM teams"), 1);
    let mut posts = seqs(&s.read("brand-new", ReadQuery::default()).unwrap());
    posts.sort_unstable();
    assert_eq!(posts, vec![1, 2, 3, 4]);
    let mut tasks = task_seqs(&s.list("brand-new", TaskListQuery::default(), 2_000));
    tasks.sort_unstable();
    assert_eq!(tasks, vec![1, 2, 3, 4]);
}

/// A board whose post rows are stored in another order than they were read: "early" was
/// read before p2 and p3 but sits last in the table. c9 has read up to p1.
fn out_of_order_board(e: Engine, tag: &str) -> (Fixture, B) {
    let fx = Fixture::new(e, tag);
    let s = fx.store();
    s.post("o", input("t1", "note", "p1"), 1).unwrap();
    s.read("o", ReadQuery { cursor_tab: Some("c9".into()), ..Default::default() }).unwrap();
    s.post("o", input("t1", "note", "p2"), 2).unwrap();
    s.post("o", input("t1", "note", "p3"), 3).unwrap();
    fx.raw_exec(
        "INSERT INTO posts (id, team_uid, seq, ts, author_id, kind, text, arrival, origin_host, updated_at)
         SELECT 'early-row', team_uid, 99, 0, 't9', 'note', 'early', min(arrival) - 1, 'host-b', 0 FROM posts GROUP BY team_uid",
    );
    (fx, s)
}

fn unread_texts(s: &B) -> Vec<String> {
    let r = s.read("o", ReadQuery { cursor_tab: Some("c9".into()), ..Default::default() }).unwrap();
    r["posts"].as_array().unwrap().iter().map(|p| p["text"].as_str().unwrap().to_string()).collect()
}

fn copy_keeps_read_cursors_when_posts_are_stored_out_of_read_order(e: Engine) {
    // From the engine under test into a fresh SQLite file…
    let (_src, a) = out_of_order_board(e, "oosrc");
    let dst = Fixture::new(Engine::Sqlite, "oodst");
    let b = dst.store();
    run(super::store::copy_between(&a.0, &b.0, false)).unwrap();
    assert_eq!(unread_texts(&b), vec!["p2", "p3"], "the cursor did not jump past unread posts");
    // …and from an out-of-order SQLite file into the engine under test.
    let (_src2, a2) = out_of_order_board(Engine::Sqlite, "oosrc2");
    let dst2 = Fixture::new(e, "oodst2");
    let b2 = dst2.store();
    run(super::store::copy_between(&a2.0, &b2.0, false)).unwrap();
    assert_eq!(unread_texts(&b2), vec!["p2", "p3"]);
}

fn copy_ignores_cleaned_up_teams_in_the_target(e: Engine) {
    let day = 24 * 60 * 60 * 1000;
    let src = Fixture::new(Engine::Sqlite, "deadsrc");
    let a = src.store();
    a.post("r1", input("t1", "note", "copied"), 100 * day).unwrap();
    // The target once had the same team (copied earlier), then cleaned it up.
    let dst = Fixture::new(e, "deaddst");
    let b = dst.store();
    run(super::store::copy_between(&a.0, &b.0, false)).unwrap();
    if let BoardStore::Pg(p) = &b.0 {
        assert_eq!(run(p.stale_count(200 * day, STALE_AFTER_MS)).unwrap(), 1, "the dry run counts what cleanup retires");
    }
    assert_eq!(run(b.0.prune_stale(200 * day, STALE_AFTER_MS)).unwrap(), 1);
    assert!(b.teams().is_empty());
    // A cleaned-up team does not make the target "not empty" and does not block the copy.
    let r = run(super::store::copy_between(&a.0, &b.0, false)).unwrap();
    assert_eq!(r["teams"], 1);
    assert_eq!(b.read("r1", ReadQuery::default()).unwrap()["total"], 1);
    assert_eq!(dst.raw_count("SELECT count(*) FROM teams"), 1, "the tombstone was replaced");
}

// ── Copy data (Settings) ─────────────────────────────────────────────────

/// A board with a bit of everything: notes, an announcement, tasks with a dependency, a
/// review, history and a read cursor.
fn fill_for_copy(s: &B) {
    s.post("r1", PostInput { root: true, ..input("lead", "announce", "the plan") }, 1).unwrap();
    s.post("r1", input("t2", "finding", "a finding"), 2).unwrap();
    let a = s.add("r1", "first", &member("lead"), 3);
    let b = s.w("r1", TaskOpInput { title: Some("second".into()), after: vec![a], review: Some(true), ..op("add") }, &member("lead"), cx(4)).unwrap()["task"]["seq"].as_i64().unwrap();
    s.w("r1", on("claim", a), &member("c1"), cx(5)).unwrap();
    s.w("r1", done_op(a, "did it"), &member("c1"), cx(6)).unwrap();
    s.w("r1", on("claim", b), &member("c2"), cx(7)).unwrap();
    s.read("r1", ReadQuery { cursor_tab: Some("c9".into()), ..Default::default() }).unwrap();
    s.post("r1", input("t3", "note", "unread by c9"), 8).unwrap();
    s.post("r2", input("x", "note", "another team"), 9).unwrap();
}

/// What a reader sees (ids, numbers, states, history), for comparing two boards.
fn snapshot(s: &B) -> Value {
    let teams = s.teams();
    let mut out = Vec::new();
    for t in &teams {
        let team = t["team"].as_str().unwrap();
        let tasks = s.list(team, TaskListQuery { all: true, ..Default::default() }, 100);
        let shows: Vec<Value> = task_seqs(&tasks).iter().map(|n| s.show(team, *n, 100)).collect();
        out.push(serde_json::json!({
            "team": t,
            "read": s.read(team, ReadQuery { limit: Some(500), ..Default::default() }).unwrap(),
            "tasks": tasks,
            "shows": shows,
        }));
    }
    Value::Array(out)
}

fn copy_data_moves_every_team_and_refuses_or_merges_into_a_board_with_data(e: Engine) {
    let src = Fixture::new(Engine::Sqlite, "copysrc");
    let a = src.store();
    fill_for_copy(&a);
    // SQLite → the engine under test → a fresh SQLite file: what readers see is the same.
    let mid = Fixture::new(e, "copymid");
    let m = mid.store();
    let res = run(super::store::copy_between(&a.0, &m.0, false)).unwrap();
    assert_eq!(res["teams"], 2);
    assert_eq!(res["posts"], 5, "r1: 3 notes and the done note; r2: one note");
    assert_eq!(res["tasks"], 2);
    assert_eq!(res["deps"], 1);
    assert_eq!(res["cursors"], 1);
    assert_eq!(snapshot(&m), snapshot(&a));
    // The cursor kept its meaning: c9 has read everything up to "unread by c9" only.
    let unread = m.read("r1", ReadQuery { cursor_tab: Some("c9".into()), ..Default::default() }).unwrap();
    assert_eq!(unread["posts"].as_array().unwrap().iter().map(|p| p["text"].as_str().unwrap()).collect::<Vec<_>>(), vec!["unread by c9"]);
    // Counters continue on the copy.
    assert_eq!(m.post("r1", input("t2", "note", "after the copy"), 50).unwrap()["seq"], 5);
    assert_eq!(m.add("r1", "third", &member("lead"), 50), 3);
    // A board with data refuses a plain copy and skips existing teams on merge.
    let err = run(super::store::copy_between(&a.0, &m.0, false)).unwrap_err();
    assert!(err.starts_with("the target board is not empty (2 teams)"), "{err}");
    a.post("r3", input("y", "note", "new team on the source"), 60).unwrap();
    let merged = run(super::store::copy_between(&a.0, &m.0, true)).unwrap();
    assert_eq!(merged["teams"], 1);
    assert_eq!(merged["skippedTeams"], serde_json::json!(["r1", "r2"]));
    assert_eq!(m.read("r3", ReadQuery::default()).unwrap()["total"], 1);
    // Back into a fresh SQLite file.
    let back = Fixture::new(Engine::Sqlite, "copyback");
    let k = back.store();
    run(super::store::copy_between(&m.0, &k.0, false)).unwrap();
    assert_eq!(snapshot(&k), snapshot(&m));
    // The source never changes.
    assert_eq!(a.read("r1", ReadQuery { limit: Some(500), ..Default::default() }).unwrap()["total"], 4);
}

#[test]
fn a_copied_sqlite_board_logs_every_row_for_a_later_sync() {
    let src = Fixture::new(Engine::Sqlite, "copylog1");
    let a = src.store();
    fill_for_copy(&a);
    let dst = Fixture::new(Engine::Sqlite, "copylog2");
    let b = dst.store();
    b.teams(); // opens (creates) the file
    run(super::store::copy_between(&a.0, &b.0, false)).unwrap();
    let logged = |tbl: &str| dst.raw_count(&format!("SELECT count(DISTINCT row_id) FROM changes WHERE tbl = '{tbl}'"));
    let live = |sql: &str| dst.raw_count(sql);
    assert_eq!(logged("teams"), live("SELECT count(*) FROM teams"));
    assert_eq!(logged("posts"), live("SELECT count(*) FROM posts"));
    assert_eq!(logged("tasks"), live("SELECT count(*) FROM tasks"));
    assert_eq!(logged("task_deps"), live("SELECT count(*) FROM task_deps"));
    assert_eq!(logged("task_events"), live("SELECT count(*) FROM task_events"));
}

// ── PostgreSQL specifics (only with BBARIT_TEST_PG_URL) ──────────────────

mod pg_only {
    use super::*;

    fn pg() -> bool {
        pg_enabled()
    }

    /// A schema with no tables yet (removed afterwards).
    struct Bare(PgTarget);

    impl Bare {
        fn new(tag: &str) -> Bare {
            let n = FIXTURE_N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Bare(pg_test_target(&test_schema(tag, n)))
        }
    }

    impl Drop for Bare {
        fn drop(&mut self) {
            remove_test_schema(&self.0);
        }
    }

    #[test]
    fn the_server_records_the_program_version_it_was_given() {
        if !pg() {
            return;
        }
        let bare = Bare::new("appver");
        let store = test_pg(bare.0.clone());
        run(store.migrate(true)).unwrap();
        assert_eq!(run(store.sync_register("mac-v", "inst-v")).unwrap(), None);
        let (created, host): (String, Option<String>) = run(async {
            let mut c = pg_raw(&bare.0).await;
            let created = sqlx::query_scalar("SELECT value FROM board_meta WHERE key = 'created_by_app_version'").fetch_one(&mut c).await.unwrap();
            let host = sqlx::query_scalar("SELECT app_version FROM hosts WHERE host = 'mac-v'").fetch_one(&mut c).await.unwrap();
            (created, host)
        });
        assert_eq!(created, TEST_APP_VERSION);
        assert_eq!(host.as_deref(), Some(TEST_APP_VERSION));
    }

    #[test]
    fn tables_are_created_only_on_request_and_a_newer_schema_is_refused() {
        if !pg() {
            return;
        }
        let bare = Bare::new("migrate");
        let store = test_pg(bare.0.clone());
        // Nothing exists: commands fail clearly, nothing is created by them.
        let e = run(store.post("t".into(), input("t1", "note", "x"), cx(1))).unwrap_err();
        assert!(e.starts_with("team board unavailable: no board tables in PostgreSQL schema"), "{e}");
        assert_eq!(run(store.stored_schema_version()).unwrap(), None);
        // A dry run shows the statements, quoted schema included, and changes nothing.
        let plan = run(store.migrate(false)).unwrap();
        assert_eq!(plan["applied"], false);
        assert_eq!(plan["from"], Value::Null);
        let sql: Vec<String> = plan["steps"][0]["sql"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert!(sql[0].starts_with(&format!("CREATE SCHEMA IF NOT EXISTS \"{}\"", bare.0.schema)));
        assert_eq!(run(store.stored_schema_version()).unwrap(), None);
        let done = run(store.migrate(true)).unwrap();
        assert_eq!(done["applied"], true);
        assert_eq!(run(store.migrate(true)).unwrap()["upToDate"], true, "running it again is a no-op");
        let s = B(BoardStore::Pg(test_pg(bare.0.clone())));
        assert_eq!(s.post("t", input("t1", "note", "works"), 2).unwrap()["seq"], 1);
        // Every write stamps server_seq for a later sync; an update stamps a newer one.
        let f = Fixture { dir: std::env::temp_dir(), limits: Limits::default(), engine: Engine::Pg, pg: Some(bare.0.clone()) };
        let first = f.raw_count("SELECT server_seq FROM teams");
        assert!(first > 0);
        s.post("t", input("t1", "note", "again"), 3).unwrap();
        assert!(f.raw_count("SELECT server_seq FROM teams") > first);
        assert!(f.raw_count("SELECT min(server_seq) FROM posts") > 0);
        assert_eq!(f.raw_count("SELECT count(*) FROM hosts"), 0, "the hosts table is filled only by sync");
        // A schema from a newer app: refused by commands and by the migration.
        f.raw_exec(&format!("UPDATE board_meta SET value = '{}' WHERE key = 'schema_version'", super::super::pg::SCHEMA_VERSION + 1));
        std::mem::forget(f); // the Bare guard removes the schema
        let fresh = test_pg(bare.0.clone());
        let e = run(fresh.post("t".into(), input("t1", "note", "x"), cx(4))).unwrap_err();
        let v = super::super::pg::SCHEMA_VERSION;
        assert!(e.contains(&format!("database is from a newer app version (schema {}, this app knows {v})", v + 1)), "{e}");
        let e = run(fresh.migrate(true)).unwrap_err();
        assert!(e.starts_with("database is from a newer app version"), "{e}");
    }

    #[test]
    fn a_schema_with_someone_elses_tables_is_refused() {
        if !pg() {
            return;
        }
        let bare = Bare::new("foreign");
        let q = super::super::config::quote_ident(&bare.0.schema);
        run(async {
            let mut c = sqlx::PgConnection::connect_with(&bare.0.opts).await.unwrap();
            sqlx::raw_sql(&format!("CREATE SCHEMA {q}; CREATE TABLE {q}.tasks (id int, what text)")).execute(&mut c).await.unwrap();
        });
        let store = test_pg(bare.0.clone());
        let e = run(store.migrate(false)).unwrap_err();
        assert_eq!(e, format!("schema {} already contains tables named tasks that the board did not create: choose an empty schema", bare.0.schema));
        assert!(run(store.migrate(true)).is_err());
        let d = run(PgStore::diagnose(&bare.0, TEST_APP_VERSION));
        assert_eq!(d["foreignTables"], serde_json::json!(["tasks"]));
        assert!(d["next"].as_str().unwrap().contains("choose an empty schema"), "{d}");
    }

    #[test]
    fn test_connection_reports_a_ready_board_and_hides_a_wrong_password() {
        if !pg() {
            return;
        }
        let fx = Fixture::new(Engine::Pg, "diag");
        let t = fx.pg.clone().unwrap();
        let d = run(PgStore::diagnose(&t, TEST_APP_VERSION));
        assert_eq!(d["reachable"], true, "{d}");
        assert!(d["serverVersion"].as_str().is_some_and(|v| !v.is_empty()));
        assert_eq!(d["schemaExists"], true);
        assert_eq!(d["schemaVersion"], super::super::pg::SCHEMA_VERSION);
        assert_eq!(d["canReadWrite"], true);
        assert!(d["tls"].is_boolean());
        assert!(d["next"].as_str().unwrap().starts_with("ready"), "{d}");
        // A schema that does not exist yet.
        let bare = Bare::new("diagbare");
        let d = run(PgStore::diagnose(&bare.0, TEST_APP_VERSION));
        assert_eq!(d["schemaExists"], false);
        assert_eq!(d["schemaVersion"], Value::Null);
        assert!(d["next"].as_str().unwrap().contains("Create / upgrade tables"), "{d}");
        // A wrong password: unreachable, and the password never appears in the answer.
        let url = pg_url().unwrap();
        let wrong = super::super::config::url_password(&url).map(|p| url.replacen(&format!(":{p}@"), ":wrong-pass-x@", 1)).unwrap_or(url);
        let settings = super::super::config::PgSettings { schema: "bbarit_board".into(), ..Default::default() };
        let bad = super::super::config::pg_target(&settings, Some(&wrong), None).unwrap();
        let d = run(PgStore::diagnose(&bad, TEST_APP_VERSION));
        assert_eq!(d["reachable"], false, "{d}");
        assert!(!d.to_string().contains("wrong-pass-x"), "{d}");
        let e = run(test_pg(bad).teams()).unwrap_err();
        assert!(e.starts_with("team board unavailable:") && !e.contains("wrong-pass-x"), "{e}");
    }

    #[test]
    fn an_unreachable_server_fails_board_commands_clearly() {
        // Needs no server: nothing listens on port 1.
        let settings = super::super::config::PgSettings { host: "127.0.0.1".into(), port: 1, database: "x".into(), user: "u".into(), ..Default::default() };
        let sec = super::super::config::Secret { password: "test".into(), label: Some(settings.label()) };
        let t = super::super::config::pg_target(&settings, None, Some(&sec)).unwrap();
        let e = run(test_pg(t).post("t".into(), input("t1", "note", "x"), cx(1))).unwrap_err();
        assert!(e.starts_with("team board unavailable:"), "{e}");
    }
}

// ── PostgreSQL operations in a caller's transaction (a server that embeds the store) ─────

mod pg_on_connection {
    use super::super::error::StoreError;
    use super::super::pg::{self, PgOps};
    use super::*;
    use sqlx::postgres::PgPoolOptions;

    async fn connect(t: &PgTarget) -> sqlx::PgConnection {
        sqlx::PgConnection::connect_with(&t.opts).await.unwrap()
    }

    fn add_op(title: &str, review: bool) -> TaskOpInput {
        TaskOpInput { title: Some(title.into()), review: Some(review), ..op("add") }
    }

    fn submit_op(task: i64) -> TaskOpInput {
        TaskOpInput { result: Some(ResultInput { summary: Some("did it".into()), ..Default::default() }), ..on("submit", task) }
    }

    /// post, task add / claim / submit / approve, lease_apply and clear, then a row in a table
    /// of the caller's own, all in one transaction that ends with `commit` (or a rollback).
    async fn one_request(t: &PgTarget, commit: bool) {
        let ops = PgOps::new(&t.schema).unwrap();
        let mut c = connect(t).await;
        let mut tx = c.begin().await.unwrap();
        let p = ops.post(&mut tx, "req", &input("t1", "note", "hello"), &cx(1_000)).await.unwrap();
        assert_eq!(p["seq"], 1);
        // Two operations in one transaction see each other's writes.
        let r = ops.read(&mut tx, "req", &ReadQuery::default(), Some(&here())).await.unwrap();
        assert_eq!(seqs(&r), vec![1]);
        let one = ops.task_write(&mut tx, "req", &add_op("first", true), &member("lead"), &cx(1_001)).await.unwrap();
        assert_eq!(one["task"]["seq"], 1);
        assert_eq!(ops.task_show(&mut tx, "req", 1, false, None, &cx(1_002)).await.unwrap()["task"]["state"], "open");
        ops.task_write(&mut tx, "req", &on("claim", 1), &member("b1"), &cx(1_003)).await.unwrap();
        ops.task_write(&mut tx, "req", &submit_op(1), &member("b1"), &cx(1_004)).await.unwrap();
        let done = ops.task_write(&mut tx, "req", &on("approve", 1), &member("b2"), &cx(1_005)).await.unwrap();
        assert_eq!(done["to"], "done");
        ops.task_write(&mut tx, "req", &add_op("second", false), &member("lead"), &cx(1_006)).await.unwrap();
        ops.task_write(&mut tx, "req", &on("claim", 2), &member("b3"), &cx(1_007)).await.unwrap();
        let listed = ops.task_list(&mut tx, "req", &TaskListQuery { all: true, ..Default::default() }, &cx(1_008)).await.unwrap();
        assert_eq!(task_seqs(&listed), vec![2, 1]);
        let held = ops.held_on_host(&mut tx, &here()).await.unwrap();
        let item = LeaseItem { id: held[0]["id"].as_str().unwrap().to_string(), instance: "inst-a".into() };
        let applied = ops.lease_apply(&mut tx, "inst-new", &[item], &[], 1_009, 60_000, Some(&here())).await.unwrap();
        assert_eq!(applied["adopted"], 1);
        let cleared = ops.clear(&mut tx, "req", &cx(1_010)).await.unwrap();
        assert_eq!(cleared["removed"], 2, "the note and the done note");
        let own = format!("INSERT INTO {}.app_log (msg) VALUES ('request 1')", super::super::config::quote_ident(&t.schema));
        sqlx::query(&own).execute(&mut *tx).await.unwrap();
        if commit {
            tx.commit().await.unwrap();
        } else {
            tx.rollback().await.unwrap();
        }
    }

    #[test]
    fn a_rolled_back_request_leaves_nothing_and_a_committed_one_everything() {
        if !pg_enabled() {
            return;
        }
        let fx = Fixture::new(Engine::Pg, "onconn");
        fx.raw_exec("CREATE TABLE app_log (msg TEXT NOT NULL)");
        let t = fx.pg.clone().unwrap();
        run(one_request(&t, false));
        for table in ["teams", "posts", "tasks", "task_events", "app_log"] {
            assert_eq!(fx.raw_count(&format!("SELECT count(*) FROM {table}")), 0, "{table} after ROLLBACK");
        }
        run(one_request(&t, true));
        assert_eq!(fx.raw_count("SELECT count(*) FROM teams"), 1);
        assert_eq!(fx.raw_count("SELECT count(*) FROM posts"), 2, "both posts, tombstoned by clear");
        assert_eq!(fx.raw_count("SELECT count(*) FROM posts WHERE deleted_at IS NULL"), 0);
        assert_eq!(fx.raw_count("SELECT count(*) FROM tasks WHERE state = 'done'"), 1);
        assert_eq!(fx.raw_strings("SELECT owner_instance FROM tasks WHERE seq = 2"), vec!["inst-new".to_string()]);
        assert_eq!(fx.raw_count("SELECT count(*) FROM app_log"), 1);
        // The store's own wrappers read what the caller's transaction committed.
        assert_eq!(fx.store().state("req", 1, 2_000), "done");
    }

    #[test]
    fn from_pool_uses_the_callers_pool_and_leaves_it_open() {
        if !pg_enabled() {
            return;
        }
        let fx = Fixture::new(Engine::Pg, "frompool");
        let t = fx.pg.clone().unwrap();
        run(async {
            let app = format!("bbt-frompool-{}", std::process::id());
            let pool = PgPoolOptions::new().max_connections(2).connect_with(t.opts.clone().application_name(&app)).await.unwrap();
            assert!(PgStore::from_pool(pool.clone(), "Bad Name", Limits::default(), TEST_APP_VERSION).is_err());
            let store = PgStore::from_pool(pool.clone(), &t.schema, Limits::default(), TEST_APP_VERSION).unwrap();
            assert_eq!(store.post("p".into(), input("t1", "note", "shared"), cx(1)).await.unwrap()["seq"], 1);
            // Eight commands at once: a pool of the store's own would open up to 5 connections;
            // on the server there are never more than the caller's pool allows (2).
            let store = std::sync::Arc::new(store);
            let busy: Vec<_> = (0..8)
                .map(|_| {
                    let s = store.clone();
                    tokio::spawn(async move { s.read("p".into(), ReadQuery::default(), Some(here())).await.unwrap() })
                })
                .collect();
            for b in busy {
                b.await.unwrap();
            }
            let mut admin = connect(&t).await;
            let on_server: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE application_name = $1")
                .bind(&app)
                .fetch_one(&mut admin)
                .await
                .unwrap();
            assert!((1..=2).contains(&on_server), "{on_server} connections");
            assert_eq!(pool.size() as i64, on_server);
            // A connection the caller takes from the same pool sees the store's write.
            let mut c = pool.acquire().await.unwrap();
            let sql = format!("SELECT count(*) FROM {}.posts", super::super::config::quote_ident(&t.schema));
            let n: i64 = sqlx::query_scalar(&sql).fetch_one(&mut *c).await.unwrap();
            assert_eq!(n, 1);
            drop(c);
            // `close` leaves a caller's pool open; closing the caller's pool stops the store.
            store.close().await;
            assert!(!pool.is_closed());
            assert_eq!(store.post("p".into(), input("t1", "note", "again"), cx(2)).await.unwrap()["seq"], 2);
            pool.close().await;
            let e = store.post("p".into(), input("t1", "note", "closed"), cx(3)).await.unwrap_err();
            assert!(e.starts_with("team board unavailable:"), "{e}");
        });
    }

    #[test]
    fn errors_carry_their_kind_and_the_same_text() {
        if !pg_enabled() {
            return;
        }
        let fx = Fixture::new(Engine::Pg, "kinds");
        let t = fx.pg.clone().unwrap();
        run(async {
            let ops = PgOps::new(&t.schema).unwrap();
            let mut conn = connect(&t).await;
            let c = &mut conn;
            // Invalid input.
            let e = ops.post(c, "bad team!", &input("t1", "note", "x"), &cx(1)).await.unwrap_err();
            assert!(matches!(e, StoreError::Invalid(_)) && e.kind() == "invalid", "{e:?}");
            assert_eq!(e.to_string(), "invalid team id (expected 1-128 characters of A-Z a-z 0-9 _ -)");
            assert_eq!(ops.post(c, "k", &input("t1", "gossip", "x"), &cx(1)).await.unwrap_err().kind(), "invalid");
            // Not found.
            let e = ops.task_show(c, "k", 9, false, None, &cx(1)).await.unwrap_err();
            assert_eq!((e.kind(), e.to_string().as_str()), ("not_found", "no task #9 in team k"));
            ops.task_write(c, "k", &add_op("one", false), &member("lead"), &cx(1_000)).await.unwrap();
            assert_eq!(ops.task_write(c, "k", &on("claim", 9), &member("b1"), &cx(1_000)).await.unwrap_err().kind(), "not_found");
            // Conflict: already claimed; an edit against an old version.
            let lease = TaskOpInput { lease_ms: Some(30_000), ..on("claim", 1) };
            ops.task_write(c, "k", &lease, &member("b1"), &cx(1_000)).await.unwrap();
            let e = ops.task_write(c, "k", &on("claim", 1), &member("b2"), &cx(1_001)).await.unwrap_err();
            assert_eq!((e.kind(), e.to_string().as_str()), ("conflict", "#1 is already claimed by b1 (b1 name)"));
            let edit = TaskOpInput { title: Some("new".into()), expected_version: Some(1), ..on("edit", 1) };
            assert_eq!(ops.task_write(c, "k", &edit, &member("lead"), &cx(1_002)).await.unwrap_err().kind(), "conflict");
            // Forbidden: someone else's task; a person working on a task.
            let e = ops.task_write(c, "k", &on("release", 1), &member("b3"), &cx(1_003)).await.unwrap_err();
            assert_eq!((e.kind(), e.to_string().as_str()), ("forbidden", "#1 is claimed by b1 (b1 name): only its owner can release it"));
            assert_eq!(ops.task_write(c, "k", &on("release", 1), &human(), &cx(1_003)).await.unwrap_err().kind(), "forbidden");
            // Lease lost: b1's lease runs out, a list expires it, b1 tries to finish.
            ops.task_list(c, "k", &TaskListQuery::default(), &cx(40_000)).await.unwrap();
            let e = ops.task_write(c, "k", &done_op(1, "late"), &member("b1"), &cx(40_001)).await.unwrap_err();
            assert_eq!((e.kind(), e.to_string().as_str()), ("lease_lost", "#1 is open: claim it first"));
            // Still lease lost once someone else holds it; never-owner b3 stays forbidden.
            ops.task_write(c, "k", &on("claim", 1), &member("b2"), &cx(40_002)).await.unwrap();
            assert_eq!(ops.task_write(c, "k", &done_op(1, "late"), &member("b1"), &cx(40_003)).await.unwrap_err().kind(), "lease_lost");
            assert_eq!(ops.task_write(c, "k", &done_op(1, "x"), &member("b3"), &cx(40_003)).await.unwrap_err().kind(), "forbidden");
            // b1 claims again later: a refusal is no longer about the old lease.
            ops.task_write(c, "k", &on("release", 1), &member("b2"), &cx(40_004)).await.unwrap();
            ops.task_write(c, "k", &on("claim", 1), &member("b1"), &cx(40_005)).await.unwrap();
            assert_eq!(ops.task_write(c, "k", &on("unblock", 1), &member("b1"), &cx(40_006)).await.unwrap_err().kind(), "conflict");
            // Unavailable: a schema without board tables.
            let bare = PgOps::new("bbt_no_such_board_schema").unwrap();
            assert_eq!(bare.teams(c).await.unwrap_err().kind(), "unavailable");
        });
        // The store's wrappers keep the same text.
        assert_eq!(fx.store().w("k", on("claim", 9), &member("b1"), cx(50_000)).unwrap_err(), "no task #9 in team k");
    }

    /// A schema of its own (removed afterwards), for tests that create the tables themselves.
    struct OwnSchema(PgTarget);

    impl OwnSchema {
        fn new(tag: &str) -> OwnSchema {
            let n = FIXTURE_N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            OwnSchema(pg_test_target(&test_schema(tag, n)))
        }
    }

    impl Drop for OwnSchema {
        fn drop(&mut self) {
            remove_test_schema(&self.0);
        }
    }

    /// Everything in a schema: relations by kind, functions, triggers by table, as sorted text.
    async fn objects(c: &mut sqlx::PgConnection, schema: &str) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT x FROM (
               SELECT c.relkind::text || ':' || c.relname AS x FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1
               UNION ALL SELECT 'function:' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1
               UNION ALL SELECT 'trigger:' || c.relname || ':' || t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal
             ) o ORDER BY x",
        )
        .bind(schema)
        .fetch_all(&mut *c)
        .await
        .unwrap()
    }

    #[test]
    fn a_refused_operation_leaves_no_partial_write_inside_atomically() {
        if !pg_enabled() {
            return;
        }
        let fx = Fixture::new(Engine::Pg, "atomic");
        fx.raw_exec("CREATE TABLE app_log (msg TEXT NOT NULL)");
        let t = fx.pg.clone().unwrap();
        let own = format!("INSERT INTO {}.app_log (msg) VALUES ('refused')", super::super::config::quote_ident(&t.schema));
        // No room for any task: `task add` creates the team row, then refuses.
        let full = Limits { tasks: 0, ..Limits::default() };
        let ops = PgOps::new(&t.schema).unwrap().with_limits(full);
        run(async {
            // Without the savepoint, committing after the refusal keeps the new team row.
            let mut c = connect(&t).await;
            let mut tx = c.begin().await.unwrap();
            let e = ops.task_write(&mut tx, "bare", &add_op("x", false), &member("lead"), &cx(1)).await.unwrap_err();
            assert_eq!(e.kind(), "conflict", "{e}");
            tx.commit().await.unwrap();
            // With it: the refusal comes back, nothing of it remains, the caller's row commits.
            let mut tx = c.begin().await.unwrap();
            let e = board_store_atomically(&ops, &mut tx).await.unwrap_err();
            assert!(e.to_string().starts_with("task limit reached: team guarded has 0 tasks"), "{e}");
            sqlx::query(&own).execute(&mut *tx).await.unwrap();
            // The transaction is still usable for the store too.
            let ok = crate::atomically!(&mut *tx, |c| ops.post(c, "guarded", &input("t1", "note", "after"), &cx(3))).await.unwrap();
            assert_eq!(ok["seq"], 1);
            tx.commit().await.unwrap();
        });
        assert_eq!(fx.raw_strings("SELECT team FROM teams ORDER BY team"), vec!["bare".to_string(), "guarded".to_string()]);
        assert_eq!(fx.raw_count("SELECT count(*) FROM tasks"), 0);
        assert_eq!(fx.raw_count("SELECT count(*) FROM posts"), 1, "only the post after the refusal");
        assert_eq!(fx.raw_count("SELECT count(*) FROM app_log"), 1);
    }

    /// `atomically!` around a `task add` that is refused (the team row it created goes too).
    async fn board_store_atomically(ops: &PgOps, conn: &mut sqlx::PgConnection) -> Result<Value, StoreError> {
        let r = crate::atomically!(&mut *conn, |c| ops.task_write(c, "guarded", &add_op("x", false), &member("lead"), &cx(2))).await;
        let teams: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {}.teams WHERE team = 'guarded'", super::super::config::quote_ident(ops.schema())))
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        assert_eq!(teams, 0, "rolled back to the savepoint");
        r
    }

    #[test]
    fn a_serialization_failure_is_busy() {
        if !pg_enabled() {
            return;
        }
        let fx = Fixture::new(Engine::Pg, "busy");
        let t = fx.pg.clone().unwrap();
        run(async {
            let ops = PgOps::new(&t.schema).unwrap();
            let (mut a, mut b) = (connect(&t).await, connect(&t).await);
            ops.post(&mut a, "hot", &input("t1", "note", "first"), &cx(1)).await.unwrap();
            let mut tx = a.begin().await.unwrap();
            sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ").execute(&mut *tx).await.unwrap();
            ops.teams(&mut tx).await.unwrap(); // the snapshot starts here
            ops.post(&mut b, "hot", &input("t2", "note", "meanwhile"), &cx(2)).await.unwrap();
            let e = ops.post(&mut tx, "hot", &input("t1", "note", "late"), &cx(3)).await.unwrap_err();
            assert!(matches!(e, StoreError::Busy(_)) && e.is_retryable(), "{e:?}");
            assert!(e.to_string().starts_with("team board unavailable:"), "{e}");
        });
    }

    #[test]
    fn two_servers_migrating_at_once_end_with_one_board() {
        if !pg_enabled() {
            return;
        }
        let own = OwnSchema::new("migrace");
        let t = own.0.clone();
        let q = super::super::config::quote_ident(&t.schema);
        let applied = run(async {
            sqlx::query(&format!("CREATE SCHEMA {q}")).execute(&mut connect(&t).await).await.unwrap();
            let gate = std::sync::Arc::new(tokio::sync::Barrier::new(2));
            let runs: Vec<_> = (0..2)
                .map(|_| {
                    let (t, gate) = (t.clone(), gate.clone());
                    tokio::spawn(async move {
                        let mut c = connect(&t).await;
                        let mut tx = c.begin().await.unwrap();
                        gate.wait().await;
                        let m = pg::migrate_on(&mut tx, &t.schema, TEST_APP_VERSION).await.unwrap();
                        tx.commit().await.unwrap();
                        m.applied
                    })
                })
                .collect();
            let mut out = Vec::new();
            for r in runs {
                out.push(r.await.unwrap());
            }
            out.sort();
            assert_eq!(pg::schema_version_on(&mut connect(&t).await, &t.schema).await.unwrap(), Some(pg::SCHEMA_VERSION));
            out
        });
        assert_eq!(applied, vec![vec![], (2..=pg::SCHEMA_VERSION).collect::<Vec<_>>()], "one ran the steps, the other found them done");
    }

    /// A role that owns only its schema (no CREATE on the database), removed afterwards.
    struct OwnerRole {
        admin: PgTarget,
        role: String,
    }

    impl Drop for OwnerRole {
        fn drop(&mut self) {
            remove_test_schema(&self.admin);
            let statement = format!("DROP ROLE IF EXISTS \"{}\"", self.role);
            run(async {
                if let Ok(mut c) = sqlx::PgConnection::connect_with(&self.admin.opts).await {
                    let _ = sqlx::query(&statement).execute(&mut c).await;
                    let _ = c.close().await;
                }
            });
        }
    }

    #[test]
    fn a_schema_owner_without_create_on_the_database_runs_the_migration_steps() {
        if !pg_enabled() {
            return;
        }
        let n = FIXTURE_N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let schema = test_schema("ownedonly", n);
        let admin = pg_test_target(&schema);
        let guard = OwnerRole { admin: admin.clone(), role: format!("{schema}_role") };
        let q = super::super::config::quote_ident(&schema);
        let role = format!("\"{}\"", guard.role);
        run(async {
            let mut c = connect(&admin).await;
            sqlx::raw_sql(&format!("CREATE ROLE {role} LOGIN PASSWORD 'test'; CREATE SCHEMA {q} AUTHORIZATION {role}"))
                .execute(&mut c)
                .await
                .unwrap();
            let can_create: bool = sqlx::query_scalar("SELECT has_database_privilege($1, current_database(), 'CREATE')")
                .bind(&guard.role)
                .fetch_one(&mut c)
                .await
                .unwrap();
            assert!(!can_create, "the role must not be able to create schemas");
        });
        // The steps: no CREATE SCHEMA, versions 2..=current, none from the current version.
        let steps = pg::steps_in_schema(&schema, None).unwrap();
        assert_eq!(steps.iter().map(|s| s.version).collect::<Vec<_>>(), (2..=pg::SCHEMA_VERSION).collect::<Vec<_>>());
        assert!(steps.iter().flat_map(|s| &s.sql).all(|sql| !sql.contains("CREATE SCHEMA")));
        assert!(pg::steps_in_schema(&schema, Some(pg::SCHEMA_VERSION)).unwrap().is_empty());
        let owner = PgTarget { opts: admin.opts.clone().username(&guard.role).password("test"), ..admin.clone() };
        let desktop = Fixture::new(Engine::Pg, "ownedcmp");
        let d = desktop.pg.clone().unwrap();
        run(async {
            let mut c = connect(&owner).await;
            assert_eq!(pg::schema_version_on(&mut c, &schema).await.unwrap(), None);
            let mut tx = c.begin().await.unwrap();
            let done = pg::migrate_on(&mut tx, &schema, TEST_APP_VERSION).await.unwrap();
            tx.commit().await.unwrap();
            assert_eq!(done, pg::Migrated { from: None, to: pg::SCHEMA_VERSION, applied: (2..=pg::SCHEMA_VERSION).collect() });
            assert_eq!(pg::schema_version_on(&mut c, &schema).await.unwrap(), Some(pg::SCHEMA_VERSION));
            // Running it again is a no-op.
            let mut tx = c.begin().await.unwrap();
            let again = pg::migrate_on(&mut tx, &schema, TEST_APP_VERSION).await.unwrap();
            tx.commit().await.unwrap();
            assert_eq!(again, pg::Migrated { from: Some(pg::SCHEMA_VERSION), to: pg::SCHEMA_VERSION, applied: vec![] });
            // Exactly the tables the store says it owns.
            let tables: Vec<String> = sqlx::query_scalar("SELECT tablename::text FROM pg_tables WHERE schemaname = $1 ORDER BY 1")
                .bind(&schema)
                .fetch_all(&mut c)
                .await
                .unwrap();
            let mut owned: Vec<String> = pg::OWNED_TABLES.iter().map(|s| s.to_string()).collect();
            owned.sort();
            assert_eq!(tables, owned);
            let all = objects(&mut c, &schema).await;
            for s in pg::OWNED_SEQUENCES {
                assert!(all.contains(&format!("S:{s}")), "{s}: {all:?}");
            }
            for f in pg::OWNED_FUNCTIONS {
                assert!(all.contains(&format!("function:{f}")), "{f}: {all:?}");
            }
            // The same objects and version as the desktop's PgStore::migrate creates.
            let mut dc = connect(&d).await;
            assert_eq!(objects(&mut dc, &d.schema).await, all);
            assert_eq!(pg::schema_version_on(&mut dc, &d.schema).await.unwrap(), Some(pg::SCHEMA_VERSION));
            // The role uses the board it created.
            let ops = PgOps::new(&schema).unwrap();
            assert_eq!(ops.post(&mut c, "own", &input("t1", "note", "mine"), &cx(1)).await.unwrap()["seq"], 1);
            assert!(pg::db_now_ms(&mut c).await.unwrap() > 1_600_000_000_000);
            let _ = c.close().await;
        });
        drop(guard);
    }
}

// ── Sync between two machines (stage 3b) ─────────────────────────────────
//
// Two SQLite files act as two machines ("mac-a", "mac-b") syncing through one PostgreSQL
// schema. Runs only with `BBARIT_TEST_PG_URL` (fails without it under BBARIT_TEST_PG_REQUIRED=1).
mod sync_two_machines {
    use super::super::sync_core::{self as sync, SyncError};
    use super::*;

    const A: &str = "mac-a";
    const B: &str = "mac-b";

    struct Two {
        dir: PathBuf,
        target: PgTarget,
        a: BoardStore,
        b: BoardStore,
    }

    impl Drop for Two {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
            remove_test_schema(&self.target);
        }
    }

    fn two(tag: &str) -> Option<Two> {
        two_with(tag, Limits::default())
    }

    fn two_with(tag: &str, limits: Limits) -> Option<Two> {
        if !pg_enabled() {
            return None;
        }
        let n = FIXTURE_N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("bbarit-sync-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let target = pg_test_target(&test_schema(&format!("sync{tag}"), n));
        run(test_pg(target.clone()).migrate(true)).expect("create the test schema");
        let a = BoardStore::Sqlite(test_sqlite_limits(dir.join("a.db"), limits));
        let b = BoardStore::Sqlite(test_sqlite_limits(dir.join("b.db"), limits));
        Some(Two { dir, target, a, b })
    }

    fn lite(s: &BoardStore) -> &SqliteStore {
        match s {
            BoardStore::Sqlite(l) => l,
            BoardStore::Pg(_) => unreachable!(),
        }
    }

    fn at(host: &str, now: i64) -> Ctx {
        Ctx { now, host: Some(host.into()), instance: format!("inst-{host}") }
    }

    fn agent(id: &str, host: &str) -> Actor {
        Actor { id: id.into(), name: Some(id.into()), cli: Some("claude".into()), host: Some(host.into()), root: false, human: false }
    }

    impl Two {
        fn server(&self) -> PgStore {
            test_pg(self.target.clone())
        }
        fn sync(&self, which: &str, now: i64) -> Result<sync::RoundReport, SyncError> {
            let store = if which == A { &self.a } else { &self.b };
            let server = self.server();
            let r = run(sync::sync_round(lite(store), &server, "test-server", which, TEST_INSTANCE, None, now, &|_| {}));
            run(server.close());
            r
        }
        fn sync_with(&self, which: &str, server: &PgStore, machine: Option<&str>, now: i64) -> Result<sync::RoundReport, SyncError> {
            let store = if which == A { &self.a } else { &self.b };
            run(sync::sync_round(lite(store), server, "test-server", which, TEST_INSTANCE, machine, now, &|_| {}))
        }
        fn post(&self, which: &str, team: &str, author: &str, text: &str, now: i64) -> Result<Value, String> {
            let store = if which == A { &self.a } else { &self.b };
            run(store.post(team.into(), input(author, "note", text), at(which, now)))
        }
        fn add(&self, which: &str, team: &str, title: &str, now: i64) -> Result<Value, String> {
            let store = if which == A { &self.a } else { &self.b };
            run(store.task_write(team.into(), TaskOpInput { title: Some(title.into()), ..op("add") }, agent("t1", which), at(which, now)))
        }
        fn write(&self, which: &str, team: &str, o: TaskOpInput, actor: Actor, now: i64) -> Result<Value, String> {
            let store = if which == A { &self.a } else { &self.b };
            run(store.task_write(team.into(), o, actor, at(which, now)))
        }
        fn list(&self, which: &str, team: &str, now: i64) -> Value {
            let store = if which == A { &self.a } else { &self.b };
            run(store.task_list(team.into(), TaskListQuery { all: true, ..Default::default() }, at(which, now))).unwrap()
        }
        fn read(&self, which: &str, team: &str, q: ReadQuery) -> Value {
            let store = if which == A { &self.a } else { &self.b };
            run(store.read(team.into(), q, Some(which.into()))).unwrap()
        }
        fn teams(&self, which: &str) -> Vec<Value> {
            run(if which == A { &self.a } else { &self.b }.teams()).unwrap()
        }
        fn status(&self, which: &str) -> Value {
            run(lite(if which == A { &self.a } else { &self.b }).run(|c, _| super::super::sqlite::sync_status_local(c))).unwrap()
        }
        fn pg_exec(&self, sql: &str) {
            run(async {
                let mut c = pg_raw(&self.target).await;
                sqlx::raw_sql(sql).execute(&mut c).await.unwrap();
            });
        }
        fn pg_count(&self, sql: &str) -> i64 {
            run(async {
                let mut c = pg_raw(&self.target).await;
                sqlx::query_scalar::<_, i64>(sql).fetch_one(&mut c).await.unwrap()
            })
        }
    }

    fn states(list: &Value) -> Vec<(i64, String)> {
        let mut v: Vec<(i64, String)> =
            list["tasks"].as_array().unwrap().iter().map(|t| (t["seq"].as_i64().unwrap(), t["state"].as_str().unwrap().to_string())).collect();
        v.sort();
        v
    }

    #[test]
    fn a_team_appears_on_the_other_machine_read_only_with_the_same_numbers() {
        let Some(t) = two("appear") else { return };
        t.post(A, "lead", "t1", "hello from a", 1_000).unwrap();
        t.post(A, "lead", "t2", "second", 1_001).unwrap();
        t.add(A, "lead", "first task", 1_002).unwrap();
        t.add(A, "lead", "second task", 1_003).unwrap();
        t.write(A, "lead", on("claim", 1), agent("t1", A), 1_004).unwrap();
        t.sync(A, 2_000).unwrap();
        let r = t.sync(B, 2_001).unwrap();
        assert!(r.pulled > 0);
        assert_eq!(r.teams, vec!["lead".to_string()]);
        let tb = t.teams(B);
        assert_eq!(tb.len(), 1);
        assert_eq!(tb[0]["homeHost"], A);
        assert_eq!(tb[0]["mirror"], true);
        assert_eq!(tb[0]["lastSeq"], 2);
        assert_eq!(tb[0]["liveTasks"], 2);
        assert_eq!(seqs(&t.read(B, "lead", ReadQuery::default())), vec![1, 2]);
        assert_eq!(states(&t.list(B, "lead", 2_002)), states(&t.list(A, "lead", 2_002)));
        assert_eq!(states(&t.list(B, "lead", 2_002)), vec![(1, "claimed".into()), (2, "open".into())]);
        assert!(t.teams(A)[0].get("mirror").is_none(), "home team is not a mirror at home");

        // Every write on the mirror is refused, agents and a person alike.
        let refusal = "this team lives on mac-a; it is read-only here";
        assert_eq!(t.post(B, "lead", "t9", "hi", 2_003).unwrap_err(), refusal);
        assert_eq!(t.add(B, "lead", "x", 2_003).unwrap_err(), refusal);
        assert_eq!(t.write(B, "lead", on("claim", 2), agent("t9", B), 2_003).unwrap_err(), refusal);
        assert_eq!(t.write(B, "lead", on("cancel", 2), human(), 2_003).unwrap_err(), refusal);
        assert_eq!(run(t.b.clear("lead".into(), at(B, 2_003))).unwrap_err(), refusal);
        // Reads, search and history work.
        let found = t.read(B, "lead", ReadQuery { search: Some("hello".into()), ..Default::default() });
        assert_eq!(seqs(&found), vec![1]);
        let shown = run(t.b.task_show("lead".into(), 1, true, None, at(B, 2_004))).unwrap();
        assert!(!shown["events"].as_array().unwrap().is_empty());
        // Leases are evaluated only at home: far in the future B still shows the claim.
        assert_eq!(states(&t.list(B, "lead", 10_000_000))[0].1, "claimed");
        assert_eq!(t.status(B)["machines"][0]["host"], A);
        assert_eq!(t.status(B)["machines"][0]["teams"], 1);
    }

    #[test]
    fn updates_and_tombstones_propagate() {
        let Some(t) = two("updates") else { return };
        t.post(A, "lead", "t1", "one", 1_000).unwrap();
        t.add(A, "lead", "work", 1_001).unwrap();
        t.write(A, "lead", on("claim", 1), agent("t1", A), 1_002).unwrap();
        t.sync(A, 2_000).unwrap();
        t.sync(B, 2_001).unwrap();
        t.write(A, "lead", done_op(1, "finished it"), agent("t1", A), 3_000).unwrap();
        run(t.a.clear("lead".into(), at(A, 3_001))).unwrap();
        t.sync(A, 4_000).unwrap();
        t.sync(B, 4_001).unwrap();
        assert_eq!(states(&t.list(B, "lead", 4_002)), vec![(1, "done".into())]);
        let posts = t.read(B, "lead", ReadQuery::default());
        assert!(seqs(&posts).is_empty(), "cleared on A, gone on B: {posts}");
        let shown = run(t.b.task_show("lead".into(), 1, false, None, at(B, 4_003))).unwrap();
        assert_eq!(shown["task"]["result"]["summary"], "finished it");
    }

    #[test]
    fn a_batch_sent_twice_changes_nothing() {
        let Some(t) = two("idem") else { return };
        t.post(A, "lead", "t1", "one", 1_000).unwrap();
        t.add(A, "lead", "work", 1_001).unwrap();
        // Crash after the server commit, before pushed_seq is stored: the batch goes again.
        let server = t.server();
        let local = lite(&t.a);
        run(local.run(|c, l| super::super::sqlite::sync_prepare(c, l, "test-server", A, None, 1_500))).unwrap();
        run(server.sync_register(A, &t.status(A)["instanceId"].as_str().unwrap().to_string())).unwrap();
        let (_, rows) = run(local.run(|c, _| super::super::sqlite::sync_full_batch(c, A, 500))).unwrap();
        let first = run(server.sync_push(A, t.status(A)["instanceId"].as_str().unwrap(), &rows, 1_500)).unwrap();
        assert!(first.written > 0);
        let again = run(server.sync_push(A, t.status(A)["instanceId"].as_str().unwrap(), &rows, 1_501)).unwrap();
        assert_eq!((again.written, again.refused), (0, 0), "the row_version guard ignores rows the server has; the same version is not a refusal");
        run(server.close());
        let before = t.pg_count("SELECT max(server_seq) FROM teams");
        t.sync(A, 2_000).unwrap();
        assert_eq!(t.pg_count("SELECT count(*) FROM posts"), 1);
        assert_eq!(t.pg_count("SELECT count(*) FROM tasks"), 1);
        assert_eq!(t.pg_count("SELECT max(server_seq) FROM teams"), before, "the re-sent team row was not rewritten");
        assert_eq!(t.status(A)["waiting"], 0);
        t.sync(B, 2_001).unwrap();
        assert_eq!(seqs(&t.read(B, "lead", ReadQuery::default())), vec![1]);
    }

    #[test]
    fn offline_writes_catch_up_and_commands_never_wait_for_the_server() {
        let Some(t) = two("offline") else { return };
        t.post(A, "lead", "t1", "before", 1_000).unwrap();
        // A server nobody listens on: the round fails as offline, the file keeps working.
        let settings = super::super::config::PgSettings {
            host: "127.0.0.1".into(),
            port: 1,
            database: "x".into(),
            user: "x".into(),
            ..Default::default()
        };
        let dead = super::super::config::pg_target(&settings, None, None).unwrap();
        let err = run(sync::sync_round(lite(&t.a), &test_pg(dead), "test-server", A, TEST_INSTANCE, None, 1_500, &|_| {})).unwrap_err();
        assert!(matches!(err, SyncError::Offline(_)), "{err:?}");
        t.post(A, "lead", "t1", "while offline", 1_600).unwrap();
        t.add(A, "lead", "offline task", 1_601).unwrap();
        assert!(t.status(A)["waiting"].as_i64().unwrap() > 0);
        t.sync(A, 2_000).unwrap();
        t.sync(B, 2_001).unwrap();
        assert_eq!(seqs(&t.read(B, "lead", ReadQuery::default())), vec![1, 2]);
        assert_eq!(states(&t.list(B, "lead", 2_002)), vec![(1, "open".into())]);
    }

    #[test]
    fn a_lost_backlog_becomes_a_full_push() {
        let Some(t) = two_with("backlog", Limits { changes: 5, ..Limits::default() }) else { return };
        t.post(A, "lead", "t1", "first", 1_000).unwrap();
        t.sync(A, 1_500).unwrap();
        for i in 0..8 {
            t.post(A, "lead", "t1", &format!("note {i}"), 2_000 + i).unwrap();
        }
        // More than `changes` rows wait: the log is dropped and a snapshot goes instead.
        let st = run(lite(&t.a).run(|c, l| super::super::sqlite::sync_prepare(c, l, "test-server", A, None, 3_000))).unwrap();
        assert!(st.full_push);
        assert_eq!(st.waiting, 0);
        t.sync(A, 3_001).unwrap();
        assert_eq!(t.status(A)["fullPush"], false);
        t.sync(B, 3_002).unwrap();
        assert_eq!(seqs(&t.read(B, "lead", ReadQuery { limit: Some(50), ..Default::default() })), (1..=9).collect::<Vec<_>>());
    }

    #[test]
    fn an_invalid_server_row_is_skipped_and_counted() {
        let Some(t) = two("invalid") else { return };
        t.post(A, "lead", "t1", "good", 1_000).unwrap();
        t.sync(A, 2_000).unwrap();
        let uid: String = t.teams(A)[0]["uid"].as_str().unwrap().to_string();
        t.pg_exec(&format!(
            "INSERT INTO posts (id, team_uid, seq, ts, kind, text, arrival, updated_at, row_version)
             VALUES ('01900000-0000-7000-8000-00000000abcd', '{uid}', 99, 1, 'shout', 'bad kind', 1, 1, 1)"
        ));
        let r = t.sync(B, 2_001).unwrap();
        assert_eq!(r.skipped, 1);
        assert_eq!(t.status(B)["skipped"], 1);
        assert_eq!(seqs(&t.read(B, "lead", ReadQuery::default())), vec![1], "the bad row was not written");
    }

    #[test]
    fn a_row_committed_late_is_not_skipped_by_the_pull_cursor() {
        let Some(t) = two("late") else { return };
        // Two teams written directly on the server (`postgres` usage type, machine mac-c).
        let direct = test_pg(t.target.clone());
        run(direct.post("slow".into(), input("c1", "note", "slow team"), at("mac-c", 1_000))).unwrap();
        run(direct.post("fast".into(), input("c2", "note", "fast team"), at("mac-c", 1_001))).unwrap();
        t.sync(B, 1_500).unwrap();
        // A direct writer draws a server_seq and has not committed yet …
        let target = t.target.clone();
        let (tx_started, started) = std::sync::mpsc::channel::<()>();
        let slow = std::thread::spawn(move || {
            run(async {
                let mut c = pg_raw(&target).await;
                let mut tx = c.begin().await.unwrap();
                sqlx::query("UPDATE teams SET name = 'late name', row_version = row_version + 1 WHERE team = 'slow'")
                    .execute(&mut *tx)
                    .await
                    .unwrap();
                tx_started.send(()).unwrap();
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                tx.commit().await.unwrap();
            })
        });
        started.recv().unwrap();
        // … while another writer commits a row with a higher number.
        run(direct.post("fast".into(), input("c2", "note", "fast again"), at("mac-c", 2_000))).unwrap();
        run(direct.close());
        // The pull waits for the slow writer (watermark under the lock), so nothing is skipped.
        t.sync(B, 2_500).unwrap();
        slow.join().unwrap();
        let named: Vec<String> = t.teams(B).iter().filter_map(|x| x["teamName"].as_str().map(str::to_string)).collect();
        assert!(named.contains(&"late name".to_string()), "{named:?}");
        assert_eq!(seqs(&t.read(B, "fast", ReadQuery::default())), vec![1, 2]);
        t.sync(B, 3_000).unwrap();
        assert!(t.teams(B).iter().any(|x| x["teamName"] == "late name"));
    }

    #[test]
    fn a_host_name_held_by_another_machine_pauses_sync() {
        let Some(t) = two("collide") else { return };
        t.pg_exec("INSERT INTO hosts (host, instance_id, first_seen, last_seen) VALUES ('mac-b', 'someone-else', 1, 1)");
        t.post(B, "mine", "t1", "x", 1_000).unwrap();
        let err = t.sync(B, 2_000).unwrap_err();
        assert_eq!(err, SyncError::Paused("name_taken", "another computer uses the name mac-b; set this computer's name in Settings".into()));
        assert_eq!(t.pg_count("SELECT count(*) FROM teams"), 0, "nothing was pushed under a borrowed name");
        // A works normally with its own name.
        t.post(A, "lead", "t1", "x", 1_000).unwrap();
        t.sync(A, 2_001).unwrap();
        assert_eq!(t.pg_count("SELECT count(*) FROM hosts WHERE host = 'mac-a'"), 1);
    }

    #[test]
    fn new_cursors_work_on_a_mirror() {
        let Some(t) = two("cursor") else { return };
        let newq = || ReadQuery { cursor_tab: Some("reader".into()), ..Default::default() };
        t.post(A, "lead", "t1", "one", 1_000).unwrap();
        t.post(A, "lead", "t1", "two", 1_001).unwrap();
        t.sync(A, 2_000).unwrap();
        t.sync(B, 2_001).unwrap();
        assert_eq!(seqs(&t.read(B, "lead", newq())), vec![1, 2]);
        assert!(seqs(&t.read(B, "lead", newq())).is_empty());
        t.post(A, "lead", "t1", "three", 3_000).unwrap();
        t.sync(A, 4_000).unwrap();
        t.sync(B, 4_001).unwrap();
        assert_eq!(seqs(&t.read(B, "lead", newq())), vec![3]);
    }

    #[test]
    fn a_pull_never_touches_this_machines_teams() {
        let Some(t) = two("home") else { return };
        t.add(A, "lead", "original title", 1_000).unwrap();
        t.sync(A, 2_000).unwrap();
        // A hostile server rewrites A's task and claims a new team for A.
        t.pg_exec("UPDATE tasks SET title = 'rewritten', row_version = row_version + 100");
        t.pg_exec(
            "INSERT INTO teams (uid, team, name, home_host, created_at, updated_at, row_version)
             VALUES ('01900000-0000-7000-8000-00000000beef', 'planted', 'planted', 'mac-a', 1, 1, 1)",
        );
        t.sync(A, 3_000).unwrap();
        let shown = run(t.a.task_show("lead".into(), 1, false, None, at(A, 3_001))).unwrap();
        assert_eq!(shown["task"]["title"], "original title");
        assert_eq!(t.teams(A).len(), 1, "a team claiming this machine as home is ignored");
        // A's own team keeps working; B sees the server's version (read-only).
        t.write(A, "lead", on("claim", 1), agent("t1", A), 3_002).unwrap();
        t.sync(B, 3_003).unwrap();
        assert_eq!(states(&t.list(B, "lead", 3_004)), vec![(1, "open".into())], "B got the rewritten row first");
    }

    #[test]
    fn removing_other_machines_teams_is_local_only() {
        let Some(t) = two("remove") else { return };
        t.post(A, "lead", "t1", "one", 1_000).unwrap();
        t.sync(A, 2_000).unwrap();
        t.sync(B, 2_001).unwrap();
        assert_eq!(t.teams(B).len(), 1);
        // Leaving sync keeps the copies.
        run(lite(&t.b).run(|c, _| super::super::sqlite::sync_release(c))).unwrap();
        assert_eq!(t.teams(B).len(), 1);
        let removed = run(lite(&t.b).run(|c, _| super::super::sqlite::sync_remove_mirrors(c))).unwrap();
        assert_eq!(removed, 1);
        assert!(t.teams(B).is_empty());
        assert_eq!(t.pg_count("SELECT count(*) FROM teams"), 1, "the server keeps it");
        assert_eq!(t.teams(A).len(), 1, "the home keeps it");
    }

    #[test]
    fn tombstones_made_after_leaving_sync_reach_the_server_later() {
        let Some(t) = two("tombs") else { return };
        t.post(A, "lead", "t1", "x", 900).unwrap();
        t.sync(A, 1_000).unwrap();
        run(lite(&t.a).run(|c, _| super::super::sqlite::sync_release(c))).unwrap();
        run(t.a.clear("lead".into(), at(A, 2_000))).unwrap();
        // 31 days later the app starts with sync off: the unsent tombstone must stay.
        let later = 2_000 + STALE_AFTER_MS + 24 * 3_600_000;
        run(t.a.prune_stale(later, STALE_AFTER_MS)).unwrap();
        t.sync(A, later + 1).unwrap();
        assert_eq!(t.pg_count("SELECT count(*) FROM posts WHERE deleted_at IS NOT NULL"), 1, "the deletion reached the server");
        assert_eq!(t.pg_count("SELECT count(*) FROM posts WHERE deleted_at IS NULL"), 0);
    }

    #[test]
    fn a_row_the_server_refuses_is_counted_and_the_batch_goes_on() {
        let Some(t) = two("refuse") else { return };
        t.post(A, "lead", "t1", "one", 1_000).unwrap();
        t.sync(A, 1_500).unwrap();
        let uid = t.teams(A)[0]["uid"].as_str().unwrap().to_string();
        // Someone wrote seq 2 of A's team on the server under another id.
        t.pg_exec(&format!(
            "INSERT INTO posts (id, team_uid, seq, ts, kind, text, arrival, updated_at, row_version)
             VALUES ('01900000-0000-7000-8000-00000000aaaa', '{uid}', 2, 1, 'note', 'squatter', 1, 1, 1)"
        ));
        t.post(A, "lead", "t1", "two", 2_000).unwrap();
        t.add(A, "lead", "work", 2_001).unwrap();
        let r = t.sync(A, 3_000).unwrap();
        assert_eq!(r.refused, 1);
        let st = t.status(A);
        assert_eq!(st["refused"], 1);
        assert!(st["refusedReason"].as_str().unwrap().contains("duplicate key"), "{st}");
        assert_eq!(st["waiting"], 0, "the batch was not retried forever");
        assert_eq!(t.pg_count("SELECT count(*) FROM tasks"), 1, "the rest of the batch went through");
        assert_eq!(t.pg_count("SELECT last_post_seq FROM teams"), 2);
    }

    #[test]
    fn this_computers_retired_team_on_the_server_makes_room_for_the_new_one() {
        let Some(t) = two("retired") else { return };
        t.pg_exec(
            "INSERT INTO teams (uid, team, name, home_host, created_at, updated_at, row_version, deleted_at)
             VALUES ('01900000-0000-7000-8000-0000000000aa', 'lead', 'old', 'mac-a', 1, 1, 3, 5)",
        );
        t.pg_exec(
            "INSERT INTO posts (id, team_uid, seq, ts, kind, text, arrival, updated_at, row_version, deleted_at)
             VALUES ('01900000-0000-7000-8000-0000000000ab', '01900000-0000-7000-8000-0000000000aa', 1, 1, 'note', 'old', 1, 1, 1, 5)",
        );
        t.post(A, "lead", "t1", "new", 1_000).unwrap();
        let r = t.sync(A, 2_000).unwrap();
        assert_eq!(r.refused, 0);
        assert_eq!(t.pg_count("SELECT count(*) FROM teams WHERE team = 'lead'"), 1);
        assert_eq!(t.pg_count("SELECT count(*) FROM posts"), 1);
        assert_eq!(t.pg_count("SELECT count(*) FROM teams WHERE uid = '01900000-0000-7000-8000-0000000000aa'"), 0);
    }

    #[test]
    fn a_non_owner_role_with_exactly_the_checked_grants_can_sync() {
        let Some(t) = two("grants") else { return };
        let role = format!("bbt_role_{}_{}", std::process::id(), FIXTURE_N.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
        let s = super::super::config::quote_ident(&t.target.schema);
        t.pg_exec(&format!(
            "CREATE ROLE {role} LOGIN PASSWORD 'test';
             GRANT USAGE ON SCHEMA {s} TO {role};
             GRANT SELECT, INSERT, UPDATE, DELETE ON {s}.teams, {s}.posts, {s}.cursors, {s}.tasks, {s}.task_deps, {s}.task_events, {s}.board_meta, {s}.hosts, {s}.outbox TO {role};
             GRANT USAGE ON SEQUENCE {s}.board_server_seq, {s}.board_arrival_seq TO {role};
             GRANT EXECUTE ON FUNCTION {s}.board_set_server_seq() TO {role};"
        ));
        let mut target = t.target.clone();
        target.opts = target.opts.clone().username(&role).password("test");
        let d = run(PgStore::diagnose(&target, TEST_APP_VERSION));
        assert_eq!(d["canReadWrite"], true, "{d}");
        let server = test_pg(target);
        t.post(A, "lead", "t1", "as a plain role", 1_000).unwrap();
        t.sync_with(A, &server, None, 2_000).unwrap();
        t.sync_with(B, &server, None, 2_001).unwrap();
        assert_eq!(seqs(&t.read(B, "lead", ReadQuery::default())), vec![1]);
        run(server.close());
        t.pg_exec(&format!("DROP OWNED BY {role}; DROP ROLE {role};"));
    }

    #[test]
    fn direct_writers_cannot_write_a_synced_team_and_newer_server_rows_count_as_refused() {
        let Some(t) = two("direct") else { return };
        t.add(A, "lead", "work", 1_000).unwrap();
        t.sync(A, 2_000).unwrap();
        let direct = test_pg(t.target.clone());
        let refusal = "this team lives on mac-a; it is read-only here";
        assert_eq!(run(direct.task_write("lead".into(), on("claim", 1), agent("c1", "mac-c"), at("mac-c", 2_100))).unwrap_err(), refusal);
        assert_eq!(run(direct.clear("lead".into(), at("mac-c", 2_100))).unwrap_err(), refusal);
        run(direct.close());
        // A row changed on the server behind the home's back: the home's next version is refused, counted.
        t.pg_exec("UPDATE tasks SET row_version = row_version + 100");
        t.write(A, "lead", on("claim", 1), agent("t1", A), 3_000).unwrap();
        let r = t.sync(A, 4_000).unwrap();
        assert!(r.refused >= 1);
        assert!(t.status(A)["refusedReason"].as_str().unwrap().contains("newer version"));
    }

    #[test]
    fn a_pull_reports_busy_while_writers_hold_the_lock() {
        let Some(t) = two("busy") else { return };
        t.post(A, "lead", "t1", "x", 1_000).unwrap();
        t.sync(A, 1_500).unwrap();
        let target = t.target.clone();
        let (tx_started, started) = std::sync::mpsc::channel::<()>();
        let (tx_release, release) = std::sync::mpsc::channel::<()>();
        let slow = std::thread::spawn(move || {
            run(async {
                let mut c = pg_raw(&target).await;
                let mut tx = c.begin().await.unwrap();
                sqlx::query("UPDATE teams SET name = 'held', row_version = row_version + 1").execute(&mut *tx).await.unwrap();
                tx_started.send(()).unwrap();
                // Hold the lock until the pull has answered (not for a fixed time: a slow
                // machine could otherwise let the pull's wait outlast the writer), 30 s at most.
                for _ in 0..600 {
                    if release.try_recv().is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                tx.rollback().await.unwrap();
            })
        });
        started.recv().unwrap();
        let pulled = t.sync(B, 2_000);
        tx_release.send(()).unwrap();
        slow.join().unwrap();
        assert_eq!(pulled.unwrap_err(), SyncError::Busy);
        t.sync(B, 3_000).unwrap();
        assert_eq!(seqs(&t.read(B, "lead", ReadQuery::default())), vec![1]);
    }

    #[test]
    fn a_board_file_copied_to_another_computer_cannot_sync_under_the_old_identity() {
        let Some(t) = two("copied") else { return };
        let server = t.server();
        t.post(A, "lead", "t1", "x", 1_000).unwrap();
        t.sync_with(A, &server, Some("machine-1"), 2_000).unwrap();
        let err = t.sync_with(A, &server, Some("machine-2"), 3_000).unwrap_err();
        assert_eq!(err.code(), "name_taken");
        run(server.close());
    }

    // ── Stage 3c: restore, take over a team, remote notes ────────────────

    const C: &str = "mac-c";
    const HOUR: i64 = 3_600_000;

    impl Two {
        fn extra(&self, name: &str) -> BoardStore {
            BoardStore::Sqlite(test_sqlite(self.dir.join(format!("{name}.db"))))
        }
        fn sync_store(&self, store: &BoardStore, host: &str, now: i64) -> Result<sync::RoundReport, SyncError> {
            let server = self.server();
            let r = run(sync::sync_round(lite(store), &server, "test-server", host, TEST_INSTANCE, None, now, &|_| {}));
            run(server.close());
            r
        }
        fn outbox(&self, which: &str, team: &str) -> Vec<Value> {
            let t = team.to_string();
            run(lite(if which == A { &self.a } else { &self.b }).run(move |c, _| super::super::sqlite::outbox_list(c, &t))).unwrap()
        }
        fn post_remote(&self, which: &str, team: &str, author: &str, text: &str, now: i64) -> Result<Value, String> {
            let store = lite(if which == A { &self.a } else { &self.b });
            let (team, inp, ctx) = (team.to_string(), input(author, "note", text), at(which, now));
            run(store.run(move |c, l| super::super::sqlite::post_or_queue(c, l, &team, &inp, &ctx)))
        }
    }

    fn code(e: &str) -> String {
        serde_json::from_str::<Value>(e).map(|v| v["code"].as_str().unwrap_or_default().to_string()).unwrap_or_else(|_| e.to_string())
    }

    #[test]
    fn two_computers_adopting_at_once_exactly_one_wins_and_only_after_the_age_guard() {
        let Some(t) = two("adopt2") else { return };
        t.post(A, "lead", "t1", "hello", 1_000).unwrap();
        t.add(A, "lead", "work", 1_001).unwrap();
        t.sync(A, 2_000).unwrap();
        t.sync(B, 2_001).unwrap();
        let c = t.extra("c");
        t.sync_store(&c, C, 2_002).unwrap();
        let server = t.server();
        // A was seen moments ago: too early for anyone.
        let pre = run(sync::adopt_preview(lite(&t.b), &server, "lead", B, 3_000, 24 * HOUR)).unwrap();
        assert_eq!(pre["home"], A);
        assert_eq!(pre["allowed"], false);
        let (uid, version) = (pre["uid"].as_str().unwrap().to_string(), pre["version"].as_i64().unwrap());
        let early = run(sync::adopt_team(lite(&t.b), &server, B, TEST_INSTANCE, "lead", &uid, A, version, 3_000, 24 * HOUR)).unwrap_err();
        assert_eq!(code(&early), "home_alive");
        // A clock far ahead on this computer changes nothing: ages are by the server's clock.
        let skewed = run(sync::adopt_preview(lite(&t.b), &server, "lead", B, i64::MAX / 4, 24 * HOUR)).unwrap();
        assert_eq!(skewed["allowed"], false);
        // A day later B and C both confirm the same preview at once: exactly one wins.
        t.pg_exec(&format!("UPDATE {}.hosts SET last_seen = 0 WHERE host = 'mac-a'", t.target.schema));
        let later = 2_000 + 25 * HOUR;
        let (rb, rc) = run(async {
            let s1 = test_pg(t.target.clone());
            let s2 = test_pg(t.target.clone());
            let out = tokio::join!(
                sync::adopt_team(lite(&t.b), &s1, B, TEST_INSTANCE, "lead", &uid, A, version, later, 24 * HOUR),
                sync::adopt_team(lite(&c), &s2, C, TEST_INSTANCE, "lead", &uid, A, version, later, 24 * HOUR)
            );
            s1.close().await;
            s2.close().await;
            out
        });
        assert_eq!(rb.is_ok() as u8 + rc.is_ok() as u8, 1, "{rb:?} {rc:?}");
        let (winner, loser) = if rb.is_ok() { (B, rc.unwrap_err()) } else { (C, rb.unwrap_err()) };
        assert_eq!(code(&loser), "changed");
        let home = run(server.team_homes(std::slice::from_ref(&uid))).unwrap();
        assert_eq!(home[0].1.as_deref(), Some(winner));
        assert_eq!(home[0].2, version + 1);
        run(server.close());
        // The winner writes to it now; the loser's copy follows on its next round.
        if winner == B {
            t.add(B, "lead", "next", later + 1).unwrap();
            t.sync(B, later + 2).unwrap();
            t.sync_store(&c, C, later + 3).unwrap();
            let teams = run(c.teams()).unwrap();
            assert_eq!(teams[0]["homeHost"], B);
            assert_eq!(run(c.task_list("lead".into(), TaskListQuery { all: true, ..Default::default() }, at(C, later + 4))).unwrap()["tasks"].as_array().unwrap().len(), 2);
        } else {
            assert!(t.teams(B)[0]["mirror"].as_bool().unwrap());
        }
    }

    #[test]
    fn an_old_home_that_returns_after_a_takeover_becomes_a_read_only_copy() {
        let Some(t) = two("oldhome") else { return };
        t.post(A, "lead", "t1", "before", 1_000).unwrap();
        t.add(A, "lead", "claimed by a", 1_001).unwrap();
        t.write(A, "lead", on("claim", 1), agent("t1", A), 1_002).unwrap();
        t.sync(A, 2_000).unwrap();
        t.sync(B, 2_001).unwrap();
        // A goes away with an unsent change.
        t.post(A, "lead", "t1", "written while away", 3_000).unwrap();
        let later = 2_000 + 25 * HOUR;
        t.pg_exec(&format!("UPDATE {}.hosts SET last_seen = 0 WHERE host = 'mac-a'", t.target.schema));
        let server = t.server();
        let pre = run(sync::adopt_preview(lite(&t.b), &server, "lead", B, later, 24 * HOUR)).unwrap();
        assert_eq!(pre["allowed"], true);
        let out = run(sync::adopt_team(
            lite(&t.b),
            &server,
            B,
            TEST_INSTANCE,
            "lead",
            pre["uid"].as_str().unwrap(),
            A,
            pre["version"].as_i64().unwrap(),
            later,
            24 * HOUR,
        ))
        .unwrap();
        run(server.close());
        assert_eq!(out["team"], "lead");
        let tb = t.teams(B);
        assert!(tb[0].get("mirror").is_none(), "home here now: {tb:?}");
        // A's agent is gone: its claim ran out through the normal lease expiry.
        assert_eq!(states(&t.list(B, "lead", later + 1)), vec![(1, "open".into())]);
        t.post(B, "lead", "t5", "new home speaking", later + 2).unwrap();
        t.sync(B, later + 3).unwrap();
        // A comes back: nothing of its unsent change reaches the server, it is reported, and
        // the team is a read-only copy of B's.
        let r = t.sync(A, later + 10).unwrap();
        assert_eq!(r.moved, vec!["lead".to_string()]);
        assert!(r.refused >= 1, "{r:?}");
        let st = t.status(A);
        assert!(st["refusedReason"].as_str().unwrap().contains("taken over by mac-b"), "{st}");
        // The unsent change is kept in a file, not lost.
        assert!(st["keptRows"].as_i64().unwrap() >= 1, "{st}");
        let kept = std::fs::read_to_string(st["keptFile"].as_str().unwrap()).unwrap();
        assert!(kept.contains("written while away"), "{kept}");
        assert_eq!(t.teams(A)[0]["homeHost"], B);
        assert_eq!(t.teams(A)[0]["mirror"], true);
        assert_eq!(t.post(A, "lead", "t1", "again", later + 11).unwrap_err(), "this team lives on mac-b; it is read-only here");
        let texts: Vec<String> = t.read(A, "lead", ReadQuery::default())["posts"].as_array().unwrap().iter().map(|p| p["text"].as_str().unwrap().to_string()).collect();
        assert!(texts.contains(&"new home speaking".to_string()), "{texts:?}");
        assert!(!texts.contains(&"written while away".to_string()), "{texts:?}");
        assert_eq!(t.pg_count(&format!("SELECT count(*) FROM {}.posts WHERE text = 'written while away'", t.target.schema)), 0);
        // Later rounds are quiet.
        let r = t.sync(A, later + 20).unwrap();
        assert!(r.moved.is_empty());
    }

    #[test]
    fn a_remote_note_is_delivered_exactly_once_across_crashes_and_refusals_come_back() {
        let Some(t) = two("rnote") else { return };
        t.post(A, "lead", "t1", "hello", 1_000).unwrap();
        t.sync(A, 2_000).unwrap();
        t.sync(B, 2_001).unwrap();
        let queued = t.post_remote(B, "lead", "b1", "from b", 2_002).unwrap();
        assert_eq!(queued["pending"], true);
        assert_eq!(t.outbox(B, "lead")[0]["state"], "pending");
        // Crash after the server stored it but before B noted it: the resend changes nothing.
        let server = t.server();
        let notes = run(lite(&t.b).run(|c, _| super::super::sqlite::outbox_to_send(c, B, 10))).unwrap();
        let b_inst = t.status(B)["instanceId"].as_str().unwrap().to_string();
        run(server.outbox_send(&b_inst, &notes, 20, 100)).unwrap();
        t.sync(B, 2_003).unwrap();
        assert_eq!(t.outbox(B, "lead")[0]["state"], "sent");
        assert_eq!(t.pg_count(&format!("SELECT count(*) FROM {}.outbox", t.target.schema)), 1);
        // Crash at the home after the post was written but before the server heard back.
        let pending = run(server.inbox_pending(A, 10)).unwrap();
        assert_eq!(pending.len(), 1);
        let ctx = at(A, 2_004);
        run(lite(&t.a).run(move |c, l| super::super::sqlite::inbox_apply(c, l, &pending, &ctx))).unwrap();
        let r = t.sync(A, 2_005).unwrap();
        assert_eq!(r.delivered, 1, "reported delivered again, not posted twice");
        run(server.close());
        let id = queued["id"].as_str().unwrap();
        assert_eq!(t.pg_count(&format!("SELECT count(*) FROM {}.posts WHERE id = '{id}'", t.target.schema)), 1);
        assert_eq!(t.pg_count(&format!("SELECT count(*) FROM {}.posts WHERE text = 'from b'", t.target.schema)), 1);
        let on_a = t.read(A, "lead", ReadQuery::default());
        let post = on_a["posts"].as_array().unwrap().iter().find(|p| p["text"] == "from b").cloned().unwrap();
        assert_eq!(post["seq"], 2);
        assert_eq!(post["author"]["host"], B);
        // B receives the real post by pull; the waiting entry is gone.
        t.sync(B, 2_006).unwrap();
        assert!(t.outbox(B, "lead").is_empty());
        assert_eq!(seqs(&t.read(B, "lead", ReadQuery::default())), vec![1, 2]);
        // A note the home refuses comes back refused, with its code.
        t.post_remote(B, "lead", "b1", "will be spoiled", 2_007).unwrap();
        t.sync(B, 2_008).unwrap();
        t.pg_exec(&format!("UPDATE {}.outbox SET text = 'bell' || chr(7) WHERE state = 'pending'", t.target.schema));
        t.sync(A, 2_009).unwrap();
        t.sync(B, 2_010).unwrap();
        let ob = t.outbox(B, "lead");
        assert_eq!((ob[0]["state"].as_str(), ob[0]["reason"].as_str()), (Some("refused"), Some("invalid")));
        // A note that is never taken expires after a week instead of waiting forever.
        t.post_remote(B, "lead", "b1", "nobody home", 2_011).unwrap();
        t.pg_exec(&format!("UPDATE {}.teams SET home_host = 'mac-gone'", t.target.schema));
        t.sync(B, 2_012).unwrap();
        t.sync(B, 2_013 + super::super::sync_core::REMOTE_NOTE_EXPIRE_MS).unwrap();
        let ob = t.outbox(B, "lead");
        assert!(ob.iter().any(|n| n["text"] == "nobody home" && n["state"] == "refused" && n["reason"] == "expired"), "{ob:?}");
    }


    #[test]
    fn a_delivered_note_does_not_linger_after_a_takeover_and_the_cap_counts_only_queued_notes() {
        let Some(t) = two("linger") else { return };
        t.post(A, "lead", "t1", "hello", 1_000).unwrap();
        t.sync(A, 2_000).unwrap();
        t.sync(B, 2_001).unwrap();
        t.post_remote(B, "lead", "b1", "from b", 2_002).unwrap();
        t.sync(B, 2_003).unwrap();
        t.sync(A, 2_004).unwrap();
        // B learns "delivered" but has not pulled the post yet when it takes the team over.
        let server = t.server();
        let ids: Vec<String> = t.outbox(B, "lead").iter().map(|n| n["id"].as_str().unwrap().to_string()).collect();
        let states = run(server.outbox_states(&ids)).unwrap();
        run(lite(&t.b).run(move |c, _| super::super::sqlite::outbox_apply_states(c, &states, &[]))).unwrap();
        assert_eq!(t.outbox(B, "lead")[0]["state"], "delivered");
        t.pg_exec(&format!("UPDATE {}.hosts SET last_seen = 0 WHERE host = 'mac-a'", t.target.schema));
        let pre = run(sync::adopt_preview(lite(&t.b), &server, "lead", B, 3_000, 24 * HOUR)).unwrap();
        run(sync::adopt_team(lite(&t.b), &server, B, TEST_INSTANCE, "lead", pre["uid"].as_str().unwrap(), A, pre["version"].as_i64().unwrap(), 3_000, 24 * HOUR)).unwrap();
        run(server.close());
        assert!(t.outbox(B, "lead").is_empty(), "{:?}", t.outbox(B, "lead"));
        let texts: Vec<String> = t.read(B, "lead", ReadQuery::default())["posts"].as_array().unwrap().iter().map(|p| p["text"].as_str().unwrap().to_string()).collect();
        assert!(texts.contains(&"from b".to_string()));
        // B still posts (now as the home) and sync goes on.
        t.post(B, "lead", "b1", "as the home", 3_001).unwrap();
        t.sync(B, 3_002).unwrap();
    }

    #[test]
    fn a_note_for_a_team_a_half_finished_restore_has_not_copied_waits() {
        let Some(t) = two("halfrestore") else { return };
        t.post(A, "lead", "t1", "hello", 1_000).unwrap();
        t.sync(A, 2_000).unwrap();
        t.sync(B, 2_001).unwrap();
        t.post_remote(B, "lead", "b1", "while a is gone", 2_002).unwrap();
        t.sync(B, 2_003).unwrap();
        // A new installation of mac-a took the name over but has not copied the rows yet.
        let fresh = t.extra("a2");
        let mine = run(lite(&fresh).run(|c, _| super::super::sqlite::sync_instance(c))).unwrap();
        let old = t.status(A)["instanceId"].as_str().unwrap().to_string();
        t.pg_exec(&format!("UPDATE {}.hosts SET last_seen = 0 WHERE host = 'mac-a'", t.target.schema));
        let server = t.server();
        assert!(run(server.take_over_host(A, &old, &mine, super::super::sync_core::RESTORE_TAKEOVER_MS, true)).unwrap());
        t.sync_store(&fresh, A, 2_100).unwrap();
        assert_eq!(t.pg_count(&format!("SELECT count(*) FROM {}.outbox WHERE state = 'pending'", t.target.schema)), 1, "no verdict yet");
        run(sync::restore_teams(lite(&fresh), &server, A, false, 2_200)).unwrap();
        run(server.close());
        let r = t.sync_store(&fresh, A, 2_300).unwrap();
        assert_eq!(r.delivered, 1);
        t.sync(B, 2_400).unwrap();
        assert!(t.outbox(B, "lead").is_empty());
    }

    #[test]
    fn the_home_refuses_a_spoofed_sender_and_stops_a_flood_at_the_limit() {
        let Some(t) = two_with("flood", Limits { posts: 35, ..Limits::default() }) else { return };
        t.post(A, "lead", "t1", "the first post", 1_000).unwrap();
        t.sync(A, 2_000).unwrap();
        t.sync(B, 2_001).unwrap();
        let uid = t.teams(B)[0]["uid"].as_str().map(str::to_string).unwrap_or_else(|| {
            run(lite(&t.b).run(|c, _| super::super::sqlite::mirror_of(c, "lead"))).unwrap().unwrap().0
        });
        let b_inst = t.status(B)["instanceId"].as_str().unwrap().to_string();
        let s = &t.target.schema;
        // Someone with the credentials writes a note in B's name but not as B's installation.
        t.pg_exec(&format!(
            "INSERT INTO {s}.outbox (id, team_uid, from_host, from_instance, author_id, kind, text, created_at)
             VALUES ('01900000-0000-7000-8000-000000000a00', '{uid}', 'mac-b', 'not-b', 'x', 'note', 'spoofed', 1)"
        ));
        for i in 0..40 {
            t.pg_exec(&format!(
                "INSERT INTO {s}.outbox (id, team_uid, from_host, from_instance, author_id, kind, text, created_at)
                 VALUES ('01900000-0000-7000-8000-000000000b{i:02}', '{uid}', 'mac-b', '{b_inst}', 'b1', 'note', 'flood {i}', {})",
                10 + i
            ));
        }
        let r = t.sync(A, 3_000).unwrap();
        assert_eq!(r.delivered as i64, super::super::sync_core::REMOTE_NOTES_PER_SENDER_WINDOW);
        assert_eq!(t.pg_count(&format!("SELECT count(*) FROM {s}.outbox WHERE reason = 'unknown_sender'")), 1);
        assert_eq!(t.pg_count(&format!("SELECT count(*) FROM {s}.outbox WHERE reason = 'rate_limited'")), 40 - super::super::sync_core::REMOTE_NOTES_PER_SENDER_WINDOW);
        let texts: Vec<String> = t.read(A, "lead", ReadQuery { limit: Some(100), ..Default::default() })["posts"].as_array().unwrap().iter().map(|p| p["text"].as_str().unwrap().to_string()).collect();
        assert!(texts.contains(&"the first post".to_string()), "older posts stay");
        assert!(!texts.iter().any(|x| x == "spoofed"));
    }

    #[test]
    fn clean_up_removes_finished_outbox_rows_after_thirty_days() {
        let Some(t) = two("obclean") else { return };
        let s = &t.target.schema;
        t.pg_exec(&format!(
            "INSERT INTO {s}.outbox (id, team_uid, from_host, from_instance, author_id, kind, text, created_at, state, handled_at) VALUES
             ('01900000-0000-7000-8000-000000000c01', 'u', 'h', 'i', 'a', 'note', 'old', 1, 'delivered', 1),
             ('01900000-0000-7000-8000-000000000c02', 'u', 'h', 'i', 'a', 'note', 'waiting', 1, 'pending', NULL)"
        ));
        let server = t.server();
        run(server.prune_stale(now_ms(), STALE_AFTER_MS)).unwrap();
        run(server.close());
        assert_eq!(t.pg_count(&format!("SELECT count(*) FROM {s}.outbox")), 1, "only the pending one stays");
    }


    #[test]
    fn a_takeover_between_the_old_homes_check_and_its_push_lets_nothing_through() {
        let Some(t) = two("lateadopt") else { return };
        t.post(A, "lead", "t1", "one", 1_000).unwrap();
        t.post(A, "lead", "t1", "two", 1_001).unwrap();
        t.sync(A, 2_000).unwrap();
        t.sync(B, 2_001).unwrap();
        // A writes a note and tombstones the board's posts while B takes the team over.
        t.post(A, "lead", "t1", "after the check", 3_000).unwrap();
        let notes = run(lite(&t.a).run(|c, _| super::super::sqlite::sync_push_batch(c, A, 500))).unwrap().unwrap().1;
        run(t.a.clear("lead".into(), at(A, 3_001))).unwrap();
        let all = run(lite(&t.a).run(|c, _| super::super::sqlite::sync_push_batch(c, A, 500))).unwrap().unwrap().1;
        t.pg_exec(&format!("UPDATE {}.hosts SET last_seen = 0 WHERE host = 'mac-a'", t.target.schema));
        let server = t.server();
        let pre = run(sync::adopt_preview(lite(&t.b), &server, "lead", B, 4_000, 24 * HOUR)).unwrap();
        run(sync::adopt_team(lite(&t.b), &server, B, TEST_INSTANCE, "lead", pre["uid"].as_str().unwrap(), A, pre["version"].as_i64().unwrap(), 4_000, 24 * HOUR)).unwrap();
        let a_inst = t.status(A)["instanceId"].as_str().unwrap().to_string();
        let posts_before = t.pg_count(&format!("SELECT count(*) FROM {}.posts", t.target.schema));
        // Only child rows (the new note), then only tombstones: both refused, nothing written.
        let mut only_children = notes.clone();
        only_children.teams.clear();
        assert!(!only_children.posts.is_empty());
        let o = run(server.sync_push(A, &a_inst, &only_children, 4_001)).unwrap();
        assert_eq!((o.written, o.refused as usize), (0, only_children.posts.len()));
        let mut only_tombstones = super::super::copy::Dump::default();
        let del = super::super::copy::col_index(super::super::sync_core::POSTS_SYNC, "deleted_at");
        only_tombstones.posts = all.posts.iter().filter(|r| !matches!(r[del], super::super::copy::Cell::Null)).cloned().collect();
        assert!(!only_tombstones.posts.is_empty());
        let o = run(server.sync_push(A, &a_inst, &only_tombstones, 4_002)).unwrap();
        assert_eq!(o.written, 0);
        assert!(o.moved.iter().any(|(_, h)| h == B));
        run(server.close());
        let s = &t.target.schema;
        assert_eq!(t.pg_count(&format!("SELECT count(*) FROM {s}.posts")), posts_before);
        assert_eq!(t.pg_count(&format!("SELECT count(*) FROM {s}.posts WHERE deleted_at IS NOT NULL OR text = 'after the check'")), 0);
    }

    /// A schema built only up to version 3 (what a 3b app created).
    fn two_v3(tag: &str) -> Option<Two> {
        if !pg_enabled() {
            return None;
        }
        let n = FIXTURE_N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("bbarit-sync-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let target = pg_test_target(&test_schema(&format!("sync{tag}"), n));
        let steps = super::super::pg::migration_steps(&target.schema, None).unwrap();
        run(async {
            let mut c = pg_raw(&target).await;
            for step in steps.iter().filter(|s| s.version <= 3) {
                for sql in &step.sql {
                    sqlx::raw_sql(sql).execute(&mut c).await.unwrap();
                }
            }
            let q = super::super::config::quote_ident(&target.schema);
            sqlx::raw_sql(&format!("INSERT INTO {q}.board_meta (key, value) VALUES ('schema_version', '3')")).execute(&mut c).await.unwrap();
        });
        let a = BoardStore::Sqlite(test_sqlite(dir.join("a.db")));
        let b = BoardStore::Sqlite(test_sqlite(dir.join("b.db")));
        Some(Two { dir, target, a, b })
    }

    #[test]
    fn against_version_three_tables_notes_wait_and_go_after_the_upgrade_which_runs_once() {
        let Some(t) = two_v3("v3") else { return };
        t.post(A, "lead", "t1", "hello", 1_000).unwrap();
        let r = t.sync(A, 2_000).unwrap();
        assert_eq!(r.server_schema, 3, "3b sync keeps working");
        t.sync(B, 2_001).unwrap();
        t.post_remote(B, "lead", "b1", "queued on v3", 2_002).unwrap();
        t.sync(B, 2_003).unwrap();
        assert_eq!(t.outbox(B, "lead")[0]["state"], "pending");
        assert_eq!(t.status(B)["outboxWaiting"], 1);
        let server = t.server();
        let e = run(sync::adopt_preview(lite(&t.b), &server, "lead", B, 2_004, HOUR)).unwrap_err();
        assert_eq!(code(&e), "upgrade_tables");
        // Create / upgrade tables: 3 → 4, then again: nothing to do, nothing changed.
        let up = run(server.migrate(true)).unwrap();
        assert_eq!(up["applied"], true);
        run(server.close());
        t.sync(B, 2_005).unwrap();
        assert_eq!(t.outbox(B, "lead")[0]["state"], "sent");
        let before = t.pg_count(&format!("SELECT count(*) FROM {}.outbox", t.target.schema));
        let again = run(test_pg(t.target.clone()).migrate(true)).unwrap();
        assert_eq!(again["upToDate"], true);
        // The version-4 statements themselves are safe to run twice.
        let v4 = super::super::pg::migration_steps(&t.target.schema, Some(3)).unwrap();
        t.pg_exec(&v4[0].sql.join(";\n"));
        assert_eq!(t.pg_count(&format!("SELECT count(*) FROM {}.outbox", t.target.schema)), before);
        assert_eq!(t.sync(A, 2_006).unwrap().delivered, 1);
        t.sync(B, 2_007).unwrap();
        assert!(t.outbox(B, "lead").is_empty());
    }

    #[test]
    fn the_privilege_check_names_the_outbox_when_it_is_not_granted() {
        let Some(t) = two("nooutbox") else { return };
        let role = format!("bbt_role_{}_{}", std::process::id(), FIXTURE_N.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
        let s = super::super::config::quote_ident(&t.target.schema);
        t.pg_exec(&format!(
            "CREATE ROLE {role} LOGIN PASSWORD 'test';
             GRANT USAGE ON SCHEMA {s} TO {role};
             GRANT SELECT, INSERT, UPDATE, DELETE ON {s}.teams, {s}.posts, {s}.cursors, {s}.tasks, {s}.task_deps, {s}.task_events, {s}.board_meta, {s}.hosts TO {role};
             GRANT USAGE ON SEQUENCE {s}.board_server_seq, {s}.board_arrival_seq TO {role};
             GRANT EXECUTE ON FUNCTION {s}.board_set_server_seq() TO {role};"
        ));
        let mut target = t.target.clone();
        target.opts = target.opts.clone().username(&role).password("test");
        let d = run(PgStore::diagnose(&target, TEST_APP_VERSION));
        assert_eq!(d["canReadWrite"], false, "{d}");
        assert!(d["next"].as_str().unwrap().contains("hosts and outbox included"), "{d}");
        t.pg_exec(&format!("REVOKE ALL ON ALL TABLES IN SCHEMA {s} FROM {role}; REVOKE ALL ON ALL SEQUENCES IN SCHEMA {s} FROM {role}; REVOKE ALL ON SCHEMA {s} FROM {role}; REVOKE ALL ON FUNCTION {s}.board_set_server_seq() FROM {role}; DROP ROLE {role};"));
    }

    #[test]
    fn a_restore_that_stopped_after_taking_the_name_completes_on_retry() {
        let Some(t) = two("restoreretry") else { return };
        t.post(A, "lead", "t1", "one", 1_000).unwrap();
        t.add(A, "lead", "task", 1_001).unwrap();
        t.sync(A, 2_000).unwrap();
        let fresh = t.extra("a2");
        let mine = run(lite(&fresh).run(|c, _| super::super::sqlite::sync_instance(c))).unwrap();
        let old = t.status(A)["instanceId"].as_str().unwrap().to_string();
        t.pg_exec(&format!("UPDATE {}.hosts SET last_seen = 0 WHERE host = 'mac-a'", t.target.schema));
        let server = t.server();
        // First attempt: the name moved, then the app stopped before any row came down.
        assert!(run(server.take_over_host(A, &old, &mine, super::super::sync_core::RESTORE_TAKEOVER_MS, true)).unwrap());
        assert!(run(fresh.teams()).unwrap().is_empty());
        // Retry: no takeover is needed any more; the rows come down.
        let pre = run(sync::restore_preview(lite(&fresh), &server, A, 3_000)).unwrap();
        assert!(pre["takeover"].is_null(), "{pre}");
        let out = run(sync::restore_teams(lite(&fresh), &server, A, true, 3_001)).unwrap();
        run(server.close());
        assert_eq!((out["teams"].as_i64(), out["tasks"].as_i64(), out["notes"].as_i64()), (Some(1), Some(1), Some(1)));
        t.sync_store(&fresh, A, 3_002).unwrap();
        assert_eq!(t.sync(A, 3_003).unwrap_err().code(), "replaced");
    }


    /// A second server (another schema) that the same "test-server" label points at, as when a
    /// server is rebuilt at the same address.
    struct Other(PgTarget);
    impl Drop for Other {
        fn drop(&mut self) {
            remove_test_schema(&self.0);
        }
    }
    fn other_server(tag: &str) -> Other {
        let n = FIXTURE_N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let target = pg_test_target(&test_schema(&format!("new{tag}"), n));
        run(test_pg(target.clone()).migrate(true)).expect("create the second schema");
        Other(target)
    }
    fn sync_to(store: &BoardStore, target: &PgTarget, host: &str, now: i64) -> Result<sync::RoundReport, SyncError> {
        let server = test_pg(target.clone());
        let r = run(sync::sync_round(lite(store), &server, "test-server", host, TEST_INSTANCE, None, now, &|_| {}));
        run(server.close());
        r
    }

    #[test]
    fn a_new_empty_server_at_the_same_address_gets_this_computers_teams_and_its_rows_are_pulled() {
        let Some(t) = two("rebuilt") else { return };
        for i in 0..10 {
            t.post(A, "lead", "t1", &format!("a{i}"), 1_000 + i).unwrap();
        }
        t.post(B, "bteam", "b1", "b first", 1_100).unwrap();
        t.sync(A, 2_000).unwrap();
        t.sync(B, 2_001).unwrap();
        // The old server had drawn many numbers: A's pull position ends far above anything the
        // new server will hand out.
        t.pg_exec(&format!("SELECT setval('{}.board_server_seq', 1000)", t.target.schema));
        t.sync(A, 2_002).unwrap();
        let unchanged = t.sync(A, 2_003).unwrap();
        assert_eq!(unchanged.server_event, None, "the same server: no reset");
        assert_eq!(unchanged.pushed, 0);
        let pulled_before = run(lite(&t.a).run(|c, _| super::super::sqlite::sync_state_now(c))).unwrap().pulled_seq;
        assert!(pulled_before >= 1000);
        // The server is rebuilt empty at the same address.
        let new = other_server("rebuilt");
        let r = sync_to(&t.a, &new.0, A, 3_000).unwrap();
        assert_eq!(r.server_event, Some("server_replaced"));
        assert!(r.pushed > 0, "{r:?}");
        let q = super::super::config::quote_ident(&new.0.schema);
        let count = |sql: &str| run(async {
            let mut c = pg_raw(&new.0).await;
            sqlx::query_scalar::<_, i64>(sql).fetch_one(&mut c).await.unwrap()
        });
        assert_eq!(count(&format!("SELECT count(*) FROM {q}.teams WHERE team = 'lead'")), 1);
        assert_eq!(t.status(A)["serverEvent"], "server_replaced");
        // B's new team lands there with low numbers; A still pulls it.
        t.post(B, "bnew", "b1", "after the rebuild", 3_100).unwrap();
        sync_to(&t.b, &new.0, B, 3_101).unwrap();
        assert!(count(&format!("SELECT max(p.server_seq) FROM {q}.posts p JOIN {q}.teams t ON t.uid = p.team_uid WHERE t.team = 'bnew'")) < pulled_before);
        let r = sync_to(&t.a, &new.0, A, 3_102).unwrap();
        assert_eq!(r.server_event, None, "reported once");
        assert!(t.teams(A).iter().any(|x| x["team"] == "bnew"), "{:?}", t.teams(A));
        // The copy of B's old team that the new server also has stays.
        assert!(t.teams(A).iter().any(|x| x["team"] == "bteam"));
    }

    #[test]
    fn a_server_restored_from_a_backup_resets_the_pull_and_sends_again() {
        let Some(t) = two("backup") else { return };
        for i in 0..5 {
            t.post(A, "lead", "t1", &format!("a{i}"), 1_000 + i).unwrap();
        }
        t.sync(A, 2_000).unwrap();
        t.sync(B, 2_001).unwrap();
        t.sync(A, 2_002).unwrap();
        // Restored from an older backup: same uid, the sequence went back, A's rows are gone.
        let s = &t.target.schema;
        t.pg_exec(&format!("UPDATE {s}.posts SET deleted_at = 1 WHERE false; DELETE FROM {s}.posts; SELECT setval('{s}.board_server_seq', 1)"));
        let r = t.sync(A, 3_000).unwrap();
        assert_eq!(r.server_event, Some("server_restored"));
        assert!(r.pushed > 0);
        assert_eq!(t.pg_count(&format!("SELECT count(*) FROM {s}.posts")), 5);
        t.post(B, "bnew", "b1", "after the restore", 3_100).unwrap();
        t.sync(B, 3_101).unwrap();
        t.sync(A, 3_102).unwrap();
        assert!(t.teams(A).iter().any(|x| x["team"] == "bnew"));
        assert_eq!(t.sync(A, 3_103).unwrap().server_event, None);
    }

    #[test]
    fn a_team_deleted_here_and_absent_on_the_new_server_neither_errors_nor_loops() {
        let Some(t) = two("tombnew") else { return };
        t.post(A, "gone", "t1", "x", 1_000).unwrap();
        t.post(A, "lead", "t1", "y", 1_000 + 40 * 86_400_000).unwrap();
        t.sync(A, 2_000).unwrap();
        // "gone" is retired here (30 days idle) and the tombstone is not on any server yet.
        run(t.a.prune_stale(1_000 + 31 * 86_400_000, STALE_AFTER_MS)).unwrap();
        let new = other_server("tombnew");
        let r = sync_to(&t.a, &new.0, A, 3_000).unwrap();
        assert_eq!(r.server_event, Some("server_replaced"));
        let again = sync_to(&t.a, &new.0, A, 3_001).unwrap();
        assert_eq!((again.pushed, again.server_event), (0, None));
        assert_eq!(t.status(A)["fullPush"], false);
        assert_eq!(t.status(A)["waiting"], 0);
    }

    #[test]
    fn restore_takes_over_a_silent_name_only_and_keeps_newer_local_rows() {
        let Some(t) = two("restore") else { return };
        t.post(A, "lead", "t1", "one", 1_000).unwrap();
        t.add(A, "lead", "task one", 1_001).unwrap();
        t.add(A, "lead", "task two", 1_002).unwrap();
        t.write(A, "lead", on("claim", 1), agent("t1", A), 1_003).unwrap();
        t.sync(A, 2_000).unwrap();
        // A new installation with the same name: sync pauses, restore offers a takeover.
        let fresh = t.extra("a2");
        assert_eq!(t.sync_store(&fresh, A, 2_100).unwrap_err().code(), "name_taken");
        let server = t.server();
        let pre = run(sync::restore_preview(lite(&fresh), &server, A, 2_200)).unwrap();
        assert_eq!((pre["teams"].as_i64(), pre["tasks"].as_i64(), pre["notes"].as_i64()), (Some(1), Some(2), Some(1)));
        assert_eq!(pre["takeover"]["allowed"], false);
        assert_eq!(code(&run(sync::restore_teams(lite(&fresh), &server, A, false, 2_200)).unwrap_err()), "takeover_needed");
        // A computer seen minutes ago is never impersonated.
        assert_eq!(code(&run(sync::restore_teams(lite(&fresh), &server, A, true, 2_200)).unwrap_err()), "host_alive");
        let later = 2_000 + super::super::sync_core::RESTORE_TAKEOVER_MS;
        t.pg_exec(&format!("UPDATE {}.hosts SET last_seen = last_seen - 16 * 60000 WHERE host = 'mac-a'", t.target.schema));
        let out = run(sync::restore_teams(lite(&fresh), &server, A, true, later)).unwrap();
        assert_eq!((out["teams"].as_i64(), out["tasks"].as_i64(), out["notes"].as_i64()), (Some(1), Some(2), Some(1)));
        assert!(run(fresh.teams()).unwrap()[0].get("mirror").is_none(), "home again");
        assert_eq!(states(&t.list(A, "lead", 1_004)), states(&run(fresh.task_list("lead".into(), TaskListQuery { all: true, ..Default::default() }, at(A, 1_004))).unwrap()));
        // It syncs as that name now; the old installation is the one paused.
        t.sync_store(&fresh, A, later + 1).unwrap();
        // The replaced installation is told what happened (not "name taken").
        assert_eq!(t.sync(A, later + 2).unwrap_err().code(), "replaced");
        // A claim of the old installation's agent runs out through the normal lease expiry.
        let list = run(fresh.task_list("lead".into(), TaskListQuery { all: true, ..Default::default() }, at(A, later + 10 * HOUR))).unwrap();
        assert_eq!(states(&list), vec![(1, "open".into()), (2, "open".into())]);
        run(server.close());

        // Restore on a file that has the team: a newer local row is kept, unsent changes refuse.
        let Some(u) = two("restore2") else { return };
        u.add(A, "lead", "server title", 1_000).unwrap();
        u.sync(A, 2_000).unwrap();
        let path = u.dir.join("a.db");
        let raw = rusqlite::Connection::open(&path).unwrap();
        raw.execute("UPDATE tasks SET title = 'newer here', row_version = row_version + 5", []).unwrap();
        let server = u.server();
        let out = run(sync::restore_teams(lite(&u.a), &server, A, false, 3_000)).unwrap();
        assert!(out["keptNewer"].as_i64().unwrap() >= 1, "{out}");
        let list = u.list(A, "lead", 3_001);
        assert_eq!(list["tasks"][0]["title"], "newer here");
        u.add(A, "lead", "unsent", 3_002).unwrap();
        let e = run(sync::restore_teams(lite(&u.a), &server, A, false, 3_003)).unwrap_err();
        assert_eq!(code(&e), "unsent");
        run(server.close());
    }

}

// ── Sync rules without a server (stage 3b) ───────────────────────────────
//
// Dumps exported from one SQLite file ("mac-a") and fed to another ("mac-b") through
// `sync_apply_pull`, the way a pull would; always runs (no PostgreSQL needed).
mod sync_local {
    use super::super::copy::{self, Cell, Dump};
    use super::super::sqlite;
    use super::super::sync_core as sync;
    use super::*;

    const A: &str = "mac-a";
    const B: &str = "mac-b";

    struct Files {
        dir: PathBuf,
        a: BoardStore,
        b: BoardStore,
    }

    impl Drop for Files {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn files(tag: &str) -> Files {
        let n = FIXTURE_N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("bbarit-synclocal-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Files { a: BoardStore::Sqlite(test_sqlite(dir.join("a.db"))), b: BoardStore::Sqlite(test_sqlite(dir.join("b.db"))), dir }
    }

    fn lite(s: &BoardStore) -> &SqliteStore {
        match s {
            BoardStore::Sqlite(l) => l,
            BoardStore::Pg(_) => unreachable!(),
        }
    }

    fn at(host: &str, now: i64) -> Ctx {
        Ctx { now, host: Some(host.into()), instance: format!("inst-{host}") }
    }

    fn agent(id: &str, host: &str) -> Actor {
        Actor { id: id.into(), name: Some(id.into()), cli: Some("claude".into()), host: Some(host.into()), root: false, human: false }
    }

    /// Everything `host` owns in `store`, as a full push would send it.
    fn export(store: &BoardStore, host: &str) -> Dump {
        let mut all = Dump::default();
        loop {
            let h = host.to_string();
            let (next, d) = run(lite(store).run(move |c, _| sqlite::sync_full_batch(c, &h, 500))).unwrap();
            for (t, _) in sync::SYNC_TABLES {
                all.rows_mut(t).extend(d.rows(t).iter().cloned());
            }
            let n = next.clone();
            run(lite(store).run(move |c, _| sqlite::sync_full_done(c, n.as_deref()))).unwrap();
            if next.is_none() {
                return all;
            }
        }
    }

    fn apply(store: &BoardStore, host: &str, d: Dump, cursor: i64, now: i64) -> sync::PullApplied {
        let h = host.to_string();
        run(lite(store).run(move |c, l| sqlite::sync_apply_pull(c, l, &h, &d, cursor, now))).unwrap()
    }

    fn set(row: &mut [Cell], cols: copy::Cols, name: &str, v: Cell) {
        row[copy::col_index(cols, name)] = v;
    }

    fn text(s: &str) -> Cell {
        Cell::Text(s.into())
    }

    /// mac-a: team "lead" with a note and task #1 claimed (lease until 2 000 000).
    fn seed(f: &Files) -> Dump {
        run(f.a.post("lead".into(), input("t1", "note", "hello"), at(A, 1_000))).unwrap();
        run(f.a.task_write("lead".into(), TaskOpInput { title: Some("work".into()), ..op("add") }, agent("t1", A), at(A, 1_001))).unwrap();
        run(f.a.task_write("lead".into(), on("claim", 1), agent("t1", A), at(A, 1_002))).unwrap();
        export(&f.a, A)
    }

    #[test]
    fn a_pulled_team_is_read_only_and_leases_and_cleanup_leave_it_alone() {
        let f = files("ro");
        let d = seed(&f);
        let r = apply(&f.b, B, d, 10, 5_000);
        assert_eq!(r.skipped, 0);
        assert_eq!(r.teams, vec!["lead".to_string()]);
        let refusal = "this team lives on mac-a; it is read-only here";
        assert_eq!(run(f.b.post("lead".into(), input("t9", "note", "x"), at(B, 6_000))).unwrap_err(), refusal);
        assert_eq!(run(f.b.task_write("lead".into(), on("cancel", 1), human(), at(B, 6_000))).unwrap_err(), refusal);
        assert_eq!(run(f.b.task_write("lead".into(), on("claim", 1), agent("t9", B), at(B, 6_000))).unwrap_err(), refusal);
        assert_eq!(run(f.b.clear("lead".into(), at(B, 6_000))).unwrap_err(), refusal);
        // Far past the lease: B still shows the claim (only the home expires leases).
        let far = 1_000_000_000;
        let list = run(f.b.task_list("lead".into(), TaskListQuery { all: true, ..Default::default() }, at(B, far))).unwrap();
        assert_eq!(list["tasks"][0]["state"], "claimed");
        assert_eq!(list["expired"].as_array().unwrap().len(), 0);
        // Nor is it released by an app start on B, or retired by B's 30-day cleanup.
        let id = list["tasks"][0]["id"].as_str().unwrap().to_string();
        let item = LeaseItem { id, instance: format!("inst-{A}") };
        let res = run(f.b.lease_apply(format!("inst-{B}"), vec![], vec![item], far, 300_000, Some(B.into()))).unwrap();
        assert_eq!(res["released"].as_array().unwrap().len(), 0);
        assert_eq!(run(f.b.prune_stale(far, STALE_AFTER_MS)).unwrap(), 0);
        assert_eq!(run(f.b.teams()).unwrap().len(), 1);
    }

    #[test]
    fn hostile_and_oversized_rows_are_skipped_and_counted_and_home_rows_never_change() {
        let f = files("hostile");
        let d = seed(&f);
        run(f.b.post("mine".into(), input("t1", "note", "my own"), at(B, 1_000))).unwrap();
        let mine = run(f.b.teams()).unwrap()[0]["uid"].as_str().unwrap().to_string();
        let mut bad = Dump::default();
        // A team row naming this computer as home: ignored, not counted.
        let mut claim = d.teams[0].clone();
        set(&mut claim, copy::TEAMS, "uid", text("01900000-0000-7000-8000-0000000000c1"));
        set(&mut claim, copy::TEAMS, "home_host", text(B));
        bad.teams.push(claim);
        // A rewrite of B's own team: ignored.
        let mut own = d.teams[0].clone();
        set(&mut own, copy::TEAMS, "uid", text(&mine));
        set(&mut own, copy::TEAMS, "row_version", Cell::Int(999));
        bad.teams.push(own);
        bad.teams.push(d.teams[0].clone());
        let ok_post = d.posts[0].clone();
        bad.posts.push(ok_post);
        // Oversized and malformed rows: skipped and counted.
        let mut long = d.posts[0].clone();
        set(&mut long, sync::POSTS_SYNC, "id", text("01900000-0000-7000-8000-0000000000c2"));
        set(&mut long, sync::POSTS_SYNC, "seq", Cell::Int(2));
        set(&mut long, sync::POSTS_SYNC, "text", text(&"x".repeat(MAX_TEXT_CHARS + 1)));
        bad.posts.push(long);
        let mut zw = d.tasks[0].clone();
        set(&mut zw, copy::TASKS, "title", text("ti\u{200B}tle"));
        bad.tasks.push(zw);
        let mut labels = d.tasks[0].clone();
        set(&mut labels, copy::TASKS, "id", text("01900000-0000-7000-8000-0000000000c3"));
        set(&mut labels, copy::TASKS, "labels", text(&serde_json::to_string(&(0..11).map(|i| format!("l{i}")).collect::<Vec<_>>()).unwrap()));
        bad.tasks.push(labels);
        let mut meta = d.tasks[0].clone();
        set(&mut meta, copy::TASKS, "id", text("01900000-0000-7000-8000-0000000000c4"));
        set(&mut meta, copy::TASKS, "meta", text(&format!("{{\"k\":\"{}\"}}", "y".repeat(sync::MAX_META_BYTES))));
        bad.tasks.push(meta);
        // A post whose id already belongs to B's own team: never moved.
        let my_post: String = run(f.b.read("mine".into(), ReadQuery::default(), Some(B.into()))).unwrap()["posts"][0]["id"].as_str().unwrap().to_string();
        let mut steal = d.posts[0].clone();
        set(&mut steal, sync::POSTS_SYNC, "id", text(&my_post));
        set(&mut steal, sync::POSTS_SYNC, "seq", Cell::Int(3));
        bad.posts.push(steal);
        let r = apply(&f.b, B, bad, 10, 5_000);
        assert_eq!(r.skipped, 5, "long text, format character, 11 labels, big meta, stolen id");
        let teams = run(f.b.teams()).unwrap();
        assert_eq!(teams.len(), 2, "no team claiming mac-b appeared: {teams:?}");
        let mine_now = run(f.b.read("mine".into(), ReadQuery::default(), Some(B.into()))).unwrap();
        assert_eq!(mine_now["posts"][0]["text"], "my own");
        assert_eq!(mine_now["lastSeq"], 1, "B's own team row was not rewritten");
        let st = run(lite(&f.b).run(|c, _| sqlite::sync_status_local(c))).unwrap();
        assert_eq!(st["skipped"], 5);
    }

    #[test]
    fn the_mirror_cap_drops_whole_teams_and_never_brings_them_back_in_part() {
        let f = files("cap");
        let d = seed(&f);
        let mut many = Dump::default();
        let uids: Vec<String> = (0..=sync::MAX_MIRROR_TEAMS).map(|i| format!("01900000-0000-7000-8000-{:012x}", 0x100 + i)).collect();
        for (i, uid) in uids.iter().enumerate() {
            let mut row = d.teams[0].clone();
            set(&mut row, copy::TEAMS, "uid", text(uid));
            set(&mut row, copy::TEAMS, "team", text(&format!("team{i}")));
            set(&mut row, copy::TEAMS, "last_activity_at", Cell::Int(10 + i as i64));
            many.teams.push(row);
        }
        let r = apply(&f.b, B, many, 10, 5_000);
        assert_eq!(r.dropped, 1);
        assert_eq!(run(f.b.teams()).unwrap().len() as i64, sync::MAX_MIRROR_TEAMS);
        // Later rows of the dropped (least active) team are ignored, not half-restored.
        let mut later = Dump::default();
        let mut row = d.teams[0].clone();
        set(&mut row, copy::TEAMS, "uid", text(&uids[0]));
        set(&mut row, copy::TEAMS, "team", text("team0"));
        set(&mut row, copy::TEAMS, "row_version", Cell::Int(50));
        later.teams.push(row);
        let mut post = d.posts[0].clone();
        set(&mut post, sync::POSTS_SYNC, "team_uid", text(&uids[0]));
        later.posts.push(post);
        let r = apply(&f.b, B, later, 20, 6_000);
        assert_eq!((r.written, r.skipped), (0, 0));
        assert!(run(f.b.teams()).unwrap().iter().all(|t| t["team"] != "team0"));
    }

    fn prepare(store: &BoardStore, host: &str, machine: Option<&str>, now: i64) -> sync::LocalState {
        let (h, m) = (host.to_string(), machine.map(str::to_string));
        run(lite(store).run(move |c, l| sqlite::sync_prepare(c, l, "srv", &h, m.as_deref(), now))).unwrap()
    }

    #[test]
    fn teams_of_another_name_become_read_only_and_a_copied_file_gets_a_new_identity() {
        let f = files("ident");
        run(f.a.post("old".into(), input("t1", "note", "x"), at("host-x", 1_000))).unwrap();
        run(f.a.post("lead".into(), input("t1", "note", "x"), at(A, 1_001))).unwrap();
        let first = prepare(&f.a, A, Some("machine-1"), 2_000);
        assert!(first.pause.is_none());
        assert_eq!(
            run(f.a.post("old".into(), input("t1", "note", "y"), at(A, 2_100))).unwrap_err(),
            "this team lives on host-x; it is read-only here"
        );
        assert_eq!(prepare(&f.a, A, Some("machine-1"), 3_000).instance, first.instance);
        assert_ne!(prepare(&f.a, A, Some("machine-2"), 4_000).instance, first.instance, "another computer: new identity");
        assert_ne!(prepare(&f.a, A, None, 5_000).instance, "", "an unreadable machine id keeps the identity");
    }

    #[test]
    fn a_name_change_with_live_teams_pauses_sync() {
        let f = files("rename");
        run(f.a.post("lead".into(), input("t1", "note", "x"), at(A, 1_000))).unwrap();
        assert!(prepare(&f.a, A, None, 2_000).pause.is_none());
        let st = prepare(&f.a, "mac-renamed", None, 3_000);
        let (code, msg) = st.pause.unwrap();
        assert_eq!(code, "name_changed");
        assert!(msg.contains("changed from mac-a to mac-renamed"), "{msg}");
        // Without live teams or unsent changes the new name is taken.
        let g = files("rename2");
        assert!(prepare(&g.a, A, None, 2_000).pause.is_none());
        assert!(prepare(&g.a, "mac-renamed", None, 3_000).pause.is_none());
    }

    #[test]
    fn removing_other_computers_teams_starts_the_pull_over_and_unsent_tombstones_stay() {
        let f = files("remove");
        let d = seed(&f);
        prepare(&f.b, B, None, 1_000);
        apply(&f.b, B, d, 42, 5_000);
        let removed = run(lite(&f.b).run(|c, _| sqlite::sync_remove_mirrors(c))).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(prepare(&f.b, B, None, 6_000).pulled_seq, 0, "the next pull brings whole teams back");
        // A tombstone made after the last time everything was sent is kept by the cleanup.
        prepare(&f.a, A, None, 900);
        run(lite(&f.a).run(|c, _| sqlite::sync_mark_caught_up(c, 1_500))).unwrap_or(());
        run(f.a.clear("lead".into(), at(A, 2_000))).unwrap();
        let later = 2_000 + STALE_AFTER_MS + 24 * 3_600_000;
        run(f.a.prune_stale(later, STALE_AFTER_MS)).unwrap();
        let n: i64 = rusqlite::Connection::open(f.dir.join("a.db"))
            .unwrap()
            .query_row("SELECT count(*) FROM posts WHERE deleted_at IS NOT NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }
}

// ── Stage 3c without a server: remote-note queue and delivery rules ──────

mod stage3c_local {
    use super::super::pg::OutboxNote;
    use super::super::sqlite;
    use super::*;

    fn file(tag: &str) -> (PathBuf, SqliteStore) {
        let n = FIXTURE_N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("bbarit-3c-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("board.db");
        (dir, test_sqlite(path))
    }

    fn at(host: &str, now: i64) -> Ctx {
        Ctx { now, host: Some(host.into()), instance: format!("inst-{host}") }
    }

    fn queue(s: &SqliteStore, inp: PostInput, now: i64) -> Result<Value, String> {
        let ctx = at("mac-b", now);
        run(s.run(move |c, l| sqlite::post_or_queue(c, l, "lead", &inp, &ctx)))
    }

    #[test]
    fn a_note_for_a_copy_is_queued_with_the_local_rules_and_caps() {
        let (dir, s) = file("queue");
        // A team homed on mac-a that this file holds as a copy.
        run(BoardStore::Sqlite(test_sqlite(s_path(&dir))).post("lead".into(), input("t1", "note", "hi"), at("mac-a", 1))).unwrap();
        let raw = rusqlite::Connection::open(s_path(&dir)).unwrap();
        raw.execute("INSERT INTO mirror_teams(team_uid, home_host, synced_at) SELECT uid, home_host, 1 FROM teams", []).unwrap();
        let q = queue(&s, input("b1", "note", "  from b \u{200B}"), 10).unwrap();
        assert_eq!((q["pending"].as_bool(), q["home"].as_str(), q["text"].as_str()), (Some(true), Some("mac-a"), Some("from b")));
        assert!(queue(&s, input("b1", "announce", "x"), 11).is_err());
        assert_eq!(queue(&s, PostInput { root: true, ..input("b1", "announce", "x") }, 11).unwrap_err(), "only notes can be sent to a team that lives on mac-a");
        assert!(queue(&s, PostInput { task: Some(1), ..input("b1", "note", "x") }, 11).unwrap_err().contains("cannot link a task"));
        assert!(queue(&s, input("b1", "note", ""), 11).is_err(), "empty text is refused like a local post");
        for i in 1..super::super::sync_core::REMOTE_NOTES_PER_TEAM {
            queue(&s, input("b1", "note", &format!("n{i}")), 20 + i).unwrap();
        }
        let full = queue(&s, input("b1", "note", "one too many"), 100).unwrap_err();
        assert!(full.contains("waiting to be delivered to mac-a"), "{full}");
        let list = run(s.run(|c, _| sqlite::outbox_list(c, "lead"))).unwrap();
        assert_eq!(list.len() as i64, super::super::sync_core::REMOTE_NOTES_PER_TEAM);
        assert!(list.iter().all(|n| n["state"] == "pending"));
        // Nothing was written to the copy itself.
        let posts: i64 = raw.query_row("SELECT count(*) FROM posts", [], |r| r.get(0)).unwrap();
        assert_eq!(posts, 1);
        // A refused note can be dismissed; a waiting one cannot.
        let id = list[0]["id"].as_str().unwrap().to_string();
        let i2 = id.clone();
        assert_eq!(run(s.run(move |c, _| sqlite::outbox_dismiss(c, &i2))).unwrap(), 0);
        let i3 = id.clone();
        run(s.run(move |c, _| sqlite::outbox_mark_refused(c, &i3, "team_gone"))).unwrap();
        assert_eq!(run(s.run(move |c, _| sqlite::outbox_dismiss(c, &id))).unwrap(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn s_path(dir: &Path) -> PathBuf {
        dir.join("board.db")
    }

    fn note(id: &str, team_uid: &str, text: &str) -> OutboxNote {
        OutboxNote {
            id: id.into(),
            team_uid: team_uid.into(),
            from_host: "mac-b".into(),
            author_id: "b1".into(),
            author_name: Some("b1 name".into()),
            author_cli: Some("claude".into()),
            kind: "note".into(),
            text: text.into(),
            created_at: 5,
            team_deleted: false,
            sender_known: true,
        }
    }

    #[test]
    fn the_home_numbers_a_remote_note_once_and_refuses_bad_or_orphaned_ones() {
        let (dir, s) = file("inbox");
        run(BoardStore::Sqlite(test_sqlite(s_path(&dir))).post("lead".into(), input("t1", "note", "hi"), at("mac-a", 1))).unwrap();
        let raw = rusqlite::Connection::open(s_path(&dir)).unwrap();
        let uid: String = raw.query_row("SELECT uid FROM teams", [], |r| r.get(0)).unwrap();
        let ok = "01900000-0000-7000-8000-00000000000a";
        let notes = vec![
            note(ok, &uid, "from b"),
            note("01900000-0000-7000-8000-00000000000b", &uid, "bell\u{7}"),
            note("01900000-0000-7000-8000-00000000000c", "01900000-0000-7000-8000-0000000000ff", "orphan"),
            OutboxNote { kind: "announce".into(), ..note("01900000-0000-7000-8000-00000000000d", &uid, "loud") },
        ];
        let apply = |n: Vec<OutboxNote>| {
            let ctx = at("mac-a", 10);
            run(s.run(move |c, l| sqlite::inbox_apply(c, l, &n, &ctx))).unwrap()
        };
        let (first, teams) = apply(notes.clone());
        assert_eq!(teams, vec!["lead".to_string()]);
        let verdicts: Vec<(&str, Option<&str>)> = first.iter().map(|r| (r.1, r.2)).collect();
        // A team that is not here gives no verdict (a half-finished restore); the note waits.
        assert_eq!(verdicts, vec![("delivered", None), ("refused", Some("invalid")), ("refused", Some("invalid"))]);
        let spoofed = OutboxNote { sender_known: false, ..note("01900000-0000-7000-8000-00000000000e", &uid, "who am i") };
        let gone = OutboxNote { team_deleted: true, ..note("01900000-0000-7000-8000-00000000000f", &uid, "late") };
        let (v, _) = apply(vec![spoofed, gone]);
        assert_eq!(v.iter().map(|r| r.2).collect::<Vec<_>>(), vec![Some("unknown_sender"), Some("team_gone")]);
        // Again (the server did not hear back): reported delivered, never posted twice.
        let (again, _) = apply(notes[..1].to_vec());
        assert_eq!(again[0].1, "delivered");
        let n: i64 = raw.query_row("SELECT count(*) FROM posts WHERE id = ?1", [ok], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let (seq, host, origin): (i64, String, String) =
            raw.query_row("SELECT seq, author_host, origin_host FROM posts WHERE id = ?1", [ok], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((seq, host.as_str(), origin.as_str()), (2, "mac-b", "mac-a"));
        // Logged for the push like any local post.
        let logged: i64 = raw.query_row("SELECT count(*) FROM changes WHERE tbl = 'posts' AND row_id = ?1", [ok], |r| r.get(0)).unwrap();
        assert_eq!(logged, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_different_or_restored_server_resets_this_files_side_once() {
        let (dir, s) = file("identity");
        let check = |uid: &'static str, last: i64| run(s.run(move |c, _| sqlite::sync_check_server(c, uid, last, 7)));
        let raw = rusqlite::Connection::open(s_path(&dir)).unwrap();
        // A fresh file learns the uid without a reset.
        assert_eq!(check("srv-one", 0).unwrap(), None);
        raw.execute_batch("INSERT INTO sync_state(key, value) VALUES ('pulled_seq', '63'), ('pushed_seq', '136')").unwrap();
        assert_eq!(check("srv-one", 100).unwrap(), None, "unchanged server");
        // Notes on their way: sent and delivered-without-post go again; delivered-with-post goes.
        run(BoardStore::Sqlite(test_sqlite(s_path(&dir))).post("lead".into(), input("t1", "note", "hi"), at("mac-a", 1))).unwrap();
        let (uid, post): (String, String) = raw.query_row("SELECT team_uid, id FROM posts", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        for (id, st) in [("o-sent", "sent"), ("o-deliv", "delivered"), (post.as_str(), "delivered"), ("o-ref", "refused")] {
            raw.execute(
                "INSERT INTO outbox(id, team_uid, team, home_host, author_id, kind, text, created_at, state) VALUES (?1, ?2, 'lead', 'mac-a', 'b', 'note', 't', 1, ?3)",
                rusqlite::params![id, uid, st],
            )
            .unwrap();
        }
        assert_eq!(check("srv-two", 100).unwrap(), Some("server_replaced"));
        let get = |k: &str| raw.query_row("SELECT value FROM sync_state WHERE key = ?1", [k], |r| r.get::<_, String>(0)).ok();
        assert_eq!((get("pulled_seq").as_deref(), get("full_push").as_deref(), get("server_event").as_deref()), (Some("0"), Some("1"), Some("server_replaced")));
        let states: Vec<(String, String)> = {
            let mut st = raw.prepare("SELECT id, state FROM outbox ORDER BY id").unwrap();
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(states, vec![("o-deliv".into(), "pending".into()), ("o-ref".into(), "refused".into()), ("o-sent".into(), "pending".into())]);
        // Same server, sequence below the pull position: restored from a backup.
        raw.execute("UPDATE sync_state SET value = '50' WHERE key = 'pulled_seq'", []).unwrap();
        raw.execute("DELETE FROM sync_state WHERE key = 'full_push'", []).unwrap();
        assert_eq!(check("srv-two", 10).unwrap(), Some("server_restored"));
        assert_eq!(get("pulled_seq").as_deref(), Some("0"));
        assert_eq!(check("srv-two", 10).unwrap(), None, "once");
        // A file that synced before servers had a uid, with cursors: treated as another server.
        raw.execute("DELETE FROM sync_state WHERE key = 'server_uid'", []).unwrap();
        raw.execute("UPDATE sync_state SET value = '9' WHERE key = 'pulled_seq'", []).unwrap();
        assert_eq!(check("srv-two", 100).unwrap(), Some("server_replaced"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
