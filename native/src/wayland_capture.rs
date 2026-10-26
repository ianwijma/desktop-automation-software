//! One persistent, restricted PipeWire/GStreamer consumer per portal grant.
//! PNGs stay in bounded memory, never in public temporary files.
use super::*;
use std::{
    io::Read,
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::process::CommandExt,
    },
    process::Child,
    sync::Condvar,
    time::Instant,
};
const MAX_PNG: usize = 64 * 1024 * 1024;
#[derive(Clone)]
pub struct Frame {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub at: u128,
    pub sequence: u64,
}
#[derive(Default)]
struct Latest {
    frame: Option<Frame>,
    lost: bool,
}
pub struct CaptureStream {
    child: Arc<Mutex<Option<Child>>>,
    latest: Arc<(Mutex<Latest>, Condvar)>,
    reader: Option<thread::JoinHandle<()>>,
    _fd: Option<OwnedFd>,
}
fn read_png(reader: &mut impl Read) -> Result<(Vec<u8>, u32, u32)> {
    let mut signature = [0; 8];
    reader
        .read_exact(&mut signature)
        .map_err(|_| "wayland:CAPTURE_LOST")?;
    if &signature != b"\x89PNG\r\n\x1a\n" {
        return Err("wayland:CAPTURE_LOST".into());
    }
    let mut png = signature.to_vec();
    let mut dimensions = None;
    loop {
        let mut header = [0; 8];
        reader
            .read_exact(&mut header)
            .map_err(|_| "wayland:CAPTURE_LOST")?;
        let len = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        if len > MAX_PNG
            || png
                .len()
                .checked_add(len + 12)
                .filter(|v| *v <= MAX_PNG)
                .is_none()
        {
            return Err("wayland:CAPTURE_LOST".into());
        }
        let start = png.len();
        png.extend_from_slice(&header);
        png.resize(start + 12 + len, 0);
        reader
            .read_exact(&mut png[start + 8..])
            .map_err(|_| "wayland:CAPTURE_LOST")?;
        if dimensions.is_none() {
            if &header[4..] != b"IHDR" || len != 13 {
                return Err("wayland:CAPTURE_LOST".into());
            }
            let w = u32::from_be_bytes(png[start + 8..start + 12].try_into().unwrap());
            let h = u32::from_be_bytes(png[start + 12..start + 16].try_into().unwrap());
            if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 40_000_000 {
                return Err("wayland:CAPTURE_LOST".into());
            }
            dimensions = Some((w, h));
        }
        if &header[4..] == b"IEND" {
            if len != 0 {
                return Err("wayland:CAPTURE_LOST".into());
            }
            let (w, h) = dimensions.unwrap();
            return Ok((png, w, h));
        }
    }
}
impl CaptureStream {
    pub fn available() -> bool {
        [
            "pipewiresrc",
            "videorate",
            "videoconvert",
            "pngenc",
            "fdsink",
        ]
        .iter()
        .all(|p| run("gst-inspect-1.0", &[p]).is_ok())
    }
    pub fn start(
        fd: OwnedFd,
        node: u32,
        serial: Option<u64>,
        closed: Arc<AtomicBool>,
    ) -> Result<Self> {
        let raw = fd.as_raw_fd();
        let mut command = Command::new("gst-launch-1.0");
        let target = serial
            .map(|v| format!("target-object={v}"))
            .unwrap_or_else(|| format!("path={node}"));
        command.args([
            "-q",
            "pipewiresrc",
            "fd=3",
            &target,
            "resend-last=false",
            "max-buffers=3",
            "do-timestamp=true",
            "!",
            "videorate",
            "drop-only=true",
            "!",
            "video/x-raw,framerate=15/1",
            "!",
            "videoconvert",
            "!",
            "pngenc",
            "!",
            "fdsink",
            "fd=1",
            "sync=false",
        ]);
        unsafe {
            command.pre_exec(move || {
                // Preserve only the restricted PipeWire connection across exec.
                if (raw != 3 && libc::dup2(raw, 3) < 0) || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Self::spawn(command, Some(fd), Some(closed))
    }
    fn spawn(
        mut command: Command,
        fd: Option<OwnedFd>,
        closed: Option<Arc<AtomicBool>>,
    ) -> Result<Self> {
        let parent = std::process::id() as libc::pid_t;
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0
                    || libc::getppid() != parent
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut process = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "wayland:MEDIA_REQUIRED")?;
        let mut stdout = process.stdout.take().ok_or("wayland:CAPTURE_LOST")?;
        let latest = Arc::new((Mutex::new(Latest::default()), Condvar::new()));
        let shared = latest.clone();
        let reader = thread::spawn(move || {
            let mut sequence = 0;
            loop {
                let result = read_png(&mut stdout);
                let (lock, ready) = &*shared;
                let mut state = lock.lock().unwrap();
                match result {
                    Ok((png, width, height)) => {
                        sequence += 1;
                        state.frame = Some(Frame {
                            png,
                            width,
                            height,
                            at: now(),
                            sequence,
                        });
                    }
                    Err(_) => {
                        state.frame = None;
                        state.lost = true;
                        if let Some(closed) = &closed {
                            closed.store(true, Ordering::SeqCst);
                        }
                        ready.notify_all();
                        break;
                    }
                }
                ready.notify_all();
            }
        });
        Ok(Self {
            child: Arc::new(Mutex::new(Some(process))),
            latest,
            reader: Some(reader),
            _fd: fd,
        })
    }
    #[cfg(test)]
    pub(crate) fn test_source() -> Result<Self> {
        let mut command = Command::new("gst-launch-1.0");
        command.args([
            "-q",
            "videotestsrc",
            "is-live=true",
            "!",
            "video/x-raw,width=160,height=100,framerate=10/1",
            "!",
            "pngenc",
            "!",
            "fdsink",
            "fd=1",
            "sync=false",
        ]);
        Self::spawn(command, None, None)
    }
    pub fn killer(&self) -> Arc<Mutex<Option<Child>>> {
        self.child.clone()
    }
    pub fn frame(&self, cancelled: impl Fn() -> bool) -> Result<Frame> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let (lock, ready) = &*self.latest;
        let mut state = lock.lock().map_err(|_| "wayland:CAPTURE_LOST")?;
        loop {
            if cancelled() {
                return Err("wayland:SESSION_CLOSED".into());
            }
            if state.lost {
                return Err("wayland:CAPTURE_LOST".into());
            }
            if let Some(frame) = &state.frame {
                return Ok(frame.clone());
            }
            if Instant::now() >= deadline {
                return Err("wayland:CAPTURE_TIMEOUT".into());
            }
            state = ready
                .wait_timeout(state, Duration::from_millis(25))
                .map_err(|_| "wayland:CAPTURE_LOST")?
                .0;
        }
    }
}
impl CaptureStream {
    pub fn stop(&mut self) {
        {
            let (lock, ready) = &*self.latest;
            if let Ok(mut state) = lock.lock() {
                state.lost = true;
                state.frame = None;
                ready.notify_all();
            }
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut p) = child.take() {
                let _ = p.kill();
                let _ = p.wait();
            }
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persistent_pipeline_keeps_serving_and_stops_on_drop() {
        if run("gst-inspect-1.0", &["videotestsrc"]).is_err() {
            return;
        }
        let mut cmd = Command::new("gst-launch-1.0");
        cmd.args([
            "-q",
            "videotestsrc",
            "is-live=true",
            "!",
            "video/x-raw,width=160,height=100,framerate=10/1",
            "!",
            "pngenc",
            "!",
            "fdsink",
            "fd=1",
            "sync=false",
        ]);
        let capture = CaptureStream::spawn(cmd, None, None).unwrap();
        let first = capture.frame(|| false).unwrap();
        thread::sleep(Duration::from_millis(250));
        let next = capture.frame(|| false).unwrap();
        assert!(next.sequence > first.sequence);
        assert_eq!((next.width, next.height), (160, 100));
        let pid = capture.child.lock().unwrap().as_ref().unwrap().id();
        drop(capture);
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    }
    #[test]
    fn stream_eos_invalidates_grant_and_cached_image() {
        let closed = Arc::new(AtomicBool::new(false));
        let mut command = Command::new("gst-launch-1.0");
        command.args([
            "-q",
            "videotestsrc",
            "num-buffers=1",
            "!",
            "video/x-raw,width=160,height=100",
            "!",
            "pngenc",
            "!",
            "fdsink",
            "fd=1",
            "sync=false",
        ]);
        let capture = CaptureStream::spawn(command, None, Some(closed.clone())).unwrap();
        let until = Instant::now() + Duration::from_secs(3);
        while !closed.load(Ordering::SeqCst) && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(closed.load(Ordering::SeqCst));
        assert_eq!(
            capture.frame(|| false).err().unwrap(),
            "wayland:CAPTURE_LOST"
        );
    }
    #[test]
    fn parser_rejects_truncation_oversize_and_unbounded_dimensions() {
        assert!(read_png(&mut &b"bad"[..]).is_err());
        let mut bad = b"\x89PNG\r\n\x1a\n".to_vec();
        bad.extend(u32::MAX.to_be_bytes());
        bad.extend(b"IDAT");
        assert!(read_png(&mut &bad[..]).is_err());
        let mut bad = b"\x89PNG\r\n\x1a\n".to_vec();
        bad.extend(13u32.to_be_bytes());
        bad.extend(b"IHDR");
        bad.extend(100_000u32.to_be_bytes());
        bad.extend(100_000u32.to_be_bytes());
        bad.extend([0; 9]);
        assert!(read_png(&mut &bad[..]).is_err());
    }
}

impl Drop for CaptureStream {
    fn drop(&mut self) {
        self.stop();
    }
}
