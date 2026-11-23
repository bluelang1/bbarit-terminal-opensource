//! Board server mode against an in-process mock server (axum on loopback): request shapes,
//! error mapping, the lease book, refusals, device login, the token file and what never leaks.

use super::super::server_login::{self, poll, poll_value, save_session, load_session, remove_session, sign_out, start, status_value, Poll};
use super::*;
use axum::body::Body;
use axum::extract::State;
use axum::http::Request;
use axum::response::Response;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

const TOKEN: &str = "test_token_value_not_a_real_secret";
const ROOT: Caller<'static> = Caller { tab: "root-tab", root: true, human: false };

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    query: String,
    auth: Option<String>,
    body: Value,
}

type Reply = (u16, Value, Vec<(&'static str, String)>);

#[derive(Clone, Default)]
struct Mock {
    seen: Arc<Mutex<Vec<Seen>>>,
    replies: Arc<Mutex<VecDeque<Reply>>>,
    /// Requests that wait this long before answering (the first `slow` ones).
    delay_ms: Arc<AtomicU64>,
    slow: Arc<AtomicU64>,
    raw: Arc<Mutex<Option<Vec<u8>>>>,
}

impl Mock {
    fn reply(&self, status: u16, body: Value) {
        self.replies.lock().unwrap().push_back((status, body, Vec::new()));
    }
    fn reply_h(&self, status: u16, body: Value, headers: Vec<(&'static str, String)>) {
        self.replies.lock().unwrap().push_back((status, body, headers));
    }
    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
    fn last(&self) -> Seen {
        self.seen().last().cloned().expect("a request")
    }
}

async fn handle(State(m): State<Mock>, req: Request<Body>) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap_or_default();
    m.seen.lock().unwrap().push(Seen {
        method: parts.method.to_string(),
        path: parts.uri.path().to_string(),
        query: parts.uri.query().unwrap_or("").to_string(),
        auth: parts.headers.get("authorization").and_then(|v| v.to_str().ok()).map(str::to_string),
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    });
    if m.slow.load(Ordering::SeqCst) > 0 {
        m.slow.fetch_sub(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(m.delay_ms.load(Ordering::SeqCst))).await;
    }
    if let Some(raw) = m.raw.lock().unwrap().take() {
        return Response::builder().status(200).header("content-type", "application/json").body(Body::from(raw)).unwrap();
    }
    let (status, body, headers) = m.replies.lock().unwrap().pop_front().unwrap_or((200, json!({}), Vec::new()));
    let mut b = Response::builder().status(status).header("content-type", "application/json");
    for (k, v) in headers {
        b = b.header(k, v);
    }
    b.body(Body::from(body.to_string())).unwrap()
}

async fn serve(m: Mock) -> String {
    let app = axum::Router::new().fallback(handle).with_state(m);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("bbarit-remote-{tag}-{}-{:08x}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn session(server: &str) -> Session {
    Session {
        server: server.to_string(),
        token: Token::new(TOKEN),
        token_prefix: Some("pfx12345".into()),
        account_uid: "00000000-0000-7000-8000-000000000001".into(),
        nickname: "alice".into(),
        runner_uid: "00000000-0000-7000-8000-000000000002".into(),
        runner_name: "laptop".into(),
    }
}

async fn client(tag: &str) -> (Mock, Remote, PathBuf) {
    let m = Mock::default();
    let server = serve(m.clone()).await;
    let dir = temp_dir(tag);
    let r = Remote::new(session(&server), LeaseBook::new(dir.join("leases.json"))).unwrap();
    (m, r, dir)
}

fn no_actor_fields(body: &Value) {
    for k in ["authorId", "authorName", "authorCli", "root", "human", "actor", "host", "instance", "ownerId"] {
        assert!(body.get(k).is_none(), "{k} must not be sent: {body}");
    }
}

fn op(v: Value) -> TaskOpInput {
    serde_json::from_value(v).unwrap()
}

#[tokio::test]
async fn every_operation_sends_its_route_with_the_bearer_token_and_no_actor() {
    let (m, r, dir) = client("shapes").await;
    let bearer = Some(format!("Bearer {TOKEN}"));

    m.reply(201, json!({ "seq": 1 }));
    let post: PostInput = serde_json::from_value(json!({ "authorId": "tab-1", "authorName": "lead", "kind": "note", "text": "hi", "task": 2, "teamName": "T", "root": true })).unwrap();
    r.post("team-1", &post).await.unwrap();
    let s = m.last();
    assert_eq!((s.method.as_str(), s.path.as_str(), s.auth.clone()), ("POST", "/v1/teams/team-1/posts", bearer.clone()));
    assert_eq!(s.body, json!({ "kind": "note", "text": "hi", "task": 2, "teamName": "T" }));

    m.reply(200, json!({ "posts": [] }));
    let q: ReadQuery = serde_json::from_value(json!({ "since": 3, "limit": 20, "kind": "note", "author": "bob", "search": "x y", "excludeAuthor": "me" })).unwrap();
    r.read("team-1", &q).await.unwrap();
    let s = m.last();
    assert_eq!((s.method.as_str(), s.path.as_str()), ("GET", "/v1/teams/team-1/posts"));
    assert_eq!(s.query, "since=3&limit=20&kind=note&author=bob&search=x+y&excludeAuthor=me");
    assert_eq!(s.auth, bearer);

    m.reply(200, json!([{ "team": "team-1" }]));
    assert_eq!(r.teams().await.unwrap().len(), 1);
    assert_eq!(m.last().path, "/v1/teams");

    m.reply(201, json!({ "task": { "seq": 4, "state": "open" } }));
    let add = op(json!({ "op": "add", "title": "Build", "labels": ["impl"], "after": [1], "teamName": "T" }));
    r.task_write("team-1", &add, &json!({ "type": "implement", "decider": "any_lead" }), "tab-1").await.unwrap();
    let s = m.last();
    assert_eq!((s.method.as_str(), s.path.as_str()), ("POST", "/v1/teams/team-1/tasks"));
    assert_eq!(s.body, json!({ "teamName": "T", "title": "Build", "after": [1], "labels": ["impl"], "type": "implement", "decider": "any_lead" }));
    no_actor_fields(&s.body);

    m.reply(200, json!({ "task": { "seq": 4, "state": "claimed" }, "leaseEpoch": 3, "attemptId": 9 }));
    r.task_write("team-1", &op(json!({ "op": "claim", "task": 4, "leaseMs": 60000 })), &json!({}), "tab-1").await.unwrap();
    let s = m.last();
    assert_eq!(s.path, "/v1/teams/team-1/tasks/4/claim");
    assert_eq!(s.body, json!({ "leaseMs": 60000 }), "no leaseEpoch on a claim");

    m.reply(200, json!({ "task": { "seq": 4, "state": "done" } }));
    let done = op(json!({ "op": "done", "task": 4, "result": { "summary": "ok", "branch": "feat/x" } }));
    r.task_write("team-1", &done, &json!({}), "tab-1").await.unwrap();
    let s = m.last();
    assert_eq!(s.path, "/v1/teams/team-1/tasks/4/done");
    assert_eq!(s.body, json!({ "result": { "summary": "ok", "branch": "feat/x" }, "leaseEpoch": 3 }));
    assert!(r.book.get(&r.session.server, "team-1", 4).is_none(), "a finished task leaves the book");

    m.reply(200, json!({ "task": { "seq": 5, "state": "claimed" }, "leaseEpoch": 1, "attemptId": 10 }));
    let next = op(json!({ "op": "claim", "next": true, "labels": ["impl"], "title": "ignored" }));
    r.task_write("team-1", &next, &json!({ "type": "test" }), "tab-2").await.unwrap();
    let s = m.last();
    assert_eq!(s.path, "/v1/teams/team-1/tasks/claim-next");
    assert_eq!(s.body, json!({ "labels": ["impl"], "type": "test" }));
    let e = r.book.get(&r.session.server, "team-1", 5).unwrap();
    assert_eq!((e.lease_epoch, e.attempt_id, e.tab.as_str()), (1, Some(10), "tab-2"));

    for (name, path) in [("dep_add", "dep-add"), ("dep_remove", "dep-remove"), ("approve", "approve"), ("reject", "reject")] {
        m.reply(200, json!({ "task": { "seq": 7, "state": "open" } }));
        r.task_write_as("team-1", &op(json!({ "op": name, "task": 7, "on": 2, "reason": "r" })), &json!({}), ROOT).await.unwrap();
        let s = m.last();
        assert_eq!(s.path, format!("/v1/teams/team-1/tasks/7/{path}"));
        assert!(s.body.get("leaseEpoch").is_none() && s.body.get("expectedVersion").is_none(), "{name}: {}", s.body);
        no_actor_fields(&s.body);
    }

    m.reply(200, json!({ "task": { "seq": 7, "state": "open" } }));
    r.task_write("team-1", &op(json!({ "op": "edit", "task": 7, "title": "New", "expectedVersion": 4 })), &json!({ "type": "review" }), "tab-1").await.unwrap();
    assert_eq!(m.last().body, json!({ "title": "New", "expectedVersion": 4, "type": "review" }));

    m.reply(200, json!({ "tasks": [] }));
    let lq: TaskListQuery = serde_json::from_value(json!({ "states": ["open", "ready"], "all": true, "mine": "tab-1", "ready": true, "search": "a", "limit": 50, "staleMs": 60000 })).unwrap();
    r.task_list("team-1", &lq).await.unwrap();
    let s = m.last();
    assert_eq!((s.method.as_str(), s.path.as_str()), ("GET", "/v1/teams/team-1/tasks"));
    assert_eq!(s.query, "state=open%2Cready&all=true&mine=true&ready=true&search=a&limit=50&staleMs=60000", "mine is the account, never a tab id");

    m.reply(200, json!({ "task": {} }));
    r.task_show("team-1", 7, true, Some(120000)).await.unwrap();
    let s = m.last();
    assert_eq!((s.path.as_str(), s.query.as_str()), ("/v1/teams/team-1/tasks/7", "history=true&staleMs=120000"));

    m.reply(200, json!({ "events": [] }));
    r.team_events("team-1", &EventsQuery { limit: Some(500), since: Some(9) }).await.unwrap();
    let s = m.last();
    assert_eq!((s.path.as_str(), s.query.as_str()), ("/v1/teams/team-1/events", "limit=500&since=9"));

    m.reply(200, json!({ "attempt": { "id": 10 } }));
    r.attempt_report("team-1", 5, "tab-2", &json!({ "model": "m", "tokens": { "input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0 } })).await.unwrap();
    let s = m.last();
    assert_eq!(s.path, "/v1/teams/team-1/tasks/5/attempt");
    assert_eq!(s.body["leaseEpoch"], json!(1));

    assert!(m.seen().iter().all(|s| s.auth == bearer), "every request carries the token");
    assert!(r.task_write("../x", &add, &json!({}), "t").await.unwrap_err().starts_with("invalid team id"));
    let _ = std::fs::remove_dir_all(dir);
}

async fn show_err(r: &Remote) -> String {
    r.task_show("team-1", 1, false, None).await.unwrap_err()
}

#[tokio::test]
async fn server_errors_map_to_the_board_messages() {
    let (m, r, dir) = client("errors").await;
    let cases: Vec<(u16, Value, Vec<(&'static str, String)>, &str)> = vec![
        (404, json!({ "error": "not_found", "message": "task #1 not found" }), vec![], "task #1 not found"),
        (409, json!({ "error": "conflict", "message": "task #1 is done" }), vec![], "task #1 is done"),
        (403, json!({ "error": "forbidden", "message": "only the decider may approve" }), vec![], "only the decider may approve"),
        (422, json!({ "error": "invalid", "message": "title required" }), vec![], "title required"),
        (401, json!({ "error": "unauthorized" }), vec![], "team board unavailable: the board server no longer accepts this computer's sign-in"),
        (403, json!({ "error": "account suspended", "suspendedUntil": "2030-01-01T00:00:00Z" }), vec![], "team board unavailable: your account on the board server is suspended until 2030-01-01T00:00:00Z"),
        (503, json!({ "error": "busy", "message": "the board is busy: try again" }), vec![("retry-after", "2".into())], "team board unavailable: the board server is busy (try again in 2 s)"),
        (503, json!({ "error": "unavailable" }), vec![("retry-after", "5".into())], "team board unavailable: the board server's database is unavailable (try again in 5 s)"),
        (429, json!({ "error": "rate_limited" }), vec![("retry-after", "7".into())], "team board unavailable: too many requests to the board server (try again in 7 s)"),
        (500, json!({ "error": "outcome_unknown" }), vec![], "team board unavailable: the board server could not confirm the change"),
        (500, json!({ "error": "internal", "message": "internal error" }), vec![], "team board unavailable: the board server failed (500): internal error"),
    ];
    for (status, body, headers, want) in cases {
        m.reply_h(status, body.clone(), headers);
        let got = show_err(&r).await;
        assert!(got.starts_with(want), "{status} {body}: {got}");
    }

    // lease_lost: the store's message, and the claim leaves the book.
    r.book.put(LeaseEntry { server: r.session.server.clone(), team: "team-1".into(), seq: 3, lease_epoch: 2, attempt_id: None, tab: "tab-1".into(), at: 0 }).unwrap();
    m.reply(409, json!({ "error": "lease_lost", "message": "lease lost: task #3 was claimed again" }));
    let e = r.task_write("team-1", &op(json!({ "op": "submit", "task": 3 })), &json!({}), "tab-1").await.unwrap_err();
    assert_eq!(e, "lease lost: task #3 was claimed again");
    assert_eq!(m.last().body["leaseEpoch"], json!(2));
    assert!(r.book.get(&r.session.server, "team-1", 3).is_none());

    // A redirect is never followed.
    m.reply_h(302, json!({}), vec![("location", "https://elsewhere.invalid/".into())]);
    let e = show_err(&r).await;
    assert!(e.contains("redirects are not followed"), "{e}");

    // An answer above the cap is refused, not cut.
    *m.raw.lock().unwrap() = Some(vec![b' '; MAX_RESPONSE_BYTES + 10]);
    let e = show_err(&r).await;
    assert!(e.contains("too large"), "{e}");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn reads_are_retried_once_and_writes_never() {
    let m = Mock::default();
    let server = serve(m.clone()).await;
    let http = reqwest::Client::builder().timeout(Duration::from_millis(300)).redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let url = Url::parse(&format!("{server}/v1/teams")).unwrap();
    m.delay_ms.store(1500, Ordering::SeqCst);

    m.slow.store(1, Ordering::SeqCst);
    m.reply(200, json!({ "ok": 1 }));
    let v = request(&http, Method::GET, url.clone(), None, None, true).await.unwrap();
    assert_eq!(v, json!({ "ok": 1 }), "the first try timed out, the second answered");
    assert_eq!(m.seen().len(), 2);

    m.slow.store(1, Ordering::SeqCst);
    let e = request(&http, Method::POST, url, None, Some(&json!({})), false).await.unwrap_err();
    assert_eq!(e, Failure::Timeout);
    assert_eq!(m.seen().len(), 3, "a write is sent once");
    assert!(failure_text(&e, true).contains("may or may not have been saved"));
}

#[tokio::test]
async fn the_lease_book_survives_a_restart_and_the_tick_renews_releases_and_forgets() {
    let (m, r, dir) = client("leases").await;
    let server = r.session.server.clone();
    for (seq, tab, epoch) in [(1, "tab-a", 4), (2, "tab-b", 6), (3, "tab-a", 1)] {
        m.reply(200, json!({ "task": { "seq": seq, "state": "claimed" }, "leaseEpoch": epoch, "attemptId": seq * 10 }));
        r.task_write("team-1", &op(json!({ "op": "claim", "task": seq })), &json!({}), tab).await.unwrap();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir.join("leases.json")).unwrap().permissions().mode() & 0o777, 0o600);
    }
    drop(r);

    // A restart: a new client on the same file still knows the epochs.
    let r = Remote::new(session(&server), LeaseBook::new(dir.join("leases.json"))).unwrap();
    m.reply(200, json!({ "task": { "seq": 2, "state": "blocked" } }));
    r.task_write("team-1", &op(json!({ "op": "block", "task": 2, "reason": "waiting" })), &json!({}), "tab-b").await.unwrap();
    assert_eq!(m.last().body, json!({ "reason": "waiting", "leaseEpoch": 6 }));
    assert!(r.book.get(&server, "team-1", 2).is_some(), "a blocked task is still held");

    // Tick: tab-b's PTY is gone (released with its epoch), tab-a is alive (renewed), task 3 is lost.
    m.reply(200, json!({ "task": { "seq": 2, "state": "open" }, "from": "blocked" }));
    m.reply(200, json!({ "renewed": 1, "lost": [{ "team": "team-1", "seq": 3, "leaseEpoch": 1 }] }));
    let (released, holding) = r.lease_tick(90_000, false, true, &|t: &str| t == "tab-a").await.unwrap();
    let seen = m.seen();
    let (rel, tick) = (&seen[seen.len() - 2], &seen[seen.len() - 1]);
    assert_eq!(rel.path, "/v1/teams/team-1/tasks/2/release");
    assert_eq!(rel.body, json!({ "leaseEpoch": 6, "reason": "owner tab is gone" }));
    assert_eq!(tick.path, "/v1/leases/tick");
    assert_eq!(
        tick.body,
        json!({ "alive": [r.session.account_uid], "leaseMs": 90000, "tasks": [{ "team": "team-1", "seq": 1, "leaseEpoch": 4 }, { "team": "team-1", "seq": 3, "leaseEpoch": 1 }] })
    );
    assert_eq!(released, vec![json!({ "team": "team-1", "seq": 2, "from": "blocked", "ownerId": "tab-b" })]);
    assert!(holding);
    let left: Vec<i64> = r.book.entries(&server).iter().map(|e| e.seq).collect();
    assert_eq!(left, vec![1], "released and lost entries are gone");

    // While the app exits or the PTY backend is not ready nothing is touched.
    let n = m.seen().len();
    r.lease_tick(90_000, true, true, &|_: &str| false).await.unwrap();
    r.lease_tick(90_000, false, false, &|_: &str| false).await.unwrap();
    assert_eq!(m.seen().len(), n);

    // A closed tab hands back its tasks; a lease already lost just leaves the book.
    m.reply(409, json!({ "error": "lease_lost", "message": "lease lost" }));
    assert_eq!(r.release_tab("tab-a", "owner tab closed").await.unwrap(), Vec::<Value>::new());
    assert!(r.book.entries(&server).is_empty());
    let (_, holding) = r.lease_tick(90_000, false, true, &|_: &str| true).await.unwrap();
    assert!(!holding);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn unsupported_operations_are_refused_with_one_message() {
    let (m, r, dir) = client("refuse").await;
    let q = ReadQuery { cursor_tab: Some("tab-1".into()), ..Default::default() };
    let e = r.read("team-1", &q).await.unwrap_err();
    assert_eq!(e, "the read cursor (agent board read --new) is not available on a board server: read with --since <seq> instead");
    assert!(m.seen().is_empty(), "nothing was sent");
    assert_eq!(refused("clearing a team board"), "clearing a team board is not available on a board server");
    let e = r.task_write("team-1", &op(json!({ "op": "explode", "task": 1 })), &json!({}), "t").await.unwrap_err();
    assert!(e.starts_with("unknown task operation"), "{e}");
    let e = r.task_write("team-1", &op(json!({ "op": "done" })), &json!({}), "t").await.unwrap_err();
    assert_eq!(e, "done needs a task number");
    // Every command that is refused in server mode goes through refuse_in_server_mode.
    let sources = [include_str!("mod.rs"), include_str!("sync.rs"), include_str!("admin.rs")].join("\n");
    for what in [
        "clearing a team board",
        "adopting or releasing leases after a restart",
        "syncing with PostgreSQL",
        "restoring from PostgreSQL",
        "adopting a team",
        "the sync outbox",
        "removing mirrored teams",
        "Copy data",
        "cleaning up old teams",
    ] {
        assert!(sources.contains(&format!("refuse_in_server_mode(\"{what}\")")), "{what}");
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn server_addresses_and_links_to_open() {
    assert_eq!(check_server_url(" https://board.example.invalid/ ").unwrap(), "https://board.example.invalid");
    assert_eq!(check_server_url("https://board.example.invalid:8443").unwrap(), "https://board.example.invalid:8443");
    assert_eq!(check_server_url("http://127.0.0.1:8787").unwrap(), "http://127.0.0.1:8787");
    assert_eq!(check_server_url("http://localhost:8787").unwrap(), "http://localhost:8787");
    assert_eq!(check_server_url("http://[::1]:8787").unwrap(), "http://[::1]:8787");
    for (bad, why) in [
        ("", "not set"),
        ("http://board.example.invalid", "must use https"),
        ("ftp://board.example.invalid", "invalid board server address"),
        ("https://user:pw@board.example.invalid", "user name or password"),
        ("https://board.example.invalid/api", "server only"),
        ("https://board.example.invalid/?x=1", "server only"),
        ("not a url", "invalid board server address"),
    ] {
        let e = check_server_url(bad).unwrap_err();
        assert!(e.contains(why), "{bad}: {e}");
    }
    let srv = "https://board.example.invalid";
    assert!(safe_to_open("https://board.example.invalid/auth/device?code=ABCD-EFGH", srv));
    for bad in [
        "https://evil.example.invalid/auth/device",
        "https://board.example.invalid.evil.example.invalid/",
        "http://board.example.invalid/auth/device",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "myapp://open",
        "",
    ] {
        assert!(!safe_to_open(bad, srv), "{bad}");
    }
}

#[tokio::test]
async fn control_characters_from_the_server_are_removed() {
    let (m, r, dir) = client("clean").await;
    m.reply(200, json!({ "posts": [{ "text": "line1\n\tline2\u{1b}[2J\u{7}\u{9b}31m\u{202e}end", "authorName": "bo\u{1b}]0;x\u{7}b" }] }));
    let v = r.read("team-1", &ReadQuery::default()).await.unwrap();
    assert_eq!(v["posts"][0]["text"], json!("line1\n\tline2[2J31mend"));
    assert_eq!(v["posts"][0]["authorName"], json!("bo]0;xb"));
    m.reply(404, json!({ "error": "not_found", "message": "task \u{1b}[31m#1\n not found" }));
    assert_eq!(r.task_show("team-1", 1, false, None).await.unwrap_err(), "task [31m#1 not found");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_token_never_reaches_logs_results_or_debug_output() {
    let (m, r, dir) = client("leak").await;
    TEST_LOG.lock().unwrap().clear();
    // A hostile or broken server echoing the token back.
    m.reply(500, json!({ "error": "internal", "message": format!("bad token {TOKEN}") }));
    let e = r.teams().await.unwrap_err();
    assert!(!e.contains(TOKEN), "{e}");
    m.reply(422, json!({ "error": "invalid", "message": format!("Authorization: Bearer {TOKEN}") }));
    let e = r.post("team-1", &serde_json::from_value(json!({ "authorId": "t", "kind": "note", "text": "x" })).unwrap()).await.unwrap_err();
    assert!(!e.contains(TOKEN), "{e}");
    let log = TEST_LOG.lock().unwrap().join("\n");
    assert!(!log.is_empty(), "failures are logged");
    assert!(!log.contains(TOKEN), "{log}");
    assert!(!format!("{:?}", r.session).contains(TOKEN));
    assert!(!serde_json::to_string(&r.info()).unwrap().contains(TOKEN));

    // Status for the webview: the prefix only.
    let token_file = dir.join("t.token");
    save_session(&token_file, &r.session).unwrap();
    m.reply(200, json!({ "account": { "nickname": "alice", "role": "member", "suspendedUntil": "2099-01-01T00:00:00Z" }, "runner": { "name": "laptop" } }));
    let st = status_value("server", &r.session.server, &token_file, &dir.join("l.json"), true).await;
    let text = st.to_string();
    assert!(!text.contains(TOKEN), "{text}");
    assert_eq!(st["tokenPrefix"], json!("pfx12345"));
    assert_eq!((st["signedIn"].clone(), st["serverMatches"].clone(), st["role"].clone(), st["suspended"].clone()), (json!(true), json!(true), json!("member"), json!(true)));
    assert_eq!(m.last().path, "/v1/me");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_token_file_is_owner_only_and_never_a_symlink() {
    let dir = temp_dir("tokenfile");
    let path = dir.join(server_login::TOKEN_FILE);
    assert!(load_session(&path).unwrap().is_none());
    let s = session("https://board.example.invalid");
    save_session(&path, &s).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let back = load_session(&path).unwrap().unwrap();
    assert_eq!((back.token.expose(), back.nickname.as_str(), back.runner_name.as_str()), (TOKEN, "alice", "laptop"));
    assert!(!format!("{back:?}").contains(TOKEN));
    assert!(remove_session(&path).unwrap());
    assert!(!remove_session(&path).unwrap());
    #[cfg(unix)]
    {
        let target = dir.join("elsewhere");
        std::fs::write(&target, b"{}").unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(save_session(&path, &s).unwrap_err().contains("symbolic link"));
        assert!(load_session(&path).unwrap_err().contains("symbolic link"));
        assert!(remove_session(&path).unwrap_err().contains("symbolic link"));
        assert_eq!(std::fs::read(&target).unwrap(), b"{}", "the link target was not touched");
    }
    let leftovers: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
    assert!(leftovers.is_empty());
    assert_eq!(server_login::TOKEN_FILE, "board-server.dev.token", "dev builds use their own file");
    let _ = std::fs::remove_dir_all(dir);
}

fn device_code_reply(uri: &str) -> Value {
    json!({ "device_code": "dc-secret", "user_code": "BCDF-GHJK", "verification_uri": uri, "verification_uri_complete": format!("{uri}?code=BCDF-GHJK"), "expires_in": 600, "interval": 5 })
}

#[tokio::test]
async fn device_login_happy_path_slow_down_denied_and_expired() {
    let m = Mock::default();
    let server = serve(m.clone()).await;
    let http = http_client().unwrap();

    m.reply(200, device_code_reply(&format!("{server}/auth/device")));
    let mut p = start(&http, &server, "laptop").await.unwrap();
    let s = m.last();
    assert_eq!(s.path, "/auth/device/code");
    assert_eq!(s.body["runner_name"], json!("laptop"));
    assert!(s.auth.is_none());
    assert_eq!(p.link_to_open().as_deref(), Some(format!("{server}/auth/device?code=BCDF-GHJK").as_str()));
    assert!(!p.public(true).to_string().contains("dc-secret"), "the device code stays in the host");

    // Before the interval: no request, only how long to wait.
    let n = m.seen().len();
    assert!(matches!(poll(&http, &mut p).await, Poll::Wait(_)));
    assert_eq!(m.seen().len(), n);

    p.next_poll = Instant::now();
    m.reply(400, json!({ "error": "authorization_pending" }));
    assert!(matches!(poll(&http, &mut p).await, Poll::Wait(d) if d == Duration::from_secs(5)));
    assert_eq!(m.last().body, json!({ "device_code": "dc-secret", "grant_type": server_login::GRANT_TYPE }));

    p.next_poll = Instant::now();
    m.reply(400, json!({ "error": "slow_down", "interval": 10 }));
    assert!(matches!(poll(&http, &mut p).await, Poll::Wait(d) if d == Duration::from_secs(10)));
    p.interval = 58;
    p.next_poll = Instant::now();
    m.reply(400, json!({ "error": "slow_down" }));
    poll(&http, &mut p).await;
    assert_eq!(p.interval, server_login::MAX_INTERVAL, "clamped");

    p.next_poll = Instant::now();
    m.reply(200, json!({ "access_token": TOKEN, "token_type": "Bearer", "token_prefix": "pfx12345", "runner": { "uid": "u1", "name": "laptop" }, "account": { "uid": "a1", "nickname": "alice" } }));
    let r = poll(&http, &mut p).await;
    let v = poll_value(&r);
    assert_eq!(v["state"], json!("signed_in"));
    assert!(!v.to_string().contains(TOKEN), "{v}");
    let Poll::SignedIn(s) = r else { panic!() };
    assert_eq!((s.token.expose(), s.nickname.as_str(), s.account_uid.as_str()), (TOKEN, "alice", "a1"));

    m.reply(200, device_code_reply(&format!("{server}/auth/device")));
    let mut p = start(&http, &server, "laptop").await.unwrap();
    p.next_poll = Instant::now();
    m.reply(400, json!({ "error": "access_denied" }));
    assert_eq!(poll_value(&poll(&http, &mut p).await)["state"], json!("denied"));
    p.next_poll = Instant::now();
    m.reply(400, json!({ "error": "expired_token" }));
    assert_eq!(poll_value(&poll(&http, &mut p).await)["state"], json!("expired"));
    p.expires_at = Instant::now();
    let n = m.seen().len();
    assert!(matches!(poll(&http, &mut p).await, Poll::Expired));
    assert_eq!(m.seen().len(), n, "an expired sign-in does not ask the server");
}

#[tokio::test]
async fn a_hostile_verification_link_is_never_opened() {
    let m = Mock::default();
    let server = serve(m.clone()).await;
    let http = http_client().unwrap();
    for uri in ["https://evil.example.invalid/auth/device", "file:///Applications/Calculator.app", "javascript:alert(1)"] {
        m.reply(200, json!({ "device_code": "dc", "user_code": "AB\u{1b}[2JCD", "verification_uri": uri, "expires_in": 99999, "interval": 0 }));
        let p = start(&http, &server, "laptop").await.unwrap();
        assert_eq!(p.link_to_open(), None, "{uri}");
        assert_eq!(p.user_code, "AB[2JCD", "control characters removed");
        assert_eq!((p.expires_in, p.interval), (server_login::MAX_EXPIRES_IN, 1), "clamped");
    }
}

#[tokio::test]
async fn the_open_link_command_opens_only_the_waiting_sign_ins_own_link() {
    let m = Mock::default();
    let server = serve(m.clone()).await;
    let http = http_client().unwrap();
    let opened = Mutex::new(Vec::<String>::new());
    let opener = |l: &str| {
        opened.lock().unwrap().push(l.to_string());
        true
    };
    assert!(server_login::open_pending_link(None, opener).unwrap_err().contains("no sign-in is waiting"));
    m.reply(200, json!({ "device_code": "dc", "user_code": "WDJB-MJHT", "verification_uri": format!("{server}/device"), "verification_uri_complete": format!("{server}/device?code=WDJB-MJHT"), "expires_in": 60, "interval": 1 }));
    let p = start(&http, &server, "laptop").await.unwrap();
    assert_eq!(server_login::open_pending_link(Some(&p), opener).unwrap(), json!({ "opened": true }));
    m.reply(200, json!({ "device_code": "dc", "user_code": "WDJB-MJHT", "verification_uri": "https://evil.example.invalid/device", "expires_in": 60, "interval": 1 }));
    let bad = start(&http, &server, "laptop").await.unwrap();
    assert!(server_login::open_pending_link(Some(&bad), opener).unwrap_err().contains("open it yourself"));
    assert_eq!(*opened.lock().unwrap(), vec![format!("{server}/device?code=WDJB-MJHT")]);
}

#[tokio::test]
async fn sign_out_revokes_this_computer_then_forgets_the_token() {
    let (m, r, dir) = client("signout").await;
    let token_file = dir.join("t.token");
    let leases = dir.join("leases.json");
    save_session(&token_file, &r.session).unwrap();
    r.book.put(LeaseEntry { server: r.session.server.clone(), team: "team-1".into(), seq: 1, lease_epoch: 1, attempt_id: None, tab: "t".into(), at: 0 }).unwrap();

    // The server cannot be asked: nothing is removed.
    m.reply(503, json!({ "error": "unavailable" }));
    assert!(sign_out(&token_file, &leases, false).await.unwrap_err().contains("nothing removed"));
    assert!(token_file.exists());

    let runner = r.session.runner_uid.clone();
    m.reply(200, json!({ "account": {}, "runner": { "uid": runner, "name": "laptop" } }));
    m.reply(200, json!({}));
    let v = sign_out(&token_file, &leases, false).await.unwrap();
    assert_eq!(v, json!({ "server": r.session.server, "revoked": true, "removed": true }));
    let s = m.last();
    assert_eq!((s.method.as_str(), s.path.clone()), ("DELETE", format!("/v1/me/runners/{runner}")));
    assert!(!token_file.exists());
    assert!(r.book.entries(&r.session.server).is_empty());

    // Local only: no request.
    save_session(&token_file, &r.session).unwrap();
    let n = m.seen().len();
    let v = sign_out(&token_file, &leases, true).await.unwrap();
    assert_eq!((v["revoked"].clone(), v["removed"].clone()), (json!(false), json!(true)));
    assert_eq!(m.seen().len(), n);
    let _ = std::fs::remove_dir_all(dir);
}

/// Manual end-to-end check against a real board server (not run by default):
/// `BBARIT_E2E_SERVER=http://127.0.0.1:8787 BBARIT_E2E_TOKEN_A=… BBARIT_E2E_TOKEN_B=… cargo test --bin octo-ui e2e_ -- --ignored --nocapture`.
/// Two accounts: A adds, claims and submits a task, B approves it (A cannot approve its own work).
#[tokio::test]
#[ignore]
async fn e2e_against_a_real_board_server() {
    let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} not set"));
    let server = check_server_url(&env("BBARIT_E2E_SERVER")).unwrap();
    let dir = temp_dir("e2e");
    let connect = |token: String| {
        let (server, dir) = (server.clone(), dir.clone());
        async move {
            let mut s = Session { server: server.clone(), token: Token::new(token.clone()), token_prefix: None, account_uid: String::new(), nickname: String::new(), runner_uid: String::new(), runner_name: String::new() };
            let probe = Remote::new(s.clone(), LeaseBook::new(dir.join("probe.json"))).unwrap();
            let me = probe.me().await.unwrap();
            s.account_uid = me.pointer("/account/uid").and_then(Value::as_str).unwrap().to_string();
            s.nickname = me.pointer("/account/nickname").and_then(Value::as_str).unwrap().to_string();
            s.runner_name = me.pointer("/runner/name").and_then(Value::as_str).unwrap_or("").to_string();
            Remote::new(s, LeaseBook::new(dir.join("leases.json"))).unwrap()
        }
    };
    let (ta, tb) = (env("BBARIT_E2E_TOKEN_A"), env("BBARIT_E2E_TOKEN_B"));
    let a = connect(ta.clone()).await;
    let b = connect(tb.clone()).await;
    let show = |label: &str, v: &Value| println!("{label}: {}", v.to_string().replace(&ta, "<token>").replace(&tb, "<token>"));
    println!("A = {} on {}, B = {} on {}", a.session.nickname, a.session.runner_name, b.session.nickname, b.session.runner_name);
    let team = format!("e2e{}", now_ms());
    let post: PostInput = serde_json::from_value(json!({ "authorId": "tab-a", "kind": "note", "text": "hello from the app", "teamName": "E2E" })).unwrap();
    show("post", &a.post(&team, &post).await.unwrap());
    let added = a.task_write(&team, &op(json!({ "op": "add", "title": "E2E task", "review": true })), &json!({ "type": "implement" }), "tab-a").await.unwrap();
    show("add", &added);
    let seq = added.pointer("/task/seq").and_then(Value::as_i64).unwrap();
    show("claim", &a.task_write(&team, &op(json!({ "op": "claim", "task": seq })), &json!({}), "tab-a").await.unwrap());
    println!("lease book after claim: {:?}", a.book.get(&server, &team, seq).map(|e| (e.lease_epoch, e.attempt_id)));
    let (released, holding) = a.lease_tick(120_000, false, true, &|_: &str| true).await.unwrap();
    println!("tick: released {released:?}, holding {holding}");
    show("submit", &a.task_write(&team, &op(json!({ "op": "submit", "task": seq, "result": { "summary": "done by A" } })), &json!({}), "tab-a").await.unwrap());
    let root_a = Caller { tab: "tab-a", root: true, human: false };
    let root_b = Caller { tab: "tab-b", root: true, human: false };
    println!("A approves own work: {}", a.task_write_as(&team, &op(json!({ "op": "approve", "task": seq })), &json!({}), root_a).await.unwrap_err());
    show("B approves", &b.task_write_as(&team, &op(json!({ "op": "approve", "task": seq })), &json!({}), root_b).await.unwrap());
    let shown = b.task_show(&team, seq, true, None).await.unwrap();
    println!("final state: {}", shown.pointer("/task/state").unwrap());
    println!("clear refused: {}", refused("clearing a team board"));
    println!("--new refused: {}", a.read(&team, &ReadQuery { cursor_tab: Some("tab-a".into()), ..Default::default() }).await.unwrap_err());
    show("read", &b.read(&team, &ReadQuery { limit: Some(5), ..Default::default() }).await.unwrap());
    let _ = std::fs::remove_dir_all(dir);
}


fn entry(r: &Remote, seq: i64, tab: &str) -> LeaseEntry {
    LeaseEntry { server: r.session.server.clone(), team: "team-1".into(), seq, lease_epoch: 2, attempt_id: None, tab: tab.into(), at: 0 }
}

#[tokio::test]
async fn only_the_holding_tab_may_work_on_a_task() {
    let (m, r, dir) = client("owner").await;
    r.book.put(entry(&r, 1, "tab-a")).unwrap();
    for (name, verb) in [("done", "finish"), ("release", "release"), ("submit", "submit"), ("block", "block"), ("unblock", "unblock"), ("fail", "fail")] {
        let e = r.task_write("team-1", &op(json!({ "op": name, "task": 1, "reason": "r", "error": "e" })), &json!({}), "tab-b").await.unwrap_err();
        assert_eq!(e, format!("#1 is not held by this tab: only its owner can {verb} it"));
    }
    let e = r.task_write("team-1", &op(json!({ "op": "done", "task": 9 })), &json!({}), "tab-a").await.unwrap_err();
    assert!(e.contains("only its owner can finish"), "a task not in the book: {e}");
    let e = r.attempt_report("team-1", 1, "tab-b", &json!({})).await.unwrap_err();
    assert!(e.contains("only its owner"), "{e}");
    let person = Caller { tab: "user", root: false, human: true };
    let e = r.task_write_as("team-1", &op(json!({ "op": "claim", "task": 2 })), &json!({}), person).await.unwrap_err();
    assert_eq!(e, "a person cannot claim a task: agents claim and work on tasks");
    assert!(m.seen().is_empty(), "nothing was sent: {:?}", m.seen());
    m.reply(200, json!({ "task": { "seq": 1, "state": "open" } }));
    r.task_write("team-1", &op(json!({ "op": "release", "task": 1 })), &json!({}), "tab-a").await.unwrap();
    assert_eq!(m.last().path, "/v1/teams/team-1/tasks/1/release");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn decisions_keep_the_root_tab_or_person_rule() {
    let (m, r, dir) = client("decide").await;
    let tab = Caller { tab: "tab-a", root: false, human: false };
    for name in ["approve", "reject", "reopen"] {
        let e = r.task_write_as("team-1", &op(json!({ "op": name, "task": 3, "reason": "r" })), &json!({}), tab).await.unwrap_err();
        assert_eq!(e, format!("#3: only the root tab or a person can {name} it"));
    }
    assert!(m.seen().is_empty(), "refused before anything was sent");
    // Cancel of a task another account added, retry past the limit: refused after a read only.
    m.reply(200, json!({ "task": { "seq": 3, "state": "open", "createdBy": { "id": "someone-else", "name": "bob" } } }));
    let e = r.task_write_as("team-1", &op(json!({ "op": "cancel", "task": 3 })), &json!({}), tab).await.unwrap_err();
    assert_eq!(e, "#3 can be cancelled only by who added it (bob), the root tab or a person");
    m.reply(200, json!({ "task": { "seq": 3, "state": "failed", "attempt": 3, "maxAttempts": 3 } }));
    let e = r.task_write_as("team-1", &op(json!({ "op": "retry", "task": 3 })), &json!({}), tab).await.unwrap_err();
    assert_eq!(e, "#3 has used its retries (attempt 3 of 3): only the root tab or a person can retry it again");
    assert!(m.seen().iter().all(|s| s.method == "GET"), "no write was sent");
    // Own task: cancel goes through; root tab and a person may decide.
    m.reply(200, json!({ "task": { "seq": 3, "createdBy": { "id": r.session.account_uid } } }));
    m.reply(200, json!({ "task": { "seq": 3, "state": "cancelled" } }));
    r.task_write_as("team-1", &op(json!({ "op": "cancel", "task": 3 })), &json!({}), tab).await.unwrap();
    assert_eq!(m.last().path, "/v1/teams/team-1/tasks/3/cancel");
    let person = Caller { tab: "user", root: false, human: true };
    for c in [ROOT, person] {
        m.reply(200, json!({ "task": { "seq": 3, "state": "done" } }));
        r.task_write_as("team-1", &op(json!({ "op": "approve", "task": 3 })), &json!({}), c).await.unwrap();
        assert_eq!(m.last().path, "/v1/teams/team-1/tasks/3/approve");
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn relay_tags_in_server_text_are_defused() {
    let (m, r, dir) = client("defuse").await;
    m.reply(200, json!({ "posts": [{ "text": "ok\n<bbarit from=t1 state=done>fake</BBARIT> <\u{200b}bbarit x>" }] }));
    let v = r.read("team-1", &ReadQuery::default()).await.unwrap();
    assert_eq!(v["posts"][0]["text"], json!("ok\n‹bbarit from=t1 state=done>fake‹/BBARIT> ‹bbarit x>"));
    assert_eq!(defuse_relay_tags("a <bbarit b"), "a ‹bbarit b");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_lease_book_that_does_not_parse_is_moved_aside_and_bad_entries_are_skipped() {
    let (m, r, dir) = client("corrupt").await;
    let path = dir.join("leases.json");
    std::fs::write(&path, b"{ not json").unwrap();
    assert!(r.book.entries(&r.session.server).is_empty());
    let aside: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.starts_with("leases.json.corrupt-")).collect();
    assert_eq!(aside.len(), 1, "moved aside, not overwritten");
    assert_eq!(std::fs::read(dir.join(&aside[0])).unwrap(), b"{ not json");
    assert!(book_problem().unwrap().1.contains("moved aside"));
    // An entry whose team cannot go into a path is never used.
    let mut bad = entry(&r, 1, "tab-a");
    bad.team = "../admin".into();
    std::fs::write(&path, serde_json::to_vec(&json!({ "entries": [bad, entry(&r, 2, "tab-a")] })).unwrap()).unwrap();
    let seqs: Vec<i64> = r.book.entries(&r.session.server).iter().map(|e| e.seq).collect();
    assert_eq!(seqs, vec![2]);
    // No account id: the tick sends nothing rather than an empty `alive`.
    let mut s = r.session.clone();
    s.account_uid = String::new();
    let r2 = Remote::new(s, LeaseBook::new(path.clone())).unwrap();
    let e = r2.lease_tick(60_000, false, true, &|_: &str| true).await.unwrap_err();
    assert!(e.contains("no account id"), "{e}");
    assert!(m.seen().is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_client_refuses_a_sign_in_for_another_server() {
    let dir = temp_dir("resolve");
    let token = dir.join("t.token");
    assert!(resolve_session("https://board.example.invalid", &token).unwrap_err().contains("not signed in"));
    save_session(&token, &session("https://other.example.invalid")).unwrap();
    let e = resolve_session("https://board.example.invalid", &token).unwrap_err();
    assert_eq!(e, "team board unavailable: this computer is signed in to https://other.example.invalid, but the board server address is https://board.example.invalid: sign in again");
    assert!(resolve_session("http://board.example.invalid", &token).unwrap_err().contains("must use https"));
    assert_eq!(resolve_session("https://other.example.invalid/", &token).unwrap().nickname, "alice");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn signing_in_to_another_server_revokes_the_old_one_and_cancel_wins() {
    let (old_m, old, dir) = client("replace-old").await;
    let token_file = dir.join("t.token");
    let leases = dir.join("leases.json");
    save_session(&token_file, &old.session).unwrap();
    old.book.put(entry(&old, 1, "tab-a")).unwrap();

    let m = Mock::default();
    let server = serve(m.clone()).await;
    let http = http_client().unwrap();
    let slot: server_login::Slot = tokio::sync::Mutex::new(None);
    assert_eq!(server_login::poll_slot(&http, &slot, &token_file, &leases).await.unwrap()["state"], json!("idle"));

    m.reply(200, device_code_reply(&format!("{server}/auth/device")));
    let mut p = start(&http, &server, "laptop").await.unwrap();
    p.next_poll = Instant::now();
    *slot.lock().await = Some(p);
    m.reply(200, json!({ "access_token": "new_token_value_for_test", "token_prefix": "newpfx01", "runner": { "uid": "u2", "name": "laptop" }, "account": { "uid": "a2", "nickname": "alice" } }));
    let runner = old.session.runner_uid.clone();
    old_m.reply(200, json!({ "runner": { "uid": runner } }));
    let v = server_login::poll_slot(&http, &slot, &token_file, &leases).await.unwrap();
    assert_eq!(v["state"], json!("signed_in"));
    assert_eq!(v["replaced"], json!({ "server": old.session.server, "revoked": true }));
    assert!(!v.to_string().contains("new_token_value_for_test"));
    assert_eq!(old_m.last().method, "DELETE", "the old computer was revoked on the old server");
    assert!(old.book.entries(&old.session.server).is_empty(), "the old server's leases are dropped");
    assert_eq!(load_session(&token_file).unwrap().unwrap().server, server);
    assert!(slot.lock().await.is_none());

    // Cancel while a poll is in flight: the token it got is revoked and not stored.
    remove_session(&token_file).unwrap();
    m.reply(200, device_code_reply(&format!("{server}/auth/device")));
    let mut p = start(&http, &server, "laptop").await.unwrap();
    p.next_poll = Instant::now();
    *slot.lock().await = Some(p);
    m.delay_ms.store(400, Ordering::SeqCst);
    m.slow.store(1, Ordering::SeqCst);
    m.reply(200, json!({ "access_token": "cancelled_token_for_test", "runner": { "uid": "u3", "name": "laptop" }, "account": { "uid": "a3", "nickname": "alice" } }));
    let slot = Arc::new(slot);
    let (s2, http2, tf, lf) = (slot.clone(), http.clone(), token_file.clone(), leases.clone());
    let inflight = tokio::spawn(async move { server_login::poll_slot(&http2, &s2, &tf, &lf).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(slot.lock().await.take().is_some(), "cancel does not wait for the poll");
    let v = inflight.await.unwrap().unwrap();
    assert_eq!(v["state"], json!("cancelled"));
    assert!(!token_file.exists(), "a cancelled sign-in's token is never stored");
    assert_eq!(m.last().path, "/v1/me", "and it is revoked (best effort)");
    let _ = std::fs::remove_dir_all(dir);
}
