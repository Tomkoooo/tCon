//! Dev-server URL detection in terminal output ("Local: http://localhost:5173/").
//!
//! Fed from the PTY reader thread, so it must stay cheap: a byte scan for "://" gates the
//! (rare) slow path, which strips ANSI escapes and extracts loopback http(s) URLs.

use std::collections::HashSet;

/// Per-pane scanner: keeps a short tail so a URL split across two reads is still found,
/// and remembers what it already reported.
#[derive(Default)]
pub struct DevUrlScanner {
    tail: Vec<u8>,
    seen: HashSet<String>,
}

const TAIL: usize = 160;

impl DevUrlScanner {
    /// Returns URLs seen for the first time in this chunk.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut found = Vec::new();
        let has = |b: &[u8]| b.windows(3).any(|w| w == b"://");
        let boundary = [&self.tail[self.tail.len().saturating_sub(2)..], &chunk[..chunk.len().min(2)]].concat();
        if has(chunk) || has(&self.tail) || has(&boundary) {
            let mut buf = Vec::with_capacity(self.tail.len() + chunk.len());
            buf.extend_from_slice(&self.tail);
            buf.extend_from_slice(chunk);
            let text = String::from_utf8_lossy(&buf);
            for url in find_dev_urls(&strip_ansi(&text)) {
                if self.seen.insert(url.clone()) {
                    found.push(url);
                }
            }
        }
        // keep the end of this chunk for the next call
        let keep = chunk.len().min(TAIL);
        if keep == TAIL {
            self.tail.clear();
        } else {
            let excess = (self.tail.len() + keep).saturating_sub(TAIL);
            self.tail.drain(..excess);
        }
        self.tail.extend_from_slice(&chunk[chunk.len() - keep..]);
        found
    }
}

/// Remove CSI / OSC escape sequences (colors, hyperlinks, cursor moves).
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match it.peek() {
            Some('[') => {
                it.next();
                // parameters / intermediates, then one final byte in 0x40..=0x7e
                for c in it.by_ref() {
                    if ('\x40'..='\x7e').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                it.next();
                // until BEL or ST (ESC \)
                while let Some(c) = it.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' && it.peek() == Some(&'\\') {
                        it.next();
                        break;
                    }
                }
            }
            Some(_) => {
                it.next();
            }
            None => {}
        }
    }
    out
}

fn is_loopback_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    h == "localhost" || h.ends_with(".localhost") || h == "127.0.0.1" || h == "0.0.0.0" || h == "[::1]" || h == "[::]"
}

/// Loopback http(s) URLs in plain text, normalized (0.0.0.0 / [::] → localhost, no trailing "/").
pub fn find_dev_urls(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while let Some(off) = text[i..].find("://") {
        let at = i + off;
        i = at + 3;
        let scheme_start = text[..at].rfind(|c: char| !c.is_ascii_alphabetic()).map(|p| p + 1).unwrap_or(0);
        let scheme = text[scheme_start..at].to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            continue;
        }
        let mut end = at + 3;
        let mut bracket = false; // inside an IPv6 "[...]" host
        while end < bytes.len() {
            let c = bytes[end];
            if c == b'[' && end == at + 3 {
                bracket = true;
            } else if c == b']' && bracket {
                bracket = false;
                end += 1;
                continue;
            }
            if c.is_ascii_whitespace() || b"\"'<>`|)]},".contains(&c) || c >= 0x80 || c < 0x20 {
                break;
            }
            end += 1;
        }
        let raw = text[scheme_start..end].trim_end_matches(['.', ',', ';', ':']);
        let rest = &raw[scheme.len() + 3..];
        let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let authority = &rest[..authority_end];
        if authority.contains('@') {
            continue;
        }
        let (host, port) = if authority.starts_with('[') {
            match authority.find(']') {
                Some(p) => (&authority[..=p], authority[p + 1..].strip_prefix(':')),
                None => continue,
            }
        } else {
            match authority.rsplit_once(':') {
                Some((h, p)) => (h, Some(p)),
                None => (authority, None),
            }
        };
        if !is_loopback_host(host) {
            continue;
        }
        if let Some(p) = port {
            if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) || p.parse::<u32>().map_or(true, |n| n == 0 || n > 65535) {
                continue;
            }
        }
        let host_norm = match host {
            "0.0.0.0" | "[::]" => "localhost".to_string(),
            h => h.to_ascii_lowercase(),
        };
        let path = &rest[authority_end..];
        let mut url = format!("{scheme}://{host_norm}{}{}", port.map(|p| format!(":{p}")).unwrap_or_default(), path);
        if url.ends_with('/') && path == "/" {
            url.pop();
        }
        if !out.contains(&url) {
            out.push(url);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vite_banner_with_colors() {
        let s = "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n  ➜  Network: http://192.168.1.5:5173/\r\n";
        assert_eq!(find_dev_urls(&strip_ansi(s)), vec!["http://localhost:5173"]);
    }

    #[test]
    fn next_and_others() {
        let s = "- Local:        http://localhost:3000\n ready on 0.0.0.0:8080, url: http://0.0.0.0:8080/app.\nhttps://127.0.0.1:8443/x?y=1 (https)";
        assert_eq!(
            find_dev_urls(s),
            vec!["http://localhost:3000", "http://localhost:8080/app", "https://127.0.0.1:8443/x?y=1"]
        );
    }

    #[test]
    fn ignores_remote_and_bad_ports() {
        let s = "see https://example.com:443/ and http://localhost:99999 and ftp://localhost:21 and http://user@localhost:1/";
        assert!(find_dev_urls(s).is_empty());
    }

    #[test]
    fn ipv6_and_osc8_links() {
        let s = "\x1b]8;;http://[::1]:4000\x07http://[::1]:4000\x1b]8;;\x07";
        assert_eq!(find_dev_urls(&strip_ansi(s)), vec!["http://[::1]:4000"]);
    }

    #[test]
    fn scanner_splits_and_dedupes() {
        let mut sc = DevUrlScanner::default();
        assert!(sc.feed(b"Local: http://local").is_empty());
        assert_eq!(sc.feed(b"host:5173/\n"), vec!["http://localhost:5173"]);
        assert!(sc.feed(b"again http://localhost:5173/\n").is_empty());
        assert!(sc.feed(&vec![b'x'; 70_000]).is_empty());
    }
}
