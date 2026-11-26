//! Streaming OSC interceptor for PTY output.
//!
//! * OSC 7501 (Program Status Protocol, emitted by Claude Code) is stripped from
//!   the stream and turned into [`OscEvent`]s.
//! * OSC 7 (current working directory) is observed and passed through.
//! * Every other byte is passed through untouched.
//!
//! Wire format (verified against Claude Code 2.1.332):
//!   probe:  ESC ] 7501 ; ?                                   (BEL | ESC \)
//!   status: ESC ] 7501 ; state=<s>:app=claude-code[:id=..][:kind=..][:progress=N]
//!                        [:title=<base64>][:msg=<base64>]    (BEL | ESC \)
//!   clear:  ESC ] 7501 ; state=clear[:id=..]
//! The terminal must answer the probe with `ESC ] 7501 ; ? ST`, otherwise Claude
//! Code never emits status.

use base64::Engine;
use serde::Serialize;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const MAX_OSC: usize = 16 * 1024;

/// Reply written back to the PTY when the program probes for OSC 7501 support.
pub const PROBE_REPLY: &[u8] = b"\x1b]7501;?\x1b\\";

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProgramStatus {
    /// idle | working | blocked | done | error | clear
    pub state: String,
    pub app: Option<String>,
    pub id: Option<String>,
    /// For blocked: permission | question | auth
    pub kind: Option<String>,
    pub progress: Option<u8>,
    pub title: Option<String>,
    pub msg: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OscEvent {
    Probe,
    Status(ProgramStatus),
    Cwd(String),
}

#[derive(Debug)]
enum State {
    Normal,
    Esc,
    Osc,
    OscEsc,
}

pub struct OscFilter {
    state: State,
    buf: Vec<u8>,
}

impl Default for OscFilter {
    fn default() -> Self {
        Self::new()
    }
}

impl OscFilter {
    pub fn new() -> Self {
        Self { state: State::Normal, buf: Vec::new() }
    }

    /// Feed a chunk; returns the bytes to forward to the terminal renderer.
    pub fn feed(&mut self, input: &[u8], events: &mut Vec<OscEvent>) -> Vec<u8> {
        let mut out = Vec::with_capacity(input.len());
        let mut i = 0;
        while i < input.len() {
            let b = input[i];
            match self.state {
                State::Normal => {
                    // fast path: copy everything up to the next ESC
                    match input[i..].iter().position(|&c| c == ESC) {
                        Some(0) => self.state = State::Esc,
                        Some(n) => {
                            out.extend_from_slice(&input[i..i + n]);
                            i += n;
                            continue;
                        }
                        None => {
                            out.extend_from_slice(&input[i..]);
                            break;
                        }
                    }
                }
                State::Esc => {
                    if b == b']' {
                        self.state = State::Osc;
                        self.buf.clear();
                    } else {
                        out.push(ESC);
                        if b == ESC {
                            // stay in Esc
                        } else {
                            out.push(b);
                            self.state = State::Normal;
                        }
                    }
                }
                State::Osc => {
                    if b == BEL {
                        self.finish(&[BEL], &mut out, events);
                    } else if b == ESC {
                        self.state = State::OscEsc;
                    } else if b == 0x18 || b == 0x1a {
                        // CAN / SUB abort the sequence
                        out.extend_from_slice(b"\x1b]");
                        out.extend_from_slice(&self.buf);
                        out.push(b);
                        self.buf.clear();
                        self.state = State::Normal;
                    } else {
                        self.buf.push(b);
                        if self.buf.len() > MAX_OSC {
                            out.extend_from_slice(b"\x1b]");
                            out.append(&mut self.buf);
                            self.state = State::Normal;
                        }
                    }
                }
                State::OscEsc => {
                    if b == b'\\' {
                        self.finish(b"\x1b\\", &mut out, events);
                    } else {
                        // Malformed: pass the partial OSC through and reprocess.
                        out.extend_from_slice(b"\x1b]");
                        out.append(&mut self.buf);
                        self.state = State::Esc;
                        continue;
                    }
                }
            }
            i += 1;
        }
        out
    }

    fn finish(&mut self, term: &[u8], out: &mut Vec<u8>, events: &mut Vec<OscEvent>) {
        self.state = State::Normal;
        let buf = std::mem::take(&mut self.buf);
        if let Some(payload) = buf.strip_prefix(b"7501;") {
            if payload.first() == Some(&b'?') {
                events.push(OscEvent::Probe);
            } else if let Some(st) = parse_status(payload) {
                events.push(OscEvent::Status(st));
            }
            return; // swallowed
        }
        if let Some(url) = buf.strip_prefix(b"7;") {
            if let Some(path) = parse_osc7(url) {
                events.push(OscEvent::Cwd(path));
            }
        }
        out.extend_from_slice(b"\x1b]");
        out.extend_from_slice(&buf);
        out.extend_from_slice(term);
    }
}

fn b64(s: &str) -> Option<String> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .ok()
        .and_then(|v| String::from_utf8(v).ok())
}

pub fn parse_status(payload: &[u8]) -> Option<ProgramStatus> {
    let text = std::str::from_utf8(payload).ok()?;
    let mut st = ProgramStatus::default();
    for field in text.split(':') {
        let (k, v) = field.split_once('=').unwrap_or((field, ""));
        match k {
            "state" => st.state = v.to_string(),
            "app" => st.app = Some(v.to_string()),
            "id" => st.id = Some(v.to_string()),
            "kind" => st.kind = Some(v.to_string()),
            "progress" => st.progress = v.parse::<u32>().ok().map(|p| p.min(100) as u8),
            "title" => st.title = b64(v),
            "msg" => st.msg = b64(v),
            _ => {}
        }
    }
    if st.state.is_empty() { None } else { Some(st) }
}

fn parse_osc7(url: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(url).ok()?;
    let rest = s.strip_prefix("file://")?;
    let path = &rest[rest.find('/')?..];
    Some(percent_decode(path))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[&[u8]]) -> (Vec<u8>, Vec<OscEvent>) {
        let mut f = OscFilter::new();
        let mut ev = Vec::new();
        let mut out = Vec::new();
        for c in chunks {
            out.extend(f.feed(c, &mut ev));
        }
        (out, ev)
    }

    #[test]
    fn passthrough() {
        let (o, e) = run(&[b"hello \x1b[31mred\x1b[0m"]);
        assert_eq!(o, b"hello \x1b[31mred\x1b[0m");
        assert!(e.is_empty());
    }

    #[test]
    fn probe_stripped() {
        let (o, e) = run(&[b"a\x1b]7501;?\x1b\\b"]);
        assert_eq!(o, b"ab");
        assert_eq!(e, vec![OscEvent::Probe]);
    }

    #[test]
    fn status_split_across_chunks() {
        let msg = base64::engine::general_purpose::STANDARD.encode("Allow edit?");
        let full = format!("x\x1b]7501;state=blocked:app=claude-code:kind=permission:progress=40:msg={msg}\x07y");
        let bytes = full.as_bytes();
        let (o, e) = run(&[&bytes[..5], &bytes[5..20], &bytes[20..]]);
        assert_eq!(o, b"xy");
        match &e[0] {
            OscEvent::Status(s) => {
                assert_eq!(s.state, "blocked");
                assert_eq!(s.kind.as_deref(), Some("permission"));
                assert_eq!(s.progress, Some(40));
                assert_eq!(s.msg.as_deref(), Some("Allow edit?"));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn other_osc_passthrough_and_cwd() {
        let (o, e) = run(&[b"\x1b]0;title\x07\x1b]7;file://host/Users/me/my%20dir\x1b\\"]);
        assert_eq!(o, b"\x1b]0;title\x07\x1b]7;file://host/Users/me/my%20dir\x1b\\");
        assert_eq!(e, vec![OscEvent::Cwd("/Users/me/my dir".into())]);
    }

    #[test]
    fn esc_at_chunk_end() {
        let (o, _) = run(&[b"ab\x1b", b"[0m"]);
        assert_eq!(o, b"ab\x1b[0m");
    }
}
