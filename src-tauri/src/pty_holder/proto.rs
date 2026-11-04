//! Holder wire protocol (docs/PTY_HOLDER_DAEMON.md 3.3).
//!
//! Frame: `[kind u8][handle u32 LE][len u32 LE][payload]`, payload at most 16 MiB.
//! Control frames carry compact JSON; INPUT/OUTPUT carry raw bytes. TAIL carries
//! `[json_len u32 LE][json {seq_start, dropped_bytes}][raw bytes]`.
//!
//! Byte order guarantee: for each terminal, the holder sends a client every output
//! byte exactly once, in order — either inside the TAIL that follows WELCOME or in
//! a later OUTPUT frame. The seq of an OUTPUT byte is therefore implicit (TAIL end
//! plus the OUTPUT bytes since), which is what the client dedupes against.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, Read};

pub const PROTOCOL_VERSION: u32 = 1;
/// Oldest holder protocol this app can still attach to (to recover and drain it).
/// Every version so far shares the frame format and payloads.
pub const MIN_ATTACH_VERSION: u32 = 1;
/// Debug builds only: pretend to speak this protocol version (app and the holders it
/// starts), to exercise the multi-holder update path without a second build.
pub const VERSION_OVERRIDE_ENV: &str = "BBARIT_PTY_HOLDER_PROTO_VERSION";

/// The protocol version this process speaks: `PROTOCOL_VERSION`, or in debug builds
/// `BBARIT_PTY_HOLDER_PROTO_VERSION` when it is a number >= 1.
pub fn protocol_version() -> u32 {
    version_from(cfg!(debug_assertions), std::env::var(VERSION_OVERRIDE_ENV).ok().as_deref())
}

fn version_from(debug_build: bool, value: Option<&str>) -> u32 {
    if !debug_build {
        return PROTOCOL_VERSION;
    }
    value
        .and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|v| *v >= 1)
        .unwrap_or(PROTOCOL_VERSION)
}

/// A live holder of `version` can be attached to for recovery (and drained) by an app
/// speaking `ours`: an older protocol we still understand.
pub fn can_attach_older(version: u32, ours: u32) -> bool {
    version >= MIN_ATTACH_VERSION && version < ours
}
pub const MAX_PAYLOAD: usize = 16 * 1024 * 1024;
pub const HEADER_LEN: usize = 9;
pub const CLIENT_NAME: &str = "bbarit-app";

// app → holder
pub const HELLO: u8 = 1;
pub const SPAWN: u8 = 3;
pub const INPUT: u8 = 6;
pub const RESIZE: u8 = 8;
pub const SIGNAL: u8 = 9;
pub const RELEASE: u8 = 10;
pub const GOODBYE: u8 = 13;
/// Refuse new SPAWNs and exit once the last terminal is released (idempotent; ACK).
pub const DRAIN: u8 = 14;
// holder → app
pub const WELCOME: u8 = 2;
pub const SPAWNED: u8 = 4;
pub const SPAWN_FAILED: u8 = 5;
pub const OUTPUT: u8 = 7;
pub const EXITED: u8 = 11;
pub const TAIL: u8 = 12;
/// The holder is dropping this client (a newer HELLO took over, or a bad HELLO).
pub const BYE: u8 = 17;
/// Reply to DRAIN (`Ack`). Holders before phase 3b do not send it: never wait for it.
pub const ACK: u8 = 18;
// both ways
pub const PING: u8 = 15;
pub const PONG: u8 = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub handle: u32,
    pub payload: Vec<u8>,
}

pub fn encode(kind: u8, handle: u32, payload: &[u8]) -> io::Result<Vec<u8>> {
    if payload.len() > MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("payload {} exceeds {MAX_PAYLOAD}", payload.len()),
        ));
    }
    let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
    out.push(kind);
    out.extend_from_slice(&handle.to_le_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

pub fn encode_json<T: Serialize>(kind: u8, handle: u32, value: &T) -> io::Result<Vec<u8>> {
    let json = serde_json::to_vec(value).map_err(io::Error::other)?;
    encode(kind, handle, &json)
}

/// Read one frame. EOF before the first header byte is `UnexpectedEof` like any other.
/// The length is checked before allocating, so a bad peer can't make us allocate 4 GiB.
pub fn read_frame(r: &mut impl Read) -> io::Result<Frame> {
    let mut header = [0u8; HEADER_LEN];
    r.read_exact(&mut header)?;
    let kind = header[0];
    let handle = u32::from_le_bytes([header[1], header[2], header[3], header[4]]);
    let len = u32::from_le_bytes([header[5], header[6], header[7], header[8]]) as usize;
    if len > MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame payload {len} exceeds {MAX_PAYLOAD}"),
        ));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok(Frame {
        kind,
        handle,
        payload,
    })
}

#[cfg(test)]
pub fn write_frame(
    w: &mut impl std::io::Write,
    kind: u8,
    handle: u32,
    payload: &[u8],
) -> io::Result<()> {
    w.write_all(&encode(kind, handle, payload)?)?;
    w.flush()
}

pub fn parse<T: for<'de> Deserialize<'de>>(frame: &Frame) -> io::Result<T> {
    serde_json::from_slice(&frame.payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

// ─── JSON payloads ───

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub version: u32,
    pub client: String,
    pub pid: u32,
    pub build: String,
}

impl Hello {
    #[cfg(test)]
    pub fn current() -> Self {
        Self::with_version(protocol_version())
    }

    /// HELLO in a given protocol version (an older holder being recovered and drained).
    pub fn with_version(version: u32) -> Self {
        Hello {
            version,
            client: CLIENT_NAME.to_string(),
            pid: std::process::id(),
            build: env!("CARGO_PKG_VERSION").to_string(),
        }
    }

    /// Holder-side gate: the holder's protocol version and our client name.
    pub fn check(&self, holder_version: u32) -> Result<(), String> {
        if self.version != holder_version {
            return Err(format!(
                "protocol version {} not supported (holder speaks {holder_version})",
                self.version
            ));
        }
        if self.client != CLIENT_NAME {
            return Err(format!("unknown client {:?}", self.client));
        }
        Ok(())
    }
}

/// DECSET state the holder tracked from the output stream, replayed before a TAIL
/// that may have been cut after the program enabled them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Modes {
    /// Currently set private modes among 47/1047/1049, 1000/1002/1003/1006, 2004 (sorted).
    pub decset: Vec<u16>,
    /// Current kitty keyboard (CSI-u) flags; 0 when none pushed.
    pub kitty_keyboard: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalEntry {
    pub handle: u32,
    pub id: String,
    pub cwd: Option<String>,
    pub pid: Option<u32>,
    pub rows: u16,
    pub cols: u16,
    pub exited: bool,
    pub exit_code: Option<u32>,
    pub scope: String,
    /// Unix ms.
    pub started_at: u64,
    /// Bytes evicted from the 1 MiB tail ring since spawn (== the TAIL's seq_start).
    pub dropped_bytes: u64,
    pub modes: Modes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Welcome {
    pub version: u32,
    pub instance: String,
    pub terminals: Vec<TerminalEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Spawn {
    pub id: String,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    /// The complete environment; the holder applies it after `env_clear()`.
    pub env: BTreeMap<String, String>,
    pub rows: u16,
    pub cols: u16,
    pub scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Spawned {
    pub id: String,
    pub handle: u32,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnFailed {
    pub id: String,
    pub error: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resize {
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signal {
    /// "TERM" | "KILL" | "HUP" | "INT"
    pub sig: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Exited {
    pub code: Option<u32>,
    pub signal: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Goodbye {
    /// "quit" | "handover" | "kill_all"
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bye {
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ack {
    /// The frame acknowledged: "DRAIN".
    pub of: String,
    /// Terminals the holder still has (it exits when this reaches 0 while draining).
    pub terminals: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TailHeader {
    /// Seq (stream byte offset) of the first tail byte.
    pub seq_start: u64,
    pub dropped_bytes: u64,
}

pub fn encode_tail(handle: u32, header: TailHeader, bytes: &[u8]) -> io::Result<Vec<u8>> {
    let json = serde_json::to_vec(&header).map_err(io::Error::other)?;
    let mut payload = Vec::with_capacity(4 + json.len() + bytes.len());
    payload.extend_from_slice(&(json.len() as u32).to_le_bytes());
    payload.extend_from_slice(&json);
    payload.extend_from_slice(bytes);
    encode(TAIL, handle, &payload)
}

pub fn decode_tail(payload: &[u8]) -> io::Result<(TailHeader, &[u8])> {
    let bad = |m: &str| io::Error::new(io::ErrorKind::InvalidData, m.to_string());
    if payload.len() < 4 {
        return Err(bad("TAIL too short"));
    }
    let json_len = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
    let rest = &payload[4..];
    if json_len > rest.len() {
        return Err(bad("TAIL header length out of range"));
    }
    let header: TailHeader = serde_json::from_slice(&rest[..json_len])
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok((header, &rest[json_len..]))
}

/// Contents of `<run>/pty-holder.<instance>.json`, written by the holder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HolderInfo {
    pub pid: u32,
    pub socket: String,
    pub version: u32,
    pub build: String,
    pub instance: String,
    /// "launchd" | "systemd" | "setsid" | "manual". Missing in files of 2a/2b holders.
    #[serde(rename = "spawnMethod", default, skip_serializing_if = "Option::is_none")]
    pub spawn_method: Option<String>,
    /// launchd job label (spawnMethod "launchd").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// systemd unit (spawnMethod "systemd").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip() {
        let mut wire = Vec::new();
        write_frame(&mut wire, OUTPUT, 7, b"hello\x00\xff").unwrap();
        let spawn = Spawn {
            id: "t1".into(),
            argv: vec!["/bin/sh".into(), "-c".into(), "echo hi".into()],
            cwd: Some("/tmp".into()),
            env: [("A".to_string(), "1".to_string())].into_iter().collect(),
            rows: 24,
            cols: 80,
            scope: "s".into(),
        };
        wire.extend(encode_json(SPAWN, 0, &spawn).unwrap());
        wire.extend(encode(PING, 0, &[]).unwrap());
        let mut r = &wire[..];
        assert_eq!(
            read_frame(&mut r).unwrap(),
            Frame {
                kind: OUTPUT,
                handle: 7,
                payload: b"hello\x00\xff".to_vec()
            }
        );
        let f = read_frame(&mut r).unwrap();
        assert_eq!(f.kind, SPAWN);
        assert_eq!(parse::<Spawn>(&f).unwrap(), spawn);
        assert_eq!(
            read_frame(&mut r).unwrap(),
            Frame {
                kind: PING,
                handle: 0,
                payload: vec![]
            }
        );
        assert_eq!(
            read_frame(&mut r).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn header_layout_is_kind_handle_len_le() {
        let f = encode(TAIL, 0x0102_0304, b"ab").unwrap();
        assert_eq!(f, vec![TAIL, 4, 3, 2, 1, 2, 0, 0, 0, b'a', b'b']);
    }

    #[test]
    fn payload_cap_is_enforced_both_ways() {
        let big = vec![0u8; MAX_PAYLOAD + 1];
        assert_eq!(
            encode(OUTPUT, 1, &big).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert!(encode(OUTPUT, 1, &big[..MAX_PAYLOAD]).is_ok());
        // A header claiming 16 MiB + 1 is rejected before any allocation/read of the body.
        let mut header = vec![OUTPUT, 1, 0, 0, 0];
        header.extend_from_slice(&((MAX_PAYLOAD as u32) + 1).to_le_bytes());
        let err = read_frame(&mut &header[..]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn hello_version_and_client_are_checked() {
        assert!(Hello::current().check(PROTOCOL_VERSION).is_ok());
        let mut bad = Hello::current();
        bad.version = 2;
        assert!(bad.check(PROTOCOL_VERSION).unwrap_err().contains("protocol version 2"));
        assert!(bad.check(2).is_ok(), "a v2 holder takes a v2 HELLO");
        assert_eq!(Hello::with_version(7).version, 7);
        let mut other = Hello::current();
        other.client = "someone".into();
        assert!(other.check(PROTOCOL_VERSION).is_err());
        // Round trip through a frame.
        let f = encode_json(HELLO, 0, &Hello::current()).unwrap();
        let back: Hello = parse(&read_frame(&mut &f[..]).unwrap()).unwrap();
        assert_eq!(back, Hello::current());
    }

    #[test]
    fn version_override_is_debug_only_and_sane() {
        assert_eq!(version_from(true, None), PROTOCOL_VERSION);
        assert_eq!(version_from(true, Some(" 2 ")), 2);
        assert_eq!(version_from(true, Some("0")), PROTOCOL_VERSION);
        assert_eq!(version_from(true, Some("x")), PROTOCOL_VERSION);
        assert_eq!(version_from(false, Some("2")), PROTOCOL_VERSION, "release ignores it");
        assert!(can_attach_older(1, 2));
        assert!(!can_attach_older(2, 2), "same version is the primary, not a legacy holder");
        assert!(!can_attach_older(3, 2), "a newer holder cannot be understood");
        assert!(!can_attach_older(0, 2));
    }

    #[test]
    fn ack_round_trip() {
        let f = encode_json(ACK, 0, &Ack { of: "DRAIN".into(), terminals: 2 }).unwrap();
        let frame = read_frame(&mut &f[..]).unwrap();
        assert_eq!(frame.kind, ACK);
        assert_eq!(parse::<Ack>(&frame).unwrap(), Ack { of: "DRAIN".into(), terminals: 2 });
    }

    #[test]
    fn tail_round_trip() {
        let h = TailHeader {
            seq_start: 1 << 33,
            dropped_bytes: 1 << 33,
        };
        let f = encode_tail(9, h, b"\x1b[?1049hxyz").unwrap();
        let frame = read_frame(&mut &f[..]).unwrap();
        assert_eq!((frame.kind, frame.handle), (TAIL, 9));
        let (back, bytes) = decode_tail(&frame.payload).unwrap();
        assert_eq!(back, h);
        assert_eq!(bytes, b"\x1b[?1049hxyz");
        assert!(decode_tail(&[1, 0]).is_err());
        assert!(decode_tail(&[200, 0, 0, 0, b'{']).is_err());
    }

    #[test]
    fn welcome_json_has_the_documented_fields() {
        let w = Welcome {
            version: 1,
            instance: "abc".into(),
            terminals: vec![TerminalEntry {
                handle: 1,
                id: "t".into(),
                cwd: None,
                pid: Some(5),
                rows: 24,
                cols: 80,
                exited: false,
                exit_code: None,
                scope: "s".into(),
                started_at: 1,
                dropped_bytes: 0,
                modes: Modes {
                    decset: vec![1049, 2004],
                    kitty_keyboard: 1,
                },
            }],
        };
        let v: serde_json::Value = serde_json::to_value(&w).unwrap();
        let t = &v["terminals"][0];
        for key in [
            "handle",
            "id",
            "cwd",
            "pid",
            "rows",
            "cols",
            "exited",
            "exit_code",
            "scope",
            "started_at",
            "dropped_bytes",
            "modes",
        ] {
            assert!(t.get(key).is_some(), "{key}");
        }
        assert_eq!(t["modes"]["decset"], serde_json::json!([1049, 2004]));
    }

    #[test]
    fn holder_info_spawn_fields_are_optional_and_camel_case() {
        // A 2a/2b holder's file has no spawn fields.
        let old = br#"{"pid":1,"socket":"/r/x.sock","version":1,"build":"1.0","instance":"ab"}"#;
        let info: HolderInfo = serde_json::from_slice(old).unwrap();
        assert_eq!((info.spawn_method, info.label, info.unit), (None, None, None));
        let info = HolderInfo {
            pid: 2,
            socket: "/r/y.sock".into(),
            version: 1,
            build: "1.0".into(),
            instance: "cd".into(),
            spawn_method: Some("launchd".into()),
            label: Some("com.bbarit.terminal.pty-holder.cd".into()),
            unit: None,
        };
        let v = serde_json::to_value(&info).unwrap();
        assert_eq!(v["spawnMethod"], "launchd");
        assert_eq!(v["label"], "com.bbarit.terminal.pty-holder.cd");
        assert!(v.get("unit").is_none() && v.get("spawn_method").is_none(), "{v}");
        assert_eq!(serde_json::from_value::<HolderInfo>(v).unwrap(), info);
    }
}
