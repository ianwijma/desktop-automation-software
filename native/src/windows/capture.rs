use super::*;
use std::sync::Condvar;
use std::time::Instant;
use windows_capture::{
    capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl},
    settings::*,
    window::Window,
};
use windows_sys::Win32::Storage::Xps::PrintWindow;
#[derive(Clone)]
struct Snapshot {
    width: u32,
    height: u32,
    pixels: Arc<Vec<u8>>,
    at: u128,
    sequence: u64,
}
#[derive(Default)]
struct State {
    latest: Option<Snapshot>,
    closed: bool,
    failed: bool,
}
type Shared = Arc<(Mutex<State>, Condvar)>;
struct Handler {
    shared: Shared,
    sequence: u64,
}
impl GraphicsCaptureApiHandler for Handler {
    type Flags = Shared;
    type Error = String;
    fn new(ctx: Context<Shared>) -> Result<Self> {
        Ok(Self {
            shared: ctx.flags,
            sequence: 0,
        })
    }
    fn on_frame_arrived(&mut self, frame: &mut Frame, _: InternalCaptureControl) -> Result<()> {
        let result = (|| {
            let width = frame.width();
            let height = frame.height();
            if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 40_000_000 {
                return Err(fail("CAPTURE_GEOMETRY"));
            }
            let buffer = frame.buffer().map_err(|_| fail("CAPTURE_LOST"))?;
            let mut pixels = Vec::new();
            let pixels = Arc::new(buffer.as_nopadding_buffer(&mut pixels).to_vec());
            self.sequence += 1;
            let mut state = self.shared.0.lock().map_err(|_| fail("CAPTURE_LOST"))?;
            state.latest = Some(Snapshot {
                width,
                height,
                pixels,
                at: now(),
                sequence: self.sequence,
            });
            self.shared.1.notify_all();
            Ok(())
        })();
        if result.is_err() {
            if let Ok(mut state) = self.shared.0.lock() {
                state.failed = true;
                self.shared.1.notify_all();
            }
        }
        result
    }
    fn on_closed(&mut self) -> Result<()> {
        if let Ok(mut state) = self.shared.0.lock() {
            state.closed = true;
            self.shared.1.notify_all();
        }
        Ok(())
    }
}
struct Stream {
    window: usize,
    pid: u32,
    shared: Shared,
    control: Option<CaptureControl<Handler, String>>,
}
static STREAM: OnceLock<Mutex<Option<Stream>>> = OnceLock::new();
fn streams() -> &'static Mutex<Option<Stream>> {
    STREAM.get_or_init(|| Mutex::new(None))
}
pub fn stop() -> Result<()> {
    let previous = streams()
        .lock()
        .map_err(|_| fail("CAPTURE_STOP_FAILED"))?
        .take();
    if let Some(mut stream) = previous {
        if let Some(control) = stream.control.take() {
            control.stop().map_err(|_| fail("CAPTURE_STOP_FAILED"))?;
        }
    }
    Ok(())
}
fn png(pixels: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|_| fail("CAPTURE_LOST"))?;
        writer
            .write_image_data(pixels)
            .map_err(|_| fail("CAPTURE_LOST"))?;
    }
    Ok(out)
}
fn response(
    data: Vec<u8>,
    width: u32,
    height: u32,
    window: RECT,
    source: RECT,
    backend: &str,
    at: u128,
) -> Value {
    json!({"width":width,"height":height,"dataUrl":format!("data:image/png;base64,{}",STANDARD.encode(data)),"capturedAt":at,"bounds":bounds(window),"captureBounds":bounds(source),"backend":backend})
}
pub fn graphics(window: HWND) -> Result<Value> {
    if !GraphicsCaptureApi::is_supported().unwrap_or(false) {
        return Err(fail("CAPTURE_UNAVAILABLE"));
    }
    let owner = pid(window)?;
    let changed = streams()
        .lock()
        .map_err(|_| fail("CAPTURE_LOST"))?
        .as_ref()
        .map(|s| s.window != window as usize || s.pid != owner)
        .unwrap_or(false);
    if changed {
        stop()?;
    }
    let mut stored = streams().lock().map_err(|_| fail("CAPTURE_LOST"))?;
    if stored.is_none() {
        let shared = Arc::new((Mutex::new(State::default()), Condvar::new()));
        let minimum = if GraphicsCaptureApi::is_minimum_update_interval_supported().unwrap_or(false)
        {
            MinimumUpdateIntervalSettings::Custom(Duration::from_millis(66))
        } else {
            MinimumUpdateIntervalSettings::Default
        };
        // Keep the system's capture indicator; never request borderless capture consent.
        let settings = Settings::new(
            Window::from_raw_hwnd(window),
            CursorCaptureSettings::WithoutCursor,
            DrawBorderSettings::Default,
            SecondaryWindowSettings::Default,
            minimum,
            DirtyRegionSettings::Default,
            ColorFormat::Rgba8,
            shared.clone(),
        );
        let control =
            Handler::start_free_threaded(settings).map_err(|_| fail("CAPTURE_UNAVAILABLE"))?;
        *stored = Some(Stream {
            window: window as usize,
            pid: owner,
            shared,
            control: Some(control),
        });
    }
    let stream = stored.as_ref().unwrap();
    let original = rect(window)?;
    let visible = visible_rect(window)?;
    let deadline = Instant::now() + Duration::from_millis(2500);
    let mut state = stream.shared.0.lock().map_err(|_| fail("CAPTURE_LOST"))?;
    let previous = state.latest.as_ref().map(|s| s.sequence);
    let settle = Instant::now() + Duration::from_millis(120);
    let (snapshot, source) = loop {
        if state.closed || state.failed || stream.control.as_ref().unwrap().is_finished() {
            return Err(fail("CAPTURE_LOST"));
        }
        if let Some(ref frame) = state.latest {
            let matches = |r: RECT| {
                frame.width as i32 == r.right - r.left && frame.height as i32 == r.bottom - r.top
            };
            let source = if matches(visible) {
                Some(visible)
            } else if matches(original) {
                Some(original)
            } else {
                None
            };
            if let Some(source) = source {
                if Some(frame.sequence) != previous || Instant::now() >= settle {
                    break (frame.clone(), source);
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(fail("CAPTURE_TIMEOUT"));
        }
        state = stream
            .shared
            .1
            .wait_timeout(state, Duration::from_millis(40))
            .map_err(|_| fail("CAPTURE_LOST"))?
            .0;
    };
    drop(state);
    available_window(window)?;
    if owner != pid(window)?
        || !same_rect(original, rect(window)?)
        || !same_rect(visible, visible_rect(window)?)
    {
        return Err(fail("CAPTURE_GEOMETRY"));
    }
    let data = png(&snapshot.pixels, snapshot.width, snapshot.height)?;
    Ok(response(
        data,
        snapshot.width,
        snapshot.height,
        original,
        source,
        WGC,
        snapshot.at,
    ))
}
struct Dc {
    window: HWND,
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
}
impl Drop for Dc {
    fn drop(&mut self) {
        unsafe {
            if !self.memory.is_null() && !self.previous.is_null() {
                SelectObject(self.memory, self.previous);
            }
            if !self.bitmap.is_null() {
                DeleteObject(self.bitmap);
            }
            if !self.memory.is_null() {
                DeleteDC(self.memory);
            }
            if !self.screen.is_null() {
                ReleaseDC(self.window, self.screen);
            }
        }
    }
}
pub fn print_window(window: HWND) -> Result<Value> {
    unsafe {
        let owner = pid(window)?;
        let original = rect(window)?;
        let width = (original.right - original.left) as u32;
        let height = (original.bottom - original.top) as u32;
        if u64::from(width) * u64::from(height) > 40_000_000 {
            return Err(fail("CAPTURE_GEOMETRY"));
        }
        let mut dc = Dc {
            window,
            screen: GetDC(window),
            memory: null_mut(),
            bitmap: null_mut(),
            previous: null_mut(),
        };
        if dc.screen.is_null() {
            return Err(fail("CAPTURE_UNAVAILABLE"));
        }
        dc.memory = CreateCompatibleDC(dc.screen);
        dc.bitmap = CreateCompatibleBitmap(dc.screen, width as i32, height as i32);
        if dc.memory.is_null() || dc.bitmap.is_null() {
            return Err(fail("CAPTURE_UNAVAILABLE"));
        }
        dc.previous = SelectObject(dc.memory, dc.bitmap);
        if dc.previous.is_null() || PrintWindow(window, dc.memory, 2) == 0 {
            return Err(fail("CAPTURE_UNAVAILABLE"));
        }
        SelectObject(dc.memory, dc.previous);
        dc.previous = null_mut();
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width as i32;
        info.bmiHeader.biHeight = -(height as i32);
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        if GetDIBits(
            dc.memory,
            dc.bitmap,
            0,
            height,
            pixels.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        ) != height as i32
        {
            return Err(fail("CAPTURE_LOST"));
        }
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        available_window(window)?;
        if owner != pid(window)? || !same_rect(original, rect(window)?) {
            return Err(fail("CAPTURE_GEOMETRY"));
        }
        Ok(response(
            png(&pixels, width, height)?,
            width,
            height,
            original,
            original,
            PRINT,
            now(),
        ))
    }
}
