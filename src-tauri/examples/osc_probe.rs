//! Manual check: run `claude` in a PTY, answer the OSC 7501 probe, print status events.
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::time::{Duration, Instant};
use tcon_lib::osc::{OscEvent, OscFilter, PROBE_REPLY};

fn main() {
    let pair = native_pty_system().openpty(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 }).unwrap();
    let mut cmd = CommandBuilder::new(std::env::args().nth(1).unwrap_or("claude".into()));
    cmd.cwd(std::env::current_dir().unwrap());
    cmd.env("TERM", "xterm-256color");
    cmd.env("TERM_PROGRAM", "tCon");
    cmd.env_remove("CLAUDECODE");
    let mut child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let writer = std::sync::Arc::new(std::sync::Mutex::new(pair.master.take_writer().unwrap()));
    let w2 = writer.clone();
    let start = Instant::now();
    std::thread::spawn(move || {
        let mut f = OscFilter::new();
        let mut buf = [0u8; 65536];
        let mut ev = Vec::new();
        let mut total = 0usize;
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 { break; }
            total += n;
            // Answer DA1 too (xterm.js would), since Claude uses it as a probe sentinel.
            if buf[..n].windows(3).any(|w| w == b"\x1b[c") {
                let _ = w2.lock().unwrap().write_all(b"\x1b[?62;22c");
            }
            ev.clear();
            f.feed(&buf[..n], &mut ev);
            for e in ev.drain(..) {
                if e == OscEvent::Probe { let _ = w2.lock().unwrap().write_all(PROBE_REPLY); }
                println!("[{:>5}ms] {:?}", start.elapsed().as_millis(), e);
            }
        }
        println!("reader done, {total} bytes");
    });
    std::thread::sleep(Duration::from_secs(12));
    let _ = writer.lock().unwrap().write_all(b"say only the word pong\r");
    std::thread::sleep(Duration::from_secs(25));
    let _ = child.kill();
}
