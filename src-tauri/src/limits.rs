//! Spots Claude Code's usage-limit message in a terminal's output ("Claude usage limit
//! reached", "5-hour limit reached ∙ resets 3pm", the older "…|1735689600" form) so tCon can
//! pause the task queue and resume the agent after the reset.
use chrono::{DateTime, Local, NaiveTime, TimeZone};
use serde::Serialize;

use crate::browser::devurl::strip_ansi;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimitHit {
    /// The message line as shown.
    pub message: String,
    /// When the limit resets (unix seconds), if the message says.
    pub reset_at: Option<i64>,
}

const TAIL: usize = 400;
const MIN_GAP_SECS: i64 = 120;

#[derive(Default)]
pub struct LimitScanner {
    tail: String,
    last_hit: Option<i64>,
}

impl LimitScanner {
    /// Returns a hit at most once per couple of minutes per terminal.
    pub fn feed(&mut self, chunk: &[u8]) -> Option<LimitHit> {
        let text = String::from_utf8_lossy(chunk);
        let mut buf = std::mem::take(&mut self.tail);
        buf.push_str(&text);
        // Cheap pre-check (the tail is short), also catching a word split across reads.
        let relevant = buf.to_ascii_lowercase().contains("limit");
        let hit = if relevant { detect(&strip_ansi(&buf), Local::now()) } else { None };
        // Keep the end for messages split across reads.
        let cut = buf.len().saturating_sub(TAIL);
        let cut = (cut..buf.len()).find(|&i| buf.is_char_boundary(i)).unwrap_or(buf.len());
        self.tail = buf[cut..].to_string();
        let hit = hit?;
        let now = Local::now().timestamp();
        if self.last_hit.is_some_and(|t| now - t < MIN_GAP_SECS) {
            return None;
        }
        self.last_hit = Some(now);
        self.tail.clear();
        Some(hit)
    }
}

/// Find a usage-limit message in plain text.
pub fn detect(text: &str, now: DateTime<Local>) -> Option<LimitHit> {
    let line = text.lines().rev().find(|l| {
        let l = l.to_ascii_lowercase();
        (l.contains("usage limit") || l.contains("hour limit") || l.contains("weekly limit") || l.contains("limit reached"))
            && (l.contains("reach") || l.contains("reset") || l.contains('|'))
    })?;
    let message = line.trim().trim_start_matches(['⎿', '•', '∙', '│', ' ']).trim().to_string();
    Some(LimitHit { reset_at: reset_time(&message, now), message })
}

/// "…|1735689600", "resets 3pm", "resets at 3:30 PM", "reset at 15:00" → the next such moment.
pub fn reset_time(msg: &str, now: DateTime<Local>) -> Option<i64> {
    if let Some((_, rest)) = msg.rsplit_once('|') {
        if let Ok(ts) = rest.trim().parse::<i64>() {
            return Some(ts);
        }
    }
    let lower = msg.to_ascii_lowercase();
    let at = lower.find("reset")?;
    let after = &lower[at..];
    // first token that looks like a time
    for raw in after.split(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == ',' || c == '.').skip(1) {
        let tok = raw.trim();
        if tok.is_empty() || tok == "at" || tok == "s" {
            continue;
        }
        if let Some(t) = parse_clock(tok, after) {
            let today = now.date_naive().and_time(t);
            let mut when = Local.from_local_datetime(&today).single()?;
            if when <= now {
                when += chrono::Duration::days(1);
            }
            return Some(when.timestamp());
        }
    }
    None
}

fn parse_clock(tok: &str, context: &str) -> Option<NaiveTime> {
    let (num, mut pm, mut am) = (tok.trim_end_matches("am").trim_end_matches("pm"), tok.ends_with("pm"), tok.ends_with("am"));
    if !pm && !am {
        // "3 pm" split into two tokens
        let rest = context.split_once(tok).map(|x| x.1.trim_start()).unwrap_or("");
        pm = rest.starts_with("pm");
        am = rest.starts_with("am");
    }
    let (h, m) = match num.split_once(':') {
        Some((h, m)) => (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?),
        None => (num.parse::<u32>().ok()?, 0),
    };
    if !(pm || am || num.contains(':')) {
        return None;
    }
    let h = match (pm, am, h) {
        (true, _, 12) => 12,
        (true, _, h) => h + 12,
        (_, true, 12) => 0,
        (_, _, h) => h,
    };
    NaiveTime::from_hms_opt(h, m, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(h: u32, m: u32) -> DateTime<Local> {
        Local.from_local_datetime(&chrono::NaiveDate::from_ymd_opt(2026, 11, 27).unwrap().and_hms_opt(h, m, 0).unwrap()).single().unwrap()
    }

    #[test]
    fn detects_messages() {
        let now = at(13, 0);
        let h = detect("  ⎿  5-hour limit reached ∙ resets 3pm (Europe/Budapest)\n> ", now).unwrap();
        assert!(h.message.starts_with("5-hour limit reached"));
        assert_eq!(h.reset_at, Some(at(15, 0).timestamp()));
        let h = detect("Claude usage limit reached. Your limit will reset at 3:30 PM.", now).unwrap();
        assert_eq!(h.reset_at, Some(at(15, 30).timestamp()));
        let h = detect("Claude AI usage limit reached|1735689600", now).unwrap();
        assert_eq!(h.reset_at, Some(1735689600));
        // Earlier today → tomorrow.
        assert_eq!(detect("usage limit reached, resets 9am", now).unwrap().reset_at, Some(at(9, 0).timestamp() + 86400));
        assert!(detect("rate limiting middleware added", now).is_none());
        assert!(detect("no limits here", now).is_none());
    }

    #[test]
    fn scanner_joins_split_chunks_and_throttles() {
        let mut s = LimitScanner::default();
        assert!(s.feed(b"\x1b[31mClaude usage li").is_none());
        assert!(s.feed(b"mit reached, resets 3pm\r\n").is_some());
        assert!(s.feed(b"Claude usage limit reached, resets 3pm\r\n").is_none());
    }
}
