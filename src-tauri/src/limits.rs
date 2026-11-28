//! Spots Claude Code's usage-limit message in a terminal's output ("Claude usage limit
//! reached", "5-hour limit reached ∙ resets 3pm", the older "…|1735689600" form) so tCon can
//! pause the task queue and resume the agent after the reset. It also picks up the usage
//! warnings Claude Code prints before that ("You've used 90% of your weekly limit ∙ resets…",
//! "Approaching usage limit"), which is the only usage figure tCon sees: reading the account's
//! OAuth token to ask the API would mean touching Claude's credentials (see SECURITY.md).
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

/// A usage warning before the limit: "You've used 90% of your weekly limit ∙ resets Oct 9 at 1pm".
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageNote {
    pub message: String,
    /// Percent of the limit used, when the message says ("Approaching usage limit" doesn't).
    pub percent: Option<u8>,
    pub reset_at: Option<i64>,
}

/// What one chunk of output revealed.
#[derive(Default, Debug)]
pub struct Scan {
    pub hit: Option<LimitHit>,
    pub usage: Option<UsageNote>,
}

const TAIL: usize = 400;
const MIN_GAP_SECS: i64 = 120;
/// The TUI redraws the same warning often; repeat an unchanged one only this rarely.
const USAGE_REPEAT_SECS: i64 = 600;

#[derive(Default)]
pub struct LimitScanner {
    tail: String,
    last_hit: Option<i64>,
    last_usage: Option<(String, i64)>,
}

impl LimitScanner {
    /// Returns a hit at most once per couple of minutes per terminal, and a usage warning
    /// when it's new or changed.
    pub fn feed(&mut self, chunk: &[u8]) -> Scan {
        let text = String::from_utf8_lossy(chunk);
        let mut buf = std::mem::take(&mut self.tail);
        buf.push_str(&text);
        // Cheap pre-check (the tail is short), also catching a word split across reads.
        let relevant = buf.to_ascii_lowercase().contains("limit");
        let now_dt = Local::now();
        let plain = if relevant { strip_ansi(&buf) } else { String::new() };
        let hit = if relevant { detect(&plain, now_dt) } else { None };
        let usage = if relevant && hit.is_none() { detect_usage(&plain, now_dt) } else { None };
        // Keep the end for messages split across reads.
        let cut = buf.len().saturating_sub(TAIL);
        let cut = (cut..buf.len()).find(|&i| buf.is_char_boundary(i)).unwrap_or(buf.len());
        self.tail = buf[cut..].to_string();
        let now = now_dt.timestamp();
        let mut scan = Scan::default();
        if let Some(u) = usage {
            let repeat = self.last_usage.as_ref().is_some_and(|(m, t)| *m == u.message && now - t < USAGE_REPEAT_SECS);
            if !repeat {
                self.last_usage = Some((u.message.clone(), now));
                scan.usage = Some(u);
            }
        }
        let Some(hit) = hit else { return scan };
        if self.last_hit.is_some_and(|t| now - t < MIN_GAP_SECS) {
            return scan;
        }
        self.last_hit = Some(now);
        self.tail.clear();
        scan.hit = Some(hit);
        scan
    }
}

/// Find a usage warning ("used 85% of your 5-hour limit", "Approaching usage limit") in plain text.
pub fn detect_usage(text: &str, now: DateTime<Local>) -> Option<UsageNote> {
    let line = text.lines().rev().find(|l| {
        let l = l.to_ascii_lowercase();
        l.contains("limit")
            && (l.contains("% of your") || l.contains("approaching"))
            && ["usage", "hour", "weekly", "session", "opus", "sonnet"].iter().any(|w| l.contains(w))
    })?;
    let message = line.trim().trim_start_matches(['⎿', '•', '∙', '│', ' ']).trim().to_string();
    let percent = message.find('%').and_then(|i| {
        let digits: String = message[..i].chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
        digits.parse::<u32>().ok().filter(|p| *p <= 100).map(|p| p as u8)
    });
    Some(UsageNote { reset_at: reset_time(&message, now), percent, message })
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
            if let Some(date) = month_day(after, now) {
                return Local.from_local_datetime(&date.and_time(t)).single().map(|w| w.timestamp());
            }
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

/// "resets oct 9 at 1pm" → Oct 9 of this year (next year if that's already past).
fn month_day(after: &str, now: DateTime<Local>) -> Option<chrono::NaiveDate> {
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let toks: Vec<&str> = after.split(|c: char| c.is_whitespace() || c == ',').filter(|t| !t.is_empty()).collect();
    for w in toks.windows(2) {
        let Some(m) = MONTHS.iter().position(|m| w[0].starts_with(m)) else { continue };
        let Ok(d) = w[1].trim_end_matches(|c: char| !c.is_ascii_digit()).parse::<u32>() else { continue };
        use chrono::Datelike;
        let mut date = chrono::NaiveDate::from_ymd_opt(now.year(), m as u32 + 1, d)?;
        if date < now.date_naive() {
            date = chrono::NaiveDate::from_ymd_opt(now.year() + 1, m as u32 + 1, d)?;
        }
        return Some(date);
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
        let h = detect("Weekly limit reached ∙ resets Dec 1 at 1pm", now).unwrap();
        let dec1 = Local.from_local_datetime(&chrono::NaiveDate::from_ymd_opt(2026, 12, 1).unwrap().and_hms_opt(13, 0, 0).unwrap()).single().unwrap();
        assert_eq!(h.reset_at, Some(dec1.timestamp()));
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
        assert!(s.feed(b"\x1b[31mClaude usage li").hit.is_none());
        assert!(s.feed(b"mit reached, resets 3pm\r\n").hit.is_some());
        assert!(s.feed(b"Claude usage limit reached, resets 3pm\r\n").hit.is_none());
    }

    #[test]
    fn detects_usage_warnings() {
        let now = at(13, 0);
        let u = detect_usage("  ⎿ You've used 85% of your 5-hour limit ∙ resets 3pm\n", now).unwrap();
        assert_eq!(u.percent, Some(85));
        assert_eq!(u.reset_at, Some(at(15, 0).timestamp()));
        let u = detect_usage("Approaching usage limit · resets at 10pm", now).unwrap();
        assert_eq!(u.percent, None);
        assert_eq!(u.reset_at, Some(at(22, 0).timestamp()));
        let u = detect_usage("You've used 92% of your weekly limit · resets Dec 1 at 1pm", now).unwrap();
        let dec1 = Local.from_local_datetime(&chrono::NaiveDate::from_ymd_opt(2026, 12, 1).unwrap().and_hms_opt(13, 0, 0).unwrap()).single().unwrap();
        assert_eq!(u.reset_at, Some(dec1.timestamp()));
        assert!(detect_usage("memory usage at 85% of the container limit", now).is_none());
        assert!(detect_usage("we hit 50% coverage", now).is_none());
    }

    #[test]
    fn scanner_reports_changed_usage_once() {
        let mut s = LimitScanner::default();
        assert_eq!(s.feed(b"You've used 80% of your weekly limit\r\n").usage.and_then(|u| u.percent), Some(80));
        assert!(s.feed(b"redraw\r\n").usage.is_none());
        assert_eq!(s.feed(b"You've used 90% of your weekly limit\r\n").usage.and_then(|u| u.percent), Some(90));
    }
}
