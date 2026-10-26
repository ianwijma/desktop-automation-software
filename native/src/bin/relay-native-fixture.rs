//! Synthetic, unbundled Win32 qualification fixture. Never part of the app runtime.
#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("The Win32 fixture requires Windows");
}
#[cfg(target_os = "windows")]
fn main() {
    if fixture::run().is_err() {
        eprintln!("Native fixture initialization failed");
        std::process::exit(1);
    }
}
#[cfg(target_os = "windows")]
mod fixture {
    use serde_json::{json, Value};
    use std::{
        collections::HashMap,
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        ptr::{null, null_mut},
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex, OnceLock,
        },
        thread,
        time::Duration,
    };
    use windows_sys::Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::LibraryLoader::*,
        UI::{Controls::*, HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    };
    struct Model {
        config: Value,
        window: usize,
        duplicate: usize,
        controls: HashMap<&'static str, usize>,
        clicks: u32,
        text: String,
        secure: bool,
        scroll: i32,
        drags: u32,
        buttons: u32,
        start: Option<(i32, i32)>,
        frames: u64,
    }
    static MODEL: OnceLock<Mutex<Model>> = OnceLock::new();
    static ACTIVE: AtomicBool = AtomicBool::new(true);
    fn model() -> &'static Mutex<Model> {
        MODEL.get().unwrap()
    }
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    fn scale() -> f64 {
        model().lock().unwrap().config["contentScale"]
            .as_f64()
            .unwrap_or(1.)
            .clamp(0.5, 3.)
    }
    fn px(n: i32) -> i32 {
        (f64::from(n) * scale()).round() as i32
    }
    fn coordinates(value: LPARAM) -> (i32, i32) {
        (value as i16 as i32, (value >> 16) as i16 as i32)
    }
    unsafe fn area(window: HWND) -> RECT {
        let mut r = RECT::default();
        GetClientRect(window, &mut r);
        r
    }
    unsafe fn fill(dc: HDC, r: RECT, color: u32) {
        let brush = CreateSolidBrush(color);
        FillRect(dc, &r, brush);
        DeleteObject(brush);
    }
    unsafe fn paint(window: HWND, dc: HDC) {
        let r = area(window);
        fill(dc, r, 0x231a16);
        let marker = RECT {
            left: r.right - px(68),
            top: px(24),
            right: r.right - px(24),
            bottom: px(68),
        };
        fill(dc, marker, 0x6438e8);
        let frames = model().lock().unwrap().frames;
        fill(
            dc,
            RECT {
                left: r.right - px(224),
                top: px(240),
                right: r.right - px(24),
                bottom: px(400),
            },
            if frames % 2 == 0 { 0x4c9933 } else { 0x4c99cc },
        );
    }
    unsafe extern "system" fn child_proc(
        window: HWND,
        msg: u32,
        wp: WPARAM,
        lp: LPARAM,
    ) -> LRESULT {
        let id = GetWindowLongPtrW(window, GWLP_ID);
        let drag = id == 5;
        match msg {
            WM_LBUTTONDOWN if drag => {
                SetCapture(window);
                let mut s = model().lock().unwrap();
                s.buttons = 1;
                s.start = Some(coordinates(lp));
                0
            }
            WM_LBUTTONUP if drag => {
                ReleaseCapture();
                let mut s = model().lock().unwrap();
                let end = coordinates(lp);
                if s.start
                    .map(|p| (p.0 - end.0).abs() + (p.1 - end.1).abs() > px_without_lock(20, &s))
                    .unwrap_or(false)
                {
                    s.drags += 1;
                }
                s.start = None;
                s.buttons = 0;
                0
            }
            WM_CAPTURECHANGED if drag => {
                let mut s = model().lock().unwrap();
                s.buttons = 0;
                0
            }
            WM_MOUSEWHEEL if !drag => {
                let delta = (wp >> 16) as i16 as i32;
                let mut s = model().lock().unwrap();
                s.scroll = (s.scroll - delta / 4).clamp(0, 520);
                let position = s.scroll;
                drop(s);
                SetScrollPos(window, SB_VERT, position, 1);
                InvalidateRect(window, null(), 1);
                0
            }
            WM_VSCROLL if !drag => {
                let mut s = model().lock().unwrap();
                s.scroll = match wp as u16 as i32 {
                    SB_LINEDOWN => s.scroll + 20,
                    SB_LINEUP => s.scroll - 20,
                    SB_PAGEDOWN => s.scroll + 60,
                    SB_PAGEUP => s.scroll - 60,
                    SB_THUMBTRACK => (wp >> 16) as i32,
                    _ => s.scroll,
                }
                .clamp(0, 520);
                let position = s.scroll;
                drop(s);
                SetScrollPos(window, SB_VERT, position, 1);
                InvalidateRect(window, null(), 1);
                0
            }
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let dc = BeginPaint(window, &mut ps);
                fill(dc, area(window), if drag { 0x6c3840 } else { 0x3e2e28 });
                EndPaint(window, &ps);
                0
            }
            _ => DefWindowProcW(window, msg, wp, lp),
        }
    }
    fn px_without_lock(n: i32, s: &Model) -> i32 {
        (f64::from(n) * s.config["contentScale"].as_f64().unwrap_or(1.)).round() as i32
    }
    unsafe fn duplicate() {
        let (config, existing) = {
            let s = model().lock().unwrap();
            (s.config.clone(), s.duplicate)
        };
        if existing != 0 {
            return;
        }
        let window = CreateWindowExW(
            0,
            wide("RelayNativeDuplicate").as_ptr(),
            wide(config["title"].as_str().unwrap()).as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            120,
            120,
            px(700),
            px(560),
            null_mut(),
            null_mut(),
            GetModuleHandleW(null()),
            null(),
        );
        model().lock().unwrap().duplicate = window as usize;
    }
    unsafe extern "system" fn window_proc(
        window: HWND,
        msg: u32,
        wp: WPARAM,
        lp: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_COMMAND => {
                let id = wp as u16;
                let event = (wp >> 16) as u16;
                if id == 1 && event == BN_CLICKED as u16 {
                    model().lock().unwrap().clicks += 1;
                }
                if event == EN_CHANGE as u16 && (id == 2 || id == 3) {
                    let control = lp as HWND;
                    let length = GetWindowTextLengthW(control);
                    if id == 2 {
                        let mut text = vec![0u16; length.max(0) as usize + 1];
                        let count = GetWindowTextW(control, text.as_mut_ptr(), text.len() as i32);
                        model().lock().unwrap().text =
                            String::from_utf16_lossy(&text[..count.max(0) as usize]);
                    } else {
                        model().lock().unwrap().secure = length > 0;
                    }
                }
                0
            }
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let dc = BeginPaint(window, &mut ps);
                paint(window, dc);
                EndPaint(window, &ps);
                0
            }
            WM_PRINTCLIENT => {
                paint(window, wp as HDC);
                0
            }
            WM_SIZE => {
                InvalidateRect(window, null(), 1);
                0
            }
            WM_TIMER => {
                if wp == 2 {
                    PostMessageW(window, WM_CLOSE, 0, 0);
                } else {
                    model().lock().unwrap().frames += 1;
                    InvalidateRect(window, null(), 0);
                }
                0
            }
            x if x == WM_APP + 1 => {
                duplicate();
                0
            }
            x if x == WM_APP + 2 => {
                SetWindowPos(
                    window,
                    null_mut(),
                    0,
                    0,
                    px(640),
                    px(500),
                    SWP_NOMOVE | SWP_NOZORDER,
                );
                0
            }
            x if x == WM_APP + 4 => {
                ShowWindow(window, SW_MINIMIZE);
                0
            }
            x if x == WM_APP + 5 => {
                ShowWindow(window, SW_RESTORE);
                SetForegroundWindow(window);
                0
            }
            x if x == WM_APP + 6 => {
                let action = model().lock().unwrap().controls["action"] as HWND;
                SetWindowPos(
                    action,
                    null_mut(),
                    px(32),
                    px(410),
                    px(110),
                    px(38),
                    SWP_NOZORDER,
                );
                0
            }
            x if x == WM_APP + 7 => {
                duplicate();
                EnableWindow(window, 0);
                0
            }
            x if x == WM_APP + 8 => {
                let action = model().lock().unwrap().controls.remove("action");
                if let Some(action) = action {
                    DestroyWindow(action as HWND);
                }
                0
            }
            x if x == WM_APP + 3 => {
                let duplicate = {
                    let mut s = model().lock().unwrap();
                    let d = s.duplicate;
                    s.duplicate = 0;
                    d
                };
                if duplicate != 0 {
                    DestroyWindow(duplicate as HWND);
                }
                EnableWindow(window, 1);
                SetForegroundWindow(window);
                0
            }
            WM_CLOSE => {
                DestroyWindow(window);
                0
            }
            WM_DESTROY => {
                ACTIVE.store(false, Ordering::SeqCst);
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(window, msg, wp, lp),
        }
    }
    unsafe fn control(
        parent: HWND,
        class: &str,
        text: &str,
        id: i32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        style: u32,
    ) -> HWND {
        CreateWindowExW(
            0,
            wide(class).as_ptr(),
            wide(text).as_ptr(),
            WS_CHILD | WS_VISIBLE | style,
            px(x),
            px(y),
            px(w),
            px(h),
            parent,
            id as usize as HMENU,
            GetModuleHandleW(null()),
            null(),
        )
    }
    unsafe fn ui(window: HWND) {
        let items = [
            (
                "action",
                control(
                    window,
                    "BUTTON",
                    "Activate",
                    1,
                    28,
                    70,
                    110,
                    38,
                    BS_PUSHBUTTON as u32,
                ),
            ),
            (
                "text",
                control(
                    window,
                    "EDIT",
                    "",
                    2,
                    62,
                    117,
                    240,
                    38,
                    WS_BORDER | ES_AUTOHSCROLL as u32,
                ),
            ),
            (
                "secure",
                control(
                    window,
                    "EDIT",
                    "",
                    3,
                    118,
                    163,
                    240,
                    38,
                    WS_BORDER | ES_PASSWORD as u32 | ES_AUTOHSCROLL as u32,
                ),
            ),
            (
                "scroll",
                control(
                    window,
                    "RelayNativeSurface",
                    "",
                    4,
                    32,
                    220,
                    240,
                    80,
                    WS_VSCROLL,
                ),
            ),
            (
                "drag",
                control(window, "RelayNativeSurface", "", 5, 32, 310, 280, 56, 0),
            ),
        ];
        control(
            window,
            "BUTTON",
            "Duplicate label",
            6,
            144,
            70,
            140,
            38,
            BS_PUSHBUTTON as u32,
        );
        control(
            window,
            "BUTTON",
            "Duplicate label",
            7,
            290,
            70,
            140,
            38,
            BS_PUSHBUTTON as u32,
        );
        let disabled = control(
            window,
            "BUTTON",
            "Disabled action",
            8,
            440,
            70,
            130,
            38,
            BS_PUSHBUTTON as u32,
        );
        EnableWindow(disabled, 0);
        let readonly = control(
            window,
            "EDIT",
            "Read-only fixture",
            9,
            400,
            117,
            160,
            38,
            WS_BORDER | ES_READONLY as u32,
        );
        let list = control(
            window,
            "LISTBOX",
            "",
            10,
            400,
            163,
            170,
            64,
            WS_BORDER | LBS_NOTIFY as u32,
        );
        SendMessageW(
            list,
            LB_ADDSTRING,
            0,
            wide("First choice").as_ptr() as LPARAM,
        );
        SendMessageW(
            list,
            LB_ADDSTRING,
            0,
            wide("Second choice").as_ptr() as LPARAM,
        );
        for (name, handle) in [
            ("disabled", disabled),
            ("readonly", readonly),
            ("list", list),
        ] {
            model()
                .lock()
                .unwrap()
                .controls
                .insert(name, handle as usize);
        }
        for (name, handle) in items {
            if !handle.is_null() {
                model()
                    .lock()
                    .unwrap()
                    .controls
                    .insert(name, handle as usize);
            }
        }
        let scroll = model().lock().unwrap().controls["scroll"] as HWND;
        SetScrollRange(scroll, SB_VERT, 0, 520, 1);
        SetTimer(window, 1, 250, None);
        SetTimer(window, 2, 600000, None);
    }
    unsafe fn snapshot() -> Value {
        let s = model().lock().unwrap();
        let window = s.window as HWND;
        let mut outer = RECT::default();
        GetWindowRect(window, &mut outer);
        let client = area(window);
        let mut origin = POINT { x: 0, y: 0 };
        ClientToScreen(window, &mut origin);
        let mut targets = serde_json::Map::new();
        for (name, control) in &s.controls {
            let mut r = RECT::default();
            GetWindowRect(*control as HWND, &mut r);
            targets.insert(name.to_string(),json!({"x":r.left-outer.left,"y":r.top-outer.top,"width":r.right-r.left,"height":r.bottom-r.top}));
        }
        let scale = s.config["contentScale"].as_f64().unwrap_or(1.);
        let n = |v: f64| (v * scale).round() as i32;
        targets.insert(
            "marker".into(),
            json!({"x":origin.x-outer.left+client.right-n(68.),"y":origin.y-outer.top+n(24.),"width":n(44.),"height":n(44.)}),
        );
        targets.insert("gpu".into(),json!({"x":origin.x-outer.left+client.right-n(224.),"y":origin.y-outer.top+n(240.),"width":n(200.),"height":n(160.)}));
        let focused = GetForegroundWindow() == window;
        let held = if focused && GetAsyncKeyState(VK_SHIFT as i32) < 0 {
            vec!["Shift"]
        } else {
            vec![]
        };
        let selected = SendMessageW(s.controls["list"] as HWND, LB_GETCURSEL, 0, 0);
        json!({"selectedIndex":selected,"modalBlocked":IsWindowEnabled(window)==0,"coordinateSpace":"window-input","resizeExpectedWidth":n(640.),"clicks":s.clicks,"text":s.text,"secureHasValue":s.secure,"scrollTop":s.scroll,"drags":s.drags,"buttons":s.buttons,"held":held,"animationFrames":s.frames,"gpu":false,"renderSurface":"native-gdi","nativeControls":true,"contentScale":scale,"devicePixelRatio":f64::from(GetDpiForWindow(window))/96.,"targets":targets,"minimized":IsIconic(window)!=0,"focused":focused,"duplicate":s.duplicate!=0,"bounds":{"x":outer.left,"y":outer.top,"width":outer.right-outer.left,"height":outer.bottom-outer.top},"displays":[{"scaleFactor":f64::from(GetDpiForWindow(window))/96.}],"versions":{"fixture":"Win32 controls","version":env!("CARGO_PKG_VERSION")}})
    }
    fn connection(mut socket: TcpStream, token: &str) {
        // Windows accept inherits the listener's nonblocking mode. Each accepted
        // connection uses bounded blocking reads, including fragmented headers.
        let _ = socket.set_nonblocking(false);
        let _ = socket.set_read_timeout(Some(Duration::from_secs(2)));
        let mut bytes = Vec::new();
        while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
            if bytes.len() >= 8192 {
                return;
            }
            let mut chunk = [0u8; 1024];
            match socket.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(length) => bytes.extend_from_slice(&chunk[..length]),
            }
        }
        let text = String::from_utf8_lossy(&bytes);
        let authorized = text
            .lines()
            .filter_map(|l| l.split_once(':'))
            .any(|(k, v)| {
                k.eq_ignore_ascii_case("authorization") && v.trim() == format!("Bearer {token}")
            });
        let first = text.lines().next().unwrap_or("");
        let mut parts = first.split_whitespace();
        let method = parts.next().unwrap_or("");
        let route = parts.next().unwrap_or("");
        let mut status = "200 OK";
        let mut body = "{}".to_string();
        if !authorized {
            status = "403 Forbidden";
        } else {
            let window = model().lock().unwrap().window as HWND;
            unsafe {
                match (method, route) {
                    ("GET", "/state") => body = snapshot().to_string(),
                    ("POST", "/duplicate") => {
                        PostMessageW(window, WM_APP + 1, 0, 0);
                    }
                    ("POST", "/minimize") => {
                        PostMessageW(window, WM_APP + 4, 0, 0);
                    }
                    ("POST", "/restore") => {
                        PostMessageW(window, WM_APP + 5, 0, 0);
                    }
                    ("POST", "/uia-move") => {
                        PostMessageW(window, WM_APP + 6, 0, 0);
                    }
                    ("POST", "/uia-modal") => {
                        PostMessageW(window, WM_APP + 7, 0, 0);
                    }
                    ("POST", "/uia-destroy") => {
                        PostMessageW(window, WM_APP + 8, 0, 0);
                    }
                    ("POST", "/resize") => {
                        PostMessageW(window, WM_APP + 2, 0, 0);
                    }
                    ("POST", "/close-duplicate") => {
                        PostMessageW(window, WM_APP + 3, 0, 0);
                    }
                    ("POST", "/quit") => {
                        PostMessageW(window, WM_CLOSE, 0, 0);
                    }
                    _ => status = "404 Not Found",
                }
            }
        }
        let _=write!(socket,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
    }
    pub fn run() -> Result<(), Box<dyn std::error::Error>> {
        let config: Value =
            serde_json::from_slice(&std::fs::read(std::env::args().last().ok_or("config")?)?)?;
        MODEL
            .set(Mutex::new(Model {
                config: config.clone(),
                window: 0,
                duplicate: 0,
                controls: HashMap::new(),
                clicks: 0,
                text: String::new(),
                secure: false,
                scroll: 0,
                drags: 0,
                buttons: 0,
                start: None,
                frames: 0,
            }))
            .map_err(|_| "model")?;
        unsafe {
            if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) == 0 {
                return Err("DPI".into());
            }
            let instance = GetModuleHandleW(null());
            for (name, proc) in [
                (
                    "RelayNativeFixture",
                    Some(
                        window_proc
                            as unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT,
                    ),
                ),
                (
                    "RelayNativeSurface",
                    Some(
                        child_proc
                            as unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT,
                    ),
                ),
                (
                    "RelayNativeDuplicate",
                    Some(
                        DefWindowProcW
                            as unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT,
                    ),
                ),
            ] {
                let class_name = wide(name);
                let class = WNDCLASSW {
                    lpfnWndProc: proc,
                    hInstance: instance,
                    lpszClassName: class_name.as_ptr(),
                    hCursor: LoadCursorW(null_mut(), IDC_ARROW),
                    ..Default::default()
                };
                if RegisterClassW(&class) == 0 {
                    return Err("class".into());
                }
            }
            let window = CreateWindowExW(
                0,
                wide("RelayNativeFixture").as_ptr(),
                wide(config["title"].as_str().ok_or("title")?).as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                config["position"]["x"].as_i64().unwrap_or(80) as i32,
                config["position"]["y"].as_i64().unwrap_or(80) as i32,
                px(700),
                px(560),
                null_mut(),
                null_mut(),
                instance,
                null(),
            );
            if window.is_null() {
                return Err("window".into());
            }
            model().lock().unwrap().window = window as usize;
            ui(window);
            SetForegroundWindow(window);
        }
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        std::fs::write(
            config["controlFile"].as_str().ok_or("control file")?,
            json!({"port":listener.local_addr()?.port()}).to_string(),
        )?;
        let token = config["token"].as_str().ok_or("token")?.to_string();
        let server = thread::spawn(move || {
            while ACTIVE.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((socket, _)) => connection(socket, &token),
                    Err(_) => thread::sleep(Duration::from_millis(20)),
                }
            }
        });
        unsafe {
            let mut message = MSG::default();
            while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        ACTIVE.store(false, Ordering::SeqCst);
        let _ = server.join();
        Ok(())
    }
}
