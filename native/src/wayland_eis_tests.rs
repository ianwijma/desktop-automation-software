//! A real EI/EIS socket exchange with a synthetic server, without compositor input.
use super::*;
use reis::{
    eis,
    handshake::EisHandshaker,
    request::{EisRequest, EisRequestConverter},
};
use std::os::fd::{AsFd, AsRawFd};
#[derive(Debug, PartialEq)]
enum Observed {
    Point(f32, f32),
    Button(bool),
    Key(bool),
    Text(String),
    Scroll(f32, f32),
}
struct Fixture {
    stop: Arc<AtomicBool>,
    pause: std::sync::mpsc::Sender<()>,
    seen: Arc<Mutex<Vec<Observed>>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}
fn fixture() -> (OwnedFd, Fixture) {
    let (client, server) = UnixStream::pair().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = stop.clone();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let records = seen.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = thread::spawn(move || {
        let context = eis::Context::new(server).unwrap();
        let mut handshake = EisHandshaker::new(&context, 1);
        let mut converter: Option<EisRequestConverter> = None;
        let mut device: Option<reis::request::Device> = None;
        while !stopping.load(Ordering::SeqCst) {
            if rx.try_recv().is_ok() {
                if let Some(device) = &device {
                    device.paused();
                    context.flush().unwrap();
                }
            }
            let mut poll = libc::pollfd {
                fd: context.as_fd().as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            if unsafe { libc::poll(&mut poll, 1, 20) } <= 0 {
                continue;
            }
            if context.read().is_err() {
                break;
            }
            while let Some(request) = context.pending_request() {
                let reis::PendingRequestResult::Request(request) = request else {
                    panic!("Invalid fixture request")
                };
                if let Some(converter) = &mut converter {
                    converter.handle_request(request).unwrap();
                    while let Some(request) = converter.next_request() {
                        match request {
                            EisRequest::Bind(request) => {
                                let d = request.seat.add_device(
                                    Some("fixture"),
                                    eis::device::DeviceType::Virtual,
                                    request.capabilities,
                                    |d| {
                                        d.device().region_mapping_id("fixture-region");
                                        d.device().region(50, 30, 200, 100, 1.5);
                                    },
                                );
                                d.resumed();
                                let other = request.seat.add_device(
                                    Some("other-monitor"),
                                    eis::device::DeviceType::Virtual,
                                    DeviceCapability::PointerAbsolute.into(),
                                    |d| {
                                        d.device().region_mapping_id("other-region");
                                        d.device().region(300, 30, 200, 100, 1.5);
                                    },
                                );
                                other.resumed();
                                device = Some(d);
                            }
                            EisRequest::PointerMotionAbsolute(p) => records
                                .lock()
                                .unwrap()
                                .push(Observed::Point(p.dx_absolute, p.dy_absolute)),
                            EisRequest::Button(p) => records
                                .lock()
                                .unwrap()
                                .push(Observed::Button(p.state == eis::button::ButtonState::Press)),
                            EisRequest::KeyboardKey(p) => records
                                .lock()
                                .unwrap()
                                .push(Observed::Key(p.state == eis::keyboard::KeyState::Press)),
                            EisRequest::TextUtf8(p) => {
                                records.lock().unwrap().push(Observed::Text(p.text))
                            }
                            EisRequest::ScrollDelta(p) => {
                                records.lock().unwrap().push(Observed::Scroll(p.dx, p.dy))
                            }
                            _ => {}
                        }
                    }
                } else if let Some(response) = handshake.handle_request(request).unwrap() {
                    let c = EisRequestConverter::new(&context, response, 1);
                    let _ = c.handle().add_seat(
                        Some("fixture-seat"),
                        DeviceCapability::PointerAbsolute
                            | DeviceCapability::Keyboard
                            | DeviceCapability::Button
                            | DeviceCapability::Scroll
                            | DeviceCapability::Text,
                    );
                    converter = Some(c);
                }
            }
            if context.flush().is_err() {
                break;
            }
        }
    });
    (
        client.into(),
        Fixture {
            stop,
            pause: tx,
            seen,
            worker: Some(worker),
        },
    )
}
#[test]
fn framed_input_mapping_unicode_sync_and_revocation() {
    let (fd, server) = fixture();
    let closed = Arc::new(AtomicBool::new(false));
    let input = Eis::connect(fd, closed.clone()).unwrap();
    let until = std::time::Instant::now() + Duration::from_secs(2);
    while input.state.lock().unwrap().devices.len() < 2 && std::time::Instant::now() < until {
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(input.state.lock().unwrap().devices.len(), 2);
    assert!(input
        .pointer(1., 1., (200, 100), Some("wrong-region"))
        .is_err());
    assert!(input.lookup(0x0101f600).is_err());
    input
        .pointer(25., 20., (200, 100), Some("fixture-region"))
        .unwrap();
    input.button(272, true).unwrap();
    input.button(272, false).unwrap();
    input.keycode(30, true).unwrap();
    input.keycode(30, false).unwrap();
    input.text("日本😀").unwrap();
    input.scroll(2., -3.).unwrap();
    input.sync().unwrap();
    let seen = server.seen.lock().unwrap();
    assert!(seen.contains(&Observed::Point(75., 50.)));
    assert!(seen.contains(&Observed::Button(true)));
    assert!(seen.contains(&Observed::Button(false)));
    assert!(seen.contains(&Observed::Key(true)));
    assert!(seen.contains(&Observed::Key(false)));
    assert!(seen.contains(&Observed::Text("日本😀".into())));
    assert!(seen.contains(&Observed::Scroll(2., -3.)));
    let count = seen.len();
    drop(seen);
    server.pause.send(()).unwrap();
    let until = std::time::Instant::now() + Duration::from_secs(2);
    while !closed.load(Ordering::SeqCst) && std::time::Instant::now() < until {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(closed.load(Ordering::SeqCst));
    assert_eq!(input.keycode(30, true).unwrap_err(), "wayland:EIS_LOST");
    assert_eq!(server.seen.lock().unwrap().len(), count);
    drop(input);
}
#[test]
fn connected_socket_failure_is_terminal() {
    let (client, server) = UnixStream::pair().unwrap();
    drop(server);
    let closed = Arc::new(AtomicBool::new(false));
    assert!(Eis::connect(client.into(), closed.clone()).is_err());
    assert!(closed.load(Ordering::SeqCst));
}
