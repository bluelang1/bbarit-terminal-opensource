//! The change-stream subscriber against an in-process SSE mock (axum on loopback).

use super::*;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::Request;
use axum::response::Response;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const TOKEN: &str = "stream_test_token_not_a_real_secret";

fn timing() -> Timing {
    Timing {
        base: Duration::from_millis(40),
        cap: Duration::from_secs(1),
        check: Duration::from_millis(30),
        tick: Duration::from_millis(10),
        debounce: Duration::from_millis(150),
        idle: Duration::from_secs(5),
        connect: Duration::from_secs(2),
        healthy: Duration::from_secs(2),
        suspended: Duration::from_millis(600),
    }
}

// ── Parser, debounce, back-off ──

#[test]
fn the_parser_reads_ids_events_multi_line_data_retry_and_skips_comments() {
    let mut p = SseParser::default();
    let mut frames = p.feed(b"retry: 3000\r\n: ready\r\n\r\nid: 5\nevent: task.claim\ndata: {\"team\":\n").unwrap();
    frames.extend(p.feed(b"data: \"team-a\"}\n\n: heartbeat\nid: 9\n\n:only a comment\n\n").unwrap());
    frames.extend(p.feed(b"id: 10\revent: reset\rdata: {}\r\r").unwrap());
    assert_eq!(
        frames,
        vec![
            Frame { retry: Some(3000), ..Frame::default() },
            Frame { id: Some("5".into()), event: Some("task.claim".into()), data: "{\"team\":\n\"team-a\"}".into(), retry: None },
            Frame { id: Some("9".into()), ..Frame::default() },
            Frame { id: Some("10".into()), event: Some("reset".into()), data: "{}".into(), retry: None },
        ]
    );
    assert_eq!(team_of(&frames[1].data).as_deref(), Some("team-a"));
    assert_eq!(team_of("{\"team\":\"../etc\"}"), None, "only team ids the store accepts");
    assert_eq!(team_of("not json"), None);
    assert!(valid_id("12") && !valid_id("1a") && !valid_id(""));
    let mut long = SseParser::default();
    assert!(long.feed(&vec![b'x'; MAX_LINE_BYTES + 1]).is_err());
}

#[test]
fn debounce_announces_a_team_at_most_once_per_window() {
    let mut d = Debounce::new(Duration::from_millis(500));
    let t0 = Instant::now();
    assert_eq!(d.mark("a", t0).as_deref(), Some("a"));
    assert_eq!(d.mark("a", t0 + Duration::from_millis(100)), None);
    assert_eq!(d.mark("a", t0 + Duration::from_millis(200)), None);
    assert_eq!(d.mark("b", t0 + Duration::from_millis(200)).as_deref(), Some("b"), "teams are separate");
    assert!(d.due(t0 + Duration::from_millis(400)).is_empty());
    assert_eq!(d.due(t0 + Duration::from_millis(500)), vec!["a".to_string()]);
    assert!(d.due(t0 + Duration::from_millis(700)).is_empty(), "nothing waits any more");
    // reset: every team announced, nothing left waiting.
    assert_eq!(d.mark("a", t0 + Duration::from_millis(800)), None, "within the window of the trailing one");
    d.all(t0 + Duration::from_millis(800));
    assert!(d.due(t0 + Duration::from_secs(5)).is_empty());
}

#[test]
fn past_the_cap_one_every_team_announcement_and_memory_stays_bounded() {
    let mut d = Debounce::with_cap(Duration::from_millis(500), 3);
    let t0 = Instant::now();
    let got: Vec<Option<String>> = (0..10).map(|i| d.mark(&format!("t{i}"), t0)).collect();
    assert_eq!(got[..3], [Some("t0".into()), Some("t1".into()), Some("t2".into())]);
    assert_eq!(got[3].as_deref(), Some(""), "the fourth team: every team");
    assert!(got[4..].iter().all(Option::is_none), "no team is tracked until the window ends");
    assert_eq!(d.tracked(), 0);
    assert_eq!(d.due(t0 + Duration::from_millis(500)), vec![String::new()], "one more for changes during the window");
    assert!(d.due(t0 + Duration::from_millis(1100)).is_empty());
    assert_eq!(d.mark("t9", t0 + Duration::from_millis(1100)).as_deref(), Some("t9"));
    // Many teams over time: old entries leave the map.
    let mut d = Debounce::with_cap(Duration::from_millis(10), 64);
    for i in 0..1000u64 {
        d.mark(&format!("x{i}"), t0 + Duration::from_millis(i * 20));
    }
    assert!(d.tracked() <= 1);
}

#[test]
fn busy_waits_follow_retry_after_and_the_back_off_never_below_one_second() {
    let t = TIMING;
    assert_eq!(busy_wait(Some(Duration::ZERO), 1, &t, 0.5), MIN_BUSY_WAIT, "Retry-After 0");
    assert_eq!(busy_wait(Some(Duration::from_secs(30)), 1, &t, 0.5), Duration::from_secs(30));
    assert_eq!(busy_wait(Some(Duration::from_secs(5)), 5, &t, 0.5), Duration::from_secs(16), "the back-off when longer");
    assert_eq!(busy_wait(Some(Duration::from_secs(99_999)), 1, &t, 0.5), MAX_RETRY_AFTER);
    assert_eq!(busy_wait(None, 3, &t, 0.5), Duration::from_secs(4), "no Retry-After: the back-off");
}

#[test]
fn backoff_doubles_with_jitter_up_to_the_cap() {
    let t = TIMING;
    assert_eq!(backoff(1, &t, 0.5), Duration::from_secs(1));
    assert_eq!(backoff(3, &t, 0.5), Duration::from_secs(4));
    assert_eq!(backoff(30, &t, 1.0), Duration::from_secs(60), "never above the cap");
    assert!(backoff(2, &t, 0.0) >= Duration::from_millis(1600) && backoff(2, &t, 1.0) <= Duration::from_millis(2400));
}

// ── Mock SSE server ──

enum Step {
    Status(u16, Option<&'static str>),
    /// Send these chunks; keep the stream open when `hold`, else end it.
    Send(Vec<&'static str>, bool),
}

#[derive(Clone, Default)]
struct Sse {
    conns: Arc<Mutex<Vec<(Instant, Option<String>, Option<String>)>>>,
    script: Arc<Mutex<VecDeque<Step>>>,
    open: Arc<Mutex<Vec<tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>>>>,
}

impl Sse {
    fn push(&self, s: Step) {
        self.script.lock().unwrap().push_back(s);
    }
    fn conns(&self) -> usize {
        self.conns.lock().unwrap().len()
    }
    fn open_now(&self) -> usize {
        self.open.lock().unwrap().iter().filter(|t| !t.is_closed()).count()
    }
}

async fn handle(State(s): State<Sse>, req: Request<Body>) -> Response {
    let h = |k: &str| req.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
    assert_eq!(req.uri().path(), "/v1/stream");
    s.conns.lock().unwrap().push((Instant::now(), h("last-event-id"), h("authorization")));
    let step = s.script.lock().unwrap().pop_front().unwrap_or(Step::Send(Vec::new(), true));
    match step {
        Step::Status(code, ra) => {
            let mut b = Response::builder().status(code).header("content-type", "application/json");
            if let Some(v) = ra {
                b = b.header("retry-after", v);
            }
            b.body(Body::from("{\"error\":\"busy\"}")).unwrap()
        }
        Step::Send(chunks, hold) => {
            let (tx, rx) = tokio::sync::mpsc::channel(64);
            for c in chunks {
                tx.try_send(Ok(Bytes::from(c))).unwrap();
            }
            if hold {
                s.open.lock().unwrap().push(tx);
            }
            let body = futures::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|b| (b, rx)) });
            Response::builder().status(200).header("content-type", "text/event-stream").body(Body::from_stream(body)).unwrap()
        }
    }
}

async fn serve(s: Sse) -> String {
    let app = axum::Router::new().fallback(handle).with_state(s);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

struct Harness {
    emitted: Arc<Mutex<Vec<String>>>,
    signed_in: Arc<AtomicBool>,
    token: Arc<Mutex<String>>,
    stop: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

impl Harness {
    fn start(server: String) -> Harness {
        Harness::with(server, timing())
    }
    fn with(server: String, timing: Timing) -> Harness {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let signed_in = Arc::new(AtomicBool::new(true));
        let token = Arc::new(Mutex::new(TOKEN.to_string()));
        let stop = Arc::new(AtomicBool::new(false));
        let (e, s, tk, st) = (emitted.clone(), signed_in.clone(), token.clone(), stop.clone());
        let task = tokio::spawn(run(Deps {
            want: move || s.load(Ordering::SeqCst).then(|| Target { server: server.clone(), token: Token::new(tk.lock().unwrap().clone()) }),
            emit: move |team: &str| e.lock().unwrap().push(team.to_string()),
            stop: move || st.load(Ordering::SeqCst),
            timing,
        }));
        Harness { emitted, signed_in, token, stop, task }
    }
    fn emitted(&self) -> Vec<String> {
        self.emitted.lock().unwrap().clone()
    }
    async fn finish(self) {
        self.stop.store(true, Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(5), self.task).await.expect("the subscriber stops").unwrap();
    }
}

async fn until(what: &str, f: impl Fn() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !f() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn announces_changed_teams_resumes_by_last_id_and_reset_announces_every_team() {
    let s = Sse::default();
    s.push(Step::Send(vec!["retry: 60\n: ready\n\n", "id: 5\nevent: post\ndata: {\"id\":5,\"team\":\"team-a\",\"kind\":\"post\"}\n\n", ": heartbeat\nid: 8\n\n"], false));
    s.push(Step::Send(vec!["id: 12\nevent: reset\ndata: {\"cursor\":8,\"reason\":\"pruned\"}\n\n"], true));
    let h = Harness::start(serve(s.clone()).await);
    until("the second connection", || s.conns() >= 2).await;
    until("the reset", || h.emitted().contains(&String::new())).await;
    let conns = s.conns.lock().unwrap().clone();
    assert_eq!(conns[0].1, None, "the first connection starts at the head");
    assert_eq!(conns[1].1.as_deref(), Some("8"), "resumes from the heartbeat's id");
    assert_eq!(conns[0].2.as_deref(), Some(format!("Bearer {TOKEN}").as_str()));
    assert_eq!(h.emitted(), vec!["team-a".to_string(), String::new()]);
    h.finish().await;
    assert!(remote::TEST_LOG.lock().unwrap().iter().all(|l| !l.contains(TOKEN)), "the token is never logged");
}

#[tokio::test]
async fn debounces_a_burst_of_changes_of_one_team() {
    let s = Sse::default();
    s.push(Step::Send(
        vec![
            "id: 1\nevent: task.add\ndata: {\"team\":\"team-a\"}\n\nid: 2\nevent: task.claim\ndata: {\"team\":\"team-a\"}\n\nid: 3\nevent: task.done\ndata: {\"team\":\"team-a\"}\n\nid: 4\nevent: post\ndata: {\"team\":\"team-b\"}\n\n",
        ],
        true,
    ));
    let h = Harness::start(serve(s.clone()).await);
    until("the first announcements", || h.emitted().len() >= 2).await;
    assert_eq!(h.emitted(), vec!["team-a".to_string(), "team-b".to_string()], "the first change at once");
    until("the trailing announcement", || h.emitted().len() >= 3).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(h.emitted(), vec!["team-a".to_string(), "team-b".to_string(), "team-a".to_string()], "one more for the rest of the window");
    h.finish().await;
}

#[tokio::test]
async fn backs_off_after_drops_and_waits_out_retry_after() {
    let s = Sse::default();
    for _ in 0..3 {
        s.push(Step::Status(500, None));
    }
    s.push(Step::Status(503, Some("1")));
    let h = Harness::start(serve(s.clone()).await);
    until("five connections", || s.conns() >= 5).await;
    let at: Vec<Instant> = s.conns.lock().unwrap().iter().map(|c| c.0).collect();
    let gap = |i: usize| at[i + 1].duration_since(at[i]);
    // 40 ms, 80 ms, 160 ms (±20 %), then the server's Retry-After of 1 s.
    assert!(gap(0) >= Duration::from_millis(30), "{:?}", gap(0));
    assert!(gap(2) > gap(0), "{:?} then {:?}", gap(0), gap(2));
    assert!(gap(3) >= Duration::from_millis(950), "Retry-After honoured: {:?}", gap(3));
    h.finish().await;
}

#[tokio::test]
async fn stops_on_sign_out_and_after_401_waits_for_a_new_sign_in() {
    let s = Sse::default();
    let h = Harness::start(serve(s.clone()).await);
    until("a connection", || s.open_now() == 1).await;
    h.signed_in.store(false, Ordering::SeqCst);
    until("the connection dropped", || s.open_now() == 0).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(s.conns(), 1, "no connection while signed out");

    // Signed in again, but the server refuses the token: no retry with the same sign-in.
    s.push(Step::Status(401, None));
    h.signed_in.store(true, Ordering::SeqCst);
    until("the refused connection", || s.conns() == 2).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(s.conns(), 2, "a refused sign-in is not tried again");
    *h.token.lock().unwrap() = "another_test_token_value".into();
    until("a connection with the new sign-in", || s.conns() == 3).await;
    assert_eq!(s.conns.lock().unwrap()[2].2.as_deref(), Some("Bearer another_test_token_value"));
    h.finish().await;
}

fn gaps(s: &Sse) -> Vec<Duration> {
    let at: Vec<Instant> = s.conns.lock().unwrap().iter().map(|c| c.0).collect();
    at.windows(2).map(|w| w[1].duration_since(w[0])).collect()
}

#[tokio::test]
async fn retry_after_zero_still_waits_a_second_and_429_without_it_backs_off() {
    let s = Sse::default();
    s.push(Step::Status(503, Some("0")));
    s.push(Step::Status(429, None));
    let h = Harness::start(serve(s.clone()).await);
    until("three connections", || s.conns() >= 3).await;
    let g = gaps(&s);
    assert!(g[0] >= Duration::from_millis(950), "Retry-After 0 waits at least 1 s: {:?}", g[0]);
    assert!(g[1] >= Duration::from_millis(950), "never below 1 s: {:?}", g[1]);
    h.finish().await;
}

#[tokio::test]
async fn a_server_that_sends_a_byte_and_closes_is_retried_with_growing_waits() {
    let s = Sse::default();
    for _ in 0..6 {
        s.push(Step::Send(vec![": hi\n\n"], false));
    }
    let h = Harness::start(serve(s.clone()).await);
    until("six connections", || s.conns() >= 6).await;
    let g = gaps(&s);
    // 40, 80, 160, 320, 640 ms (±20 %): not a fixed fast rate.
    assert!(g[3] >= g[0] * 3, "{g:?}");
    assert!(g[4] >= Duration::from_millis(450), "{g:?}");
    h.finish().await;
}

#[tokio::test]
async fn a_stream_closed_with_an_id_resets_the_back_off_then_a_401_stops_it() {
    let s = Sse::default();
    s.push(Step::Status(500, None));
    s.push(Step::Status(500, None));
    s.push(Step::Send(vec!["id: 7\nevent: post\ndata: {\"team\":\"team-a\"}\n\n"], false));
    s.push(Step::Status(401, None));
    let h = Harness::start(serve(s.clone()).await);
    until("the 401", || s.conns() >= 4).await;
    let g = gaps(&s);
    assert!(g[2] < Duration::from_millis(100), "healthy: back to the first step: {g:?}");
    assert_eq!(s.conns.lock().unwrap()[3].1.as_deref(), Some("7"));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(s.conns(), 4, "no retry with a refused sign-in");
    assert_eq!(h.emitted(), vec!["team-a".to_string()]);
    h.finish().await;
}

#[tokio::test]
async fn silence_longer_than_the_idle_limit_reconnects() {
    let s = Sse::default();
    s.push(Step::Send(vec!["id: 3\n\n"], true));
    let mut t = timing();
    t.idle = Duration::from_millis(300);
    let h = Harness::with(serve(s.clone()).await, t);
    until("a second connection", || s.conns() >= 2).await;
    let g = gaps(&s);
    assert!(g[0] >= Duration::from_millis(280), "{g:?}");
    assert_eq!(s.conns.lock().unwrap()[1].1.as_deref(), Some("3"));
    h.finish().await;
}

#[tokio::test]
async fn a_suspended_account_waits_the_long_wait() {
    let s = Sse::default();
    s.push(Step::Status(403, None));
    let h = Harness::start(serve(s.clone()).await);
    until("a second connection", || s.conns() >= 2).await;
    assert!(gaps(&s)[0] >= Duration::from_millis(580), "{:?}", gaps(&s));
    h.finish().await;
}

#[tokio::test]
async fn app_exit_stops_the_subscriber_and_closes_the_connection() {
    let s = Sse::default();
    let h = Harness::start(serve(s.clone()).await);
    until("a connection", || s.open_now() == 1).await;
    h.finish().await;
    until("the connection closed", || s.open_now() == 0).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(s.conns(), 1);
}

#[tokio::test]
async fn many_distinct_teams_become_one_every_team_announcement() {
    let s = Sse::default();
    let body: &'static str = Box::leak((0..100).map(|i| format!("id: {}\nevent: post\ndata: {{\"team\":\"t{i}\"}}\n\n", i + 1)).collect::<String>().into_boxed_str());
    s.push(Step::Send(vec![body], true));
    let h = Harness::start(serve(s.clone()).await);
    until("the every-team announcement", || h.emitted().iter().any(String::is_empty)).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let e = h.emitted();
    assert_eq!(e.len(), MAX_TEAMS_PER_WINDOW + 2, "64 teams, one every-team, one trailing every-team");
    assert_eq!(e[MAX_TEAMS_PER_WINDOW], "");
    assert_eq!(e[MAX_TEAMS_PER_WINDOW + 1], "");
    h.finish().await;
}

#[tokio::test]
async fn a_reset_without_an_id_starts_the_next_connection_at_the_head() {
    let s = Sse::default();
    s.push(Step::Send(vec!["id: 4\nevent: post\ndata: {\"team\":\"a\"}\n\nevent: reset\ndata: {}\n\n"], false));
    let h = Harness::start(serve(s.clone()).await);
    until("a second connection", || s.conns() >= 2).await;
    assert_eq!(s.conns.lock().unwrap()[1].1, None);
    h.finish().await;
}
