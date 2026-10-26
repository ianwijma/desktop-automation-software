//! All COM objects stay on one windowless MTA. Only JSON crosses the channel.
use super::*;
use crate::uia_contract as contract;
use ::windows::{
    core::{Interface, BSTR},
    Win32::{
        Foundation::HWND as ComHwnd,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_MULTITHREADED,
        },
        UI::Accessibility::*,
    },
};
use std::{
    collections::VecDeque,
    sync::{atomic::AtomicBool, mpsc},
    time::Instant,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
struct Request {
    method: String,
    params: Value,
    reply: mpsc::SyncSender<Result<Value>>,
    cancelled: Arc<AtomicBool>,
}
struct Worker {
    sender: mpsc::SyncSender<Request>,
    poisoned: Arc<AtomicBool>,
}
static WORKER: OnceLock<Worker> = OnceLock::new();
fn error(_: ::windows::core::Error) -> String {
    "uia:STALE_ELEMENT".into()
}
fn optional<T>(value: ::windows::core::Result<T>) -> Result<Option<T>> {
    match value {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.code().0 == 0x80004003u32 as i32 => Ok(None),
        Err(e) => Err(error(e)),
    }
}
pub fn call(method: &str, params: &Value) -> Result<Value> {
    let worker = WORKER.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<Request>(4);
        let poisoned = Arc::new(AtomicBool::new(false));
        let flag = poisoned.clone();
        thread::spawn(move || unsafe {
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
                flag.store(true, Ordering::SeqCst);
                return;
            }
            {
                let automation: ::windows::core::Result<IUIAutomation2> =
                    CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER);
                if let Ok(automation) = automation {
                    // Bound provider connections/transactions; whole requests have a separate deadline.
                    if automation.SetConnectionTimeout(500).is_ok()
                        && automation.SetTransactionTimeout(500).is_ok()
                    {
                        if let Ok(api) = automation.cast::<IUIAutomation>() {
                            for request in receiver {
                                let mut context = Context {
                                    api: &api,
                                    cancelled: &request.cancelled,
                                    deadline: Instant::now() + Duration::from_secs(4),
                                    remaining: 2048,
                                };
                                let result = context.run(&request.method, &request.params);
                                if result.as_ref().is_err_and(|e| e == "uia:TIMEOUT") {
                                    flag.store(true, Ordering::SeqCst);
                                }
                                let _ = request.reply.send(result);
                            }
                        }
                    }
                }
                flag.store(true, Ordering::SeqCst);
            }
            CoUninitialize();
        });
        Worker { sender, poisoned }
    });
    if worker.poisoned.load(Ordering::SeqCst) {
        return Err("uia:TIMEOUT".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let (reply, receiver) = mpsc::sync_channel(1);
    worker
        .sender
        .try_send(Request {
            method: method.into(),
            params: params.clone(),
            reply,
            cancelled: cancelled.clone(),
        })
        .map_err(|_| "uia:TIMEOUT")?;
    match receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => result,
        Err(_) => {
            cancelled.store(true, Ordering::SeqCst);
            worker.poisoned.store(true, Ordering::SeqCst);
            Err("uia:TIMEOUT".into())
        }
    }
}
struct Context<'a> {
    api: &'a IUIAutomation,
    cancelled: &'a AtomicBool,
    deadline: Instant,
    remaining: usize,
}
impl Context<'_> {
    fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::SeqCst) || Instant::now() > self.deadline {
            Err("uia:TIMEOUT".into())
        } else {
            Ok(())
        }
    }
    fn guard(&self, p: &Value) -> Result<HWND> {
        self.check()?;
        let window = hwnd(p)?;
        available_window(window)?;
        check_privilege(window)?;
        if p["applicationIdentity"]["pid"]
            .as_u64()
            .is_some_and(|expected| expected != u64::from(pid(window).unwrap_or(0)))
        {
            return Err("uia:STALE_ELEMENT".into());
        }
        unsafe {
            let popup = GetLastActivePopup(window);
            if IsWindowEnabled(window) == 0
                || (!popup.is_null() && popup != window && IsWindowVisible(popup) != 0)
            {
                return Err("uia:MODAL_BLOCKED".into());
            }
        }
        if let Some(expected) = p.get("expectedBounds") {
            if &bounds(rect(window)?) != expected {
                return Err("uia:STALE_ELEMENT".into());
            }
        }
        Ok(window)
    }
    unsafe fn properties(&self, e: &IUIAutomationElement) -> Result<Value> {
        self.check()?;
        let secure = e.CurrentIsPassword().map_err(error)?.as_bool();
        let name = if secure {
            String::new()
        } else {
            e.CurrentName().map_err(error)?.to_string()
        };
        let id = e.CurrentAutomationId().map_err(error)?.to_string();
        let class = e.CurrentClassName().map_err(error)?.to_string();
        // Never truncate identifying properties into a different locator.
        if [name.as_str(), id.as_str(), class.as_str()]
            .iter()
            .any(|s| s.chars().count() > 512)
        {
            return Err("uia:SEARCH_LIMIT".into());
        }
        Ok(
            json!({"name":name,"automationId":id,"className":class,"controlType":contract::control_name(e.CurrentControlType().map_err(error)?.0),"secure":secure}),
        )
    }
    unsafe fn describe(&self, e: &IUIAutomationElement, locator: Value) -> Result<Value> {
        let mut value = self.properties(e)?;
        let secure = value["secure"] == true;
        let mut actions = Vec::new();
        let virtualized = e
            .GetCurrentPatternAs::<IUIAutomationVirtualizedItemPattern>(
                UIA_VirtualizedItemPatternId,
            )
            .is_ok();
        if !secure && !virtualized {
            actions.push("read");
            if e.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                .is_ok()
            {
                actions.push("invoke");
            }
            if let Ok(pattern) =
                e.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            {
                if !pattern.CurrentIsReadOnly().map_err(error)?.as_bool() {
                    actions.push("setValue");
                }
            }
            if e.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                UIA_SelectionItemPatternId,
            )
            .is_ok()
            {
                actions.push("select");
            }
        }
        let r = e.CurrentBoundingRectangle().map_err(error)?;
        value["bounds"] = json!({"x":r.left,"y":r.top,"width":(r.right-r.left).max(0),"height":(r.bottom-r.top).max(0)});
        value["enabled"] = json!(e.CurrentIsEnabled().map_err(error)?.as_bool());
        value["offscreen"] = json!(e.CurrentIsOffscreen().map_err(error)?.as_bool());
        value["virtualized"] = json!(virtualized);
        value["actions"] = json!(actions);
        value["locator"] = locator;
        Ok(value)
    }
    unsafe fn owned(
        &self,
        e: &IUIAutomationElement,
        root: &IUIAutomationElement,
        owner: u32,
    ) -> Result<()> {
        if e.CurrentProcessId().map_err(error)? != owner as i32 {
            return Err("uia:STALE_ELEMENT".into());
        }
        let walker = self.api.RawViewWalker().map_err(error)?;
        let mut current = e.clone();
        for _ in 0..64 {
            self.check()?;
            if self
                .api
                .CompareElements(&current, root)
                .map_err(error)?
                .as_bool()
            {
                return Ok(());
            }
            current = optional(walker.GetParentElement(&current))?.ok_or("uia:STALE_ELEMENT")?;
        }
        Err("uia:SEARCH_LIMIT".into())
    }
    unsafe fn find(
        &mut self,
        root: &IUIAutomationElement,
        selector: &Value,
        owner: u32,
    ) -> Result<Vec<IUIAutomationElement>> {
        let walker = self.api.ControlViewWalker().map_err(error)?;
        let mut queue = VecDeque::new();
        if let Some(first) = optional(walker.GetFirstChildElement(root))? {
            queue.push_back((first, 1));
        }
        let mut matches = Vec::new();
        while let Some((element, depth)) = queue.pop_front() {
            self.check()?;
            if self.remaining == 0 || depth > 40 {
                return Err("uia:SEARCH_LIMIT".into());
            }
            self.remaining -= 1;
            if let Some(sibling) = optional(walker.GetNextSiblingElement(&element))? {
                queue.push_back((sibling, depth));
            }
            if element.CurrentProcessId().map_err(error)? != owner as i32 {
                continue;
            }
            let properties = self.properties(&element)?;
            if !(properties["secure"] == true && selector.get("name").is_some())
                && contract::matches(selector, &properties)
            {
                matches.push(element.clone());
            }
            if let Some(child) = optional(walker.GetFirstChildElement(&element))? {
                queue.push_back((child, depth + 1));
            }
        }
        Ok(matches)
    }
    unsafe fn resolve(
        &mut self,
        root: &IUIAutomationElement,
        locator: &Value,
        owner: u32,
    ) -> Result<Vec<IUIAutomationElement>> {
        contract::validate(locator)?;
        let mut scope = root.clone();
        if let Some(ancestors) = locator["ancestors"].as_array() {
            for selector in ancestors {
                let found = self.find(&scope, selector, owner)?;
                if found.len() != 1 {
                    return if found.is_empty() {
                        Ok(vec![])
                    } else {
                        Err("uia:AMBIGUOUS_ELEMENT".into())
                    };
                }
                scope = found[0].clone();
            }
        }
        self.find(&scope, &locator["selector"], owner)
    }
    unsafe fn run(&mut self, method: &str, p: &Value) -> Result<Value> {
        let window = self.guard(p)?;
        let owner = pid(window)?;
        let root = self.api.ElementFromHandle(ComHwnd(window)).map_err(error)?;
        let locator = if p["point"].is_object() {
            if method != "inspectNativeLocator" {
                return Err("uia:INVALID_REQUEST".into());
            }
            let x = p["point"]["x"]
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or("uia:INVALID_REQUEST")?;
            let y = p["point"]["y"]
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or("uia:INVALID_REQUEST")?;
            let r = rect(window)?;
            if x < f64::from(r.left)
                || x >= f64::from(r.right)
                || y < f64::from(r.top)
                || y >= f64::from(r.bottom)
            {
                return Err("uia:INVALID_REQUEST".into());
            }
            // Hit test only this window's control tree. Relay's preview can overlap
            // the real window, so a global ElementFromPoint would inspect Relay instead.
            let mut hits = Vec::new();
            for element in self.find(&root, &json!({}), owner)? {
                self.check()?;
                let r = element.CurrentBoundingRectangle().map_err(error)?;
                if !element.CurrentIsOffscreen().map_err(error)?.as_bool()
                    && x >= f64::from(r.left)
                    && x < f64::from(r.right)
                    && y >= f64::from(r.top)
                    && y < f64::from(r.bottom)
                {
                    hits.push((
                        i64::from(r.right - r.left) * i64::from(r.bottom - r.top),
                        element,
                    ));
                }
            }
            hits.sort_by_key(|v| v.0);
            if hits.len() > 1 && hits[0].0 == hits[1].0 {
                return Err("uia:AMBIGUOUS_ELEMENT".into());
            }
            let element = hits.into_iter().next().ok_or("uia:ELEMENT_NOT_FOUND")?.1;
            self.owned(&element, &root, owner)?;
            if self
                .api
                .CompareElements(&element, &root)
                .map_err(error)?
                .as_bool()
            {
                return Err("uia:ELEMENT_NOT_FOUND".into());
            }
            let properties = self.properties(&element)?;
            let mut selector = json!({"controlType":properties["controlType"]});
            for key in ["automationId", "className"] {
                if properties[key].as_str().is_some_and(|s| !s.is_empty()) {
                    selector[key] = properties[key].clone();
                }
            }
            if selector.get("automationId").is_none() && properties["secure"] != true {
                selector["name"] = properties["name"].clone();
            }
            json!({"version":1,"backend":"uia","selector":selector})
        } else {
            p["locator"].clone()
        };
        let matches = self.resolve(&root, &locator, owner)?;
        let status = match matches.len() {
            0 => "missing",
            1 => "unique",
            _ => "ambiguous",
        };
        if method == "inspectNativeLocator" {
            let mut result = json!({"status":status,"count":matches.len()});
            if matches.len() == 1 {
                self.owned(&matches[0], &root, owner)?;
                result["element"] = self.describe(&matches[0], locator)?;
            }
            self.guard(p)?;
            return Ok(result);
        }
        let element = match matches.len() {
            0 => return Err("uia:ELEMENT_NOT_FOUND".into()),
            1 => &matches[0],
            _ => return Err("uia:AMBIGUOUS_ELEMENT".into()),
        };
        self.owned(element, &root, owner)?;
        let action = str_field(p, "action");
        let descriptor = self.describe(element, locator.clone())?;
        contract::action_guard(&descriptor, action)?;
        self.guard(p)?;
        self.check()?;
        // Recheck sensitive state immediately before provider access. No cached COM reference survives this request.
        if element.CurrentIsPassword().map_err(error)?.as_bool() {
            return Err("uia:SECURE_ELEMENT".into());
        }
        let result = match action {
            "read" => {
                let text = if let Ok(pattern) =
                    element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                {
                    pattern.CurrentValue().map_err(error)?.to_string()
                } else {
                    element.CurrentName().map_err(error)?.to_string()
                };
                if text.chars().count() > 65536 {
                    return Err("uia:SEARCH_LIMIT".into());
                }
                json!(text)
            }
            "invoke" => {
                element
                    .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    .map_err(|_| "uia:UNSUPPORTED_PATTERN")?
                    .Invoke()
                    .map_err(error)?;
                json!(true)
            }
            "setValue" => {
                let text = p["text"]
                    .as_str()
                    .filter(|s| s.chars().count() <= 65536)
                    .ok_or("uia:INVALID_REQUEST")?;
                element
                    .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .map_err(|_| "uia:UNSUPPORTED_PATTERN")?
                    .SetValue(&BSTR::from(text))
                    .map_err(error)?;
                json!(true)
            }
            "select" => {
                element
                    .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                        UIA_SelectionItemPatternId,
                    )
                    .map_err(|_| "uia:UNSUPPORTED_PATTERN")?
                    .Select()
                    .map_err(error)?;
                json!(true)
            }
            _ => return Err("uia:INVALID_REQUEST".into()),
        };
        Ok(result)
    }
}
