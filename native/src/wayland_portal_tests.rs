//! Private D-Bus service: exercises the actual portal wire contract, never the
//! user's desktop portal, chooser, session bus, or permission database.
use super::*;
use std::{io::BufRead, process::Child, sync::atomic::AtomicUsize};
use zbus::zvariant::Str;
use zbus::{message::Header, Connection};
#[derive(Default)]
pub(crate) struct Mock {
    code: u32,
    no_serial: bool,
    pub(crate) version: u32,
    pub(crate) fail_close: AtomicBool,
    pub(crate) keys: Mutex<Vec<(i32, u32)>>,
    closed: AtomicUsize,
    selections: Mutex<Vec<Dict>>,
}
#[derive(Clone)]
struct Remote(Arc<Mock>);
#[derive(Clone)]
struct Cast(Arc<Mock>);
struct MockSession(Arc<Mock>);
struct MockRequest(Arc<Mock>);
fn owned(value: impl Into<BusValue<'static>>) -> OwnedValue {
    value.into().try_to_owned().unwrap()
}
async fn reply(
    conn: &Connection,
    header: &Header<'_>,
    options: &Dict,
    state: &Arc<Mock>,
    code: u32,
    body: Dict,
) -> zbus::fdo::Result<OwnedObjectPath> {
    let token = get_string(options, "handle_token").unwrap();
    let sender = header
        .sender()
        .unwrap()
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let path: OwnedObjectPath = format!("{PATH}/request/{sender}/{token}")
        .try_into()
        .unwrap();
    conn.object_server()
        .at(path.clone(), MockRequest(state.clone()))
        .await
        .unwrap();
    conn.emit_signal(
        header.sender().cloned(),
        path.clone(),
        "org.freedesktop.portal.Request",
        "Response",
        &(code, body),
    )
    .await
    .unwrap();
    Ok(path)
}
#[zbus::interface(name = "org.freedesktop.portal.Request")]
impl MockRequest {
    fn close(&self) {
        self.0.closed.fetch_add(1, Ordering::SeqCst);
    }
}
#[zbus::interface(name = "org.freedesktop.portal.Session")]
impl MockSession {
    fn close(&self) -> zbus::fdo::Result<()> {
        self.0.closed.fetch_add(1, Ordering::SeqCst);
        if self.0.fail_close.load(Ordering::SeqCst) {
            return Err(zbus::fdo::Error::Failed("Synthetic close failure".into()));
        }
        Ok(())
    }
}
#[zbus::interface(name = "org.freedesktop.portal.RemoteDesktop")]
impl Remote {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 {
        2
    }
    #[zbus(property)]
    fn available_device_types(&self) -> u32 {
        3
    }
    async fn create_session(
        &self,
        options: Dict,
        #[zbus(connection)] conn: &Connection,
        #[zbus(header)] header: Header<'_>,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        let sender = header
            .sender()
            .unwrap()
            .as_str()
            .trim_start_matches(':')
            .replace('.', "_");
        let token = get_string(&options, "session_handle_token").unwrap();
        let path = format!("{PATH}/session/{sender}/{token}");
        conn.object_server()
            .at(path.clone(), MockSession(self.0.clone()))
            .await
            .unwrap();
        reply(
            conn,
            &header,
            &options,
            &self.0,
            0,
            HashMap::from([("session_handle".into(), OwnedValue::from(Str::from(path)))]),
        )
        .await
    }
    async fn select_devices(
        &self,
        _session: OwnedObjectPath,
        options: Dict,
        #[zbus(connection)] conn: &Connection,
        #[zbus(header)] header: Header<'_>,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        let response = reply(conn, &header, &options, &self.0, 0, HashMap::new()).await;
        self.0.selections.lock().unwrap().push(options);
        response
    }
    async fn start(
        &self,
        _session: OwnedObjectPath,
        _parent: &str,
        options: Dict,
        #[zbus(connection)] conn: &Connection,
        #[zbus(header)] header: Header<'_>,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        let mut props: Dict = HashMap::from([
            ("size".into(), owned((300i32, 150i32))),
            ("logical_size".into(), owned((200i32, 100i32))),
            (
                "mapping_id".into(),
                OwnedValue::from(Str::from("fixture-region")),
            ),
        ]);
        if !self.0.no_serial {
            props.insert("pipewire-serial".into(), owned(9_007_199_254_740_993u64));
        }
        let streams = BusValue::from(vec![(17u32, props)]).try_to_owned().unwrap();
        reply(
            conn,
            &header,
            &options,
            &self.0,
            self.0.code,
            HashMap::from([
                ("devices".into(), owned(3u32)),
                ("streams".into(), streams),
                (
                    "restore_token".into(),
                    OwnedValue::from(Str::from("rotated-private-token")),
                ),
            ]),
        )
        .await
    }
    fn notify_keyboard_keysym(
        &self,
        _session: OwnedObjectPath,
        _options: Dict,
        key: i32,
        state: u32,
    ) {
        self.0.keys.lock().unwrap().push((key, state));
    }
    fn connect_to_eis(
        &self,
        _session: OwnedObjectPath,
        _options: Dict,
    ) -> zbus::fdo::Result<BusFd> {
        Err(zbus::fdo::Error::UnknownMethod(
            "EIS is unsupported by this fixture".into(),
        ))
    }
}
#[zbus::interface(name = "org.freedesktop.portal.ScreenCast")]
impl Cast {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 {
        self.0.version
    }
    #[zbus(property)]
    fn available_source_types(&self) -> u32 {
        3
    }
    #[zbus(property)]
    fn available_cursor_modes(&self) -> u32 {
        1
    }
    async fn select_sources(
        &self,
        _session: OwnedObjectPath,
        options: Dict,
        #[zbus(connection)] conn: &Connection,
        #[zbus(header)] header: Header<'_>,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        reply(conn, &header, &options, &self.0, 0, HashMap::new()).await
    }
}
pub(crate) struct Bus(Child);
impl Drop for Bus {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
pub(crate) fn bus() -> (Bus, String) {
    let mut child = Command::new("dbus-daemon")
        .args(["--session", "--nofork", "--print-address=1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("dbus-daemon is required for isolated portal tests");
    let mut line = String::new();
    std::io::BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    (Bus(child), line.trim().into())
}
pub(crate) async fn setup(address: &str, state: Arc<Mock>) -> (Connection, Portal) {
    let server = zbus::connection::Builder::address(address)
        .unwrap()
        .name(DEST)
        .unwrap()
        .serve_at(PATH, Remote(state.clone()))
        .unwrap()
        .serve_at(PATH, Cast(state))
        .unwrap()
        .build()
        .await
        .unwrap();
    let client = zbus::connection::Builder::address(address)
        .unwrap()
        .build()
        .await
        .unwrap();
    let portal = Portal::with_connection(client).await.unwrap();
    (server, portal)
}
#[test]
fn grant_keeps_logical_geometry_serial_and_rotated_token() {
    let (_bus, address) = bus();
    super::super::wayland::runtime().block_on(async {
        let state = Arc::new(Mock {
            version: 6,
            ..Mock::default()
        });
        let (_server, portal) = setup(&address, state.clone()).await;
        assert_eq!(state.closed.load(Ordering::SeqCst), 0);
        assert!(
            state.selections.lock().unwrap().is_empty(),
            "passive probing must not grant"
        );
        let grant = portal.grant(Some("old-private-token")).await.unwrap();
        assert_eq!(grant.size, (200, 100));
        assert_eq!(grant.serial, Some(9_007_199_254_740_993));
        assert_eq!(grant.node, 17);
        assert_eq!(grant.token.as_deref(), Some("rotated-private-token"));
        assert_eq!(
            get_string(&state.selections.lock().unwrap()[0], "restore_token").as_deref(),
            Some("old-private-token")
        );
        assert!(portal.eis(&grant.path).await.unwrap().is_none());
        portal.close(&grant.path).await.unwrap();
        assert_eq!(state.closed.load(Ordering::SeqCst), 1);
    });
}
#[test]
fn cancellation_and_missing_modern_identity_close_the_session() {
    for (code, no_serial, expected) in [
        (1, false, "wayland:CANCELLED"),
        (2, false, "wayland:PERMISSION_DENIED"),
        (0, true, "wayland:CAPABILITY_MISSING"),
    ] {
        let (_bus, address) = bus();
        super::super::wayland::runtime().block_on(async {
            let state = Arc::new(Mock {
                version: 6,
                code,
                no_serial,
                ..Mock::default()
            });
            let (_server, portal) = setup(&address, state.clone()).await;
            assert_eq!(portal.grant(None).await.err().unwrap(), expected);
            assert!(state.closed.load(Ordering::SeqCst) >= 1);
        });
    }
}
#[test]
fn session_closed_and_portal_owner_loss_invalidate_immediately() {
    for owner_loss in [false, true] {
        let (_bus, address) = bus();
        super::super::wayland::runtime().block_on(async {
            let state = Arc::new(Mock {
                version: 5,
                ..Mock::default()
            });
            let (server, portal) = setup(&address, state).await;
            let grant = portal.grant(None).await.unwrap();
            let closed = Arc::new(AtomicBool::new(false));
            let ended = Arc::new(AtomicBool::new(false));
            let watcher = portal
                .watch(
                    &grant.path,
                    closed.clone(),
                    ended.clone(),
                    Arc::new(Mutex::new(None)),
                )
                .await
                .unwrap();
            if owner_loss {
                server.release_name(DEST).await.unwrap();
            } else {
                server
                    .emit_signal(
                        None::<&str>,
                        grant.path,
                        "org.freedesktop.portal.Session",
                        "Closed",
                        &(HashMap::<String, OwnedValue>::new(),),
                    )
                    .await
                    .unwrap();
            }
            tokio::time::timeout(Duration::from_secs(2), watcher)
                .await
                .unwrap()
                .unwrap();
            assert!(closed.load(Ordering::SeqCst));
            assert!(ended.load(Ordering::SeqCst));
        });
    }
}
