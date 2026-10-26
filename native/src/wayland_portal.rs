//! Typed access to portal dictionaries, retaining modern stream identity fields.
use super::*;
use futures_util::StreamExt;
use std::{collections::HashMap, os::fd::OwnedFd, sync::atomic::AtomicU64};
use zbus::{
    self,
    zvariant::{OwnedFd as BusFd, OwnedObjectPath, OwnedValue, Value as BusValue},
};
type Dict = HashMap<String, OwnedValue>;
static REQUEST: AtomicU64 = AtomicU64::new(1);
const DEST: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
pub struct Portal {
    pub connection: zbus::Connection,
    remote: zbus::Proxy<'static>,
    cast: zbus::Proxy<'static>,
    pub remote_version: u32,
    pub cast_version: u32,
    pub devices: u32,
    pub sources: u32,
    pub cursors: u32,
    pub identity: &'static str,
}
pub struct Grant {
    pub path: OwnedObjectPath,
    pub node: u32,
    pub serial: Option<u64>,
    pub size: (i32, i32),
    pub mapping: Option<String>,
    pub token: Option<String>,
}
fn fail(_: impl std::fmt::Debug) -> String {
    "wayland:PORTAL_UNAVAILABLE".into()
}
pub async fn bounded<T>(
    future: impl std::future::Future<Output = std::result::Result<T, zbus::Error>>,
) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(3), future)
        .await
        .map_err(|_| "wayland:PORTAL_TIMEOUT")?
        .map_err(fail)
}
fn get_u32(d: &Dict, k: &str) -> Option<u32> {
    d.get(k).and_then(|v| u32::try_from(v).ok())
}
fn get_string(d: &Dict, k: &str) -> Option<String> {
    d.get(k)
        .and_then(|v| <&str>::try_from(v).ok())
        .map(str::to_owned)
}
async fn register_identity(connection: &zbus::Connection) -> Result<&'static str> {
    // The Registry requires an installed matching desktop file. Source runs may
    // remain anonymous; they must not pretend to have installed-app permissions.
    let mut roots = Vec::new();
    if let Some(path) = std::env::var_os("XDG_DATA_HOME") {
        roots.push(std::path::PathBuf::from(path));
    } else if let Some(home) = std::env::var_os("HOME") {
        roots.push(std::path::PathBuf::from(home).join(".local/share"));
    }
    roots.extend(std::env::split_paths(
        &std::env::var_os("XDG_DATA_DIRS").unwrap_or_else(|| "/usr/local/share:/usr/share".into()),
    ));
    if !roots.iter().any(|root| {
        root.join("applications/dev.relay.desktop.desktop")
            .is_file()
    }) {
        return Ok("unregistered");
    }
    let registry = bounded(zbus::Proxy::new_owned(
        connection.clone(),
        DEST,
        PATH,
        "org.freedesktop.host.portal.Registry",
    ))
    .await?;
    match tokio::time::timeout(
        Duration::from_secs(3),
        registry.call::<_, _, ()>(
            "Register",
            &("dev.relay.desktop", HashMap::<&str, BusValue>::new()),
        ),
    )
    .await
    {
        Ok(Ok(())) => Ok("dev.relay.desktop"),
        Ok(Err(zbus::Error::MethodError(name, _, _)))
            if [
                "org.freedesktop.DBus.Error.UnknownMethod",
                "org.freedesktop.DBus.Error.UnknownInterface",
            ]
            .contains(&name.as_str()) =>
        {
            Ok("unregistered")
        }
        _ => Err("wayland:PORTAL_UNAVAILABLE".into()),
    }
}
impl Portal {
    pub async fn new() -> Result<Self> {
        let connection = bounded(zbus::Connection::session()).await?;
        let identity = register_identity(&connection).await?;
        let mut portal = Self::with_connection(connection).await?;
        portal.identity = identity;
        Ok(portal)
    }
    async fn with_connection(connection: zbus::Connection) -> Result<Self> {
        let remote = bounded(zbus::Proxy::new_owned(
            connection.clone(),
            DEST,
            PATH,
            "org.freedesktop.portal.RemoteDesktop",
        ))
        .await?;
        let cast = bounded(zbus::Proxy::new_owned(
            connection.clone(),
            DEST,
            PATH,
            "org.freedesktop.portal.ScreenCast",
        ))
        .await?;
        Ok(Self {
            remote_version: bounded(remote.get_property("version")).await?,
            cast_version: bounded(cast.get_property("version")).await?,
            devices: bounded(remote.get_property("AvailableDeviceTypes")).await?,
            sources: bounded(cast.get_property("AvailableSourceTypes")).await?,
            cursors: bounded(cast.get_property("AvailableCursorModes"))
                .await
                .unwrap_or(1),
            connection,
            remote,
            cast,
            identity: "unregistered",
        })
    }
    async fn request(
        &self,
        proxy: &zbus::Proxy<'_>,
        method: &str,
        session: Option<&OwnedObjectPath>,
        mut options: HashMap<&str, BusValue<'_>>,
        chooser: bool,
    ) -> Result<Dict> {
        let token = format!(
            "relay_{}_{}",
            std::process::id(),
            REQUEST.fetch_add(1, Ordering::Relaxed)
        );
        let sender = self
            .connection
            .unique_name()
            .ok_or("wayland:PORTAL_UNAVAILABLE")?
            .as_str()
            .trim_start_matches(':')
            .replace('.', "_");
        let expected = format!("{PATH}/request/{sender}/{token}");
        let request = bounded(zbus::Proxy::new_owned(
            self.connection.clone(),
            DEST,
            expected.clone(),
            "org.freedesktop.portal.Request",
        ))
        .await?;
        let mut response = bounded(request.receive_signal("Response")).await?;
        options.insert("handle_token", BusValue::from(token.as_str()));
        let returned: OwnedObjectPath = if method == "Start" {
            bounded(proxy.call(method, &(session.unwrap(), "", options))).await?
        } else if let Some(s) = session {
            bounded(proxy.call(method, &(s, options))).await?
        } else {
            bounded(proxy.call(method, &(options,))).await?
        };
        if returned.as_str() != expected {
            let _: std::result::Result<(), _> = request.call("Close", &()).await;
            return Err("wayland:PORTAL_UNAVAILABLE".into());
        }
        let deadline =
            std::time::Instant::now() + Duration::from_secs(if chooser { 110 } else { 5 });
        let result = loop {
            if super::wayland::cancelled() {
                break Err("wayland:CANCELLED".into());
            }
            if std::time::Instant::now() >= deadline {
                break Err("wayland:PORTAL_TIMEOUT".into());
            }
            match tokio::time::timeout(Duration::from_millis(25), response.next()).await {
                Err(_) => continue,
                Ok(Some(message)) => {
                    let (code, dict): (u32, Dict) = message.body().deserialize().map_err(fail)?;
                    break match code {
                        0 => Ok(dict),
                        1 => Err("wayland:CANCELLED".into()),
                        _ => Err("wayland:PERMISSION_DENIED".into()),
                    };
                }
                Ok(None) => break Err("wayland:SESSION_CLOSED".into()),
            }
        };
        if result.is_err() {
            let _ = bounded(request.call::<_, _, ()>("Close", &())).await;
        }
        result
    }
    pub async fn grant(&self, restore: Option<&str>) -> Result<Grant> {
        if self.devices & 3 != 3 || self.sources & 3 == 0 {
            return Err("wayland:CAPABILITY_MISSING".into());
        }
        let session_token = format!(
            "relay_session_{}_{}",
            std::process::id(),
            REQUEST.fetch_add(1, Ordering::Relaxed)
        );
        let created = self
            .request(
                &self.remote,
                "CreateSession",
                None,
                HashMap::from([(
                    "session_handle_token",
                    BusValue::from(session_token.as_str()),
                )]),
                false,
            )
            .await?;
        let path: OwnedObjectPath = get_string(&created, "session_handle")
            .ok_or("wayland:PORTAL_UNAVAILABLE")?
            .try_into()
            .map_err(fail)?;
        let result = async {
            let mut options = HashMap::from([("types", BusValue::from(3u32))]);
            if self.remote_version >= 2 {
                options.insert("persist_mode", BusValue::from(1u32));
                if let Some(token) = restore {
                    options.insert("restore_token", BusValue::from(token));
                }
            }
            self.request(&self.remote, "SelectDevices", Some(&path), options, false)
                .await?;
            let cursor = if self.cursors & 1 != 0 {
                1u32
            } else if self.cursors & 2 != 0 {
                2
            } else {
                return Err("wayland:CAPABILITY_MISSING".into());
            };
            self.request(
                &self.cast,
                "SelectSources",
                Some(&path),
                HashMap::from([
                    ("types", BusValue::from(self.sources & 3)),
                    ("multiple", BusValue::from(false)),
                    ("cursor_mode", BusValue::from(cursor)),
                ]),
                false,
            )
            .await?;
            let mut selected = self
                .request(&self.remote, "Start", Some(&path), HashMap::new(), true)
                .await?;
            if get_u32(&selected, "devices").unwrap_or(0) & 3 != 3 {
                return Err("wayland:PERMISSION_DENIED".into());
            }
            let streams: Vec<(u32, Dict)> = selected
                .remove("streams")
                .ok_or("wayland:CAPTURE_UNAVAILABLE")?
                .try_into()
                .map_err(fail)?;
            if streams.len() != 1 {
                return Err("wayland:CAPTURE_UNAVAILABLE".into());
            }
            let (node, props) = streams.into_iter().next().unwrap();
            let size = props
                .get("logical_size")
                .or_else(|| props.get("size"))
                .and_then(|v| v.try_clone().ok())
                .and_then(|v| <(i32, i32)>::try_from(v).ok())
                .filter(|(w, h)| *w > 0 && *h > 0)
                .ok_or("wayland:GEOMETRY_UNKNOWN")?;
            let serial = props
                .get("pipewire-serial")
                .and_then(|v| u64::try_from(v).ok());
            // Modern portals promise a nonreusable identity; do not downgrade it.
            if self.cast_version >= 6 && serial.is_none() {
                return Err("wayland:CAPABILITY_MISSING".into());
            }
            Ok(Grant {
                path: path.clone(),
                node,
                serial,
                size,
                mapping: get_string(&props, "mapping_id"),
                token: get_string(&selected, "restore_token"),
            })
        }
        .await;
        if result.is_err() {
            let _ = self.close(&path).await;
        }
        result
    }
    pub async fn pipewire(&self, path: &OwnedObjectPath) -> Result<OwnedFd> {
        let fd: BusFd = bounded(self.cast.call(
            "OpenPipeWireRemote",
            &(path, HashMap::<&str, BusValue>::new()),
        ))
        .await?;
        Ok(fd.into())
    }
    pub async fn eis(&self, path: &OwnedObjectPath) -> Result<Option<OwnedFd>> {
        if self.remote_version < 2 {
            return Ok(None);
        }
        match tokio::time::timeout(
            Duration::from_secs(3),
            self.remote
                .call::<_, _, BusFd>("ConnectToEIS", &(path, HashMap::<&str, BusValue>::new())),
        )
        .await
        {
            Ok(Ok(fd)) => Ok(Some(fd.into())),
            Ok(Err(zbus::Error::MethodError(name, _, _)))
                if [
                    "org.freedesktop.DBus.Error.UnknownMethod",
                    "org.freedesktop.portal.Error.NotImplemented",
                    "org.freedesktop.DBus.Error.NotSupported",
                ]
                .contains(&name.as_str()) =>
            {
                Ok(None)
            }
            // Only an explicitly unsupported method permits legacy input. Denial,
            // timeout and post-connect failures never silently change transport.
            _ => Err("wayland:EIS_UNAVAILABLE".into()),
        }
    }
    pub async fn notify<B>(&self, method: &str, body: &B) -> Result<()>
    where
        B: serde::ser::Serialize + zbus::zvariant::DynamicType,
    {
        bounded(self.remote.call(method, body)).await
    }
    pub async fn close(&self, path: &OwnedObjectPath) -> Result<()> {
        let proxy = bounded(zbus::Proxy::new_owned(
            self.connection.clone(),
            DEST,
            path.clone(),
            "org.freedesktop.portal.Session",
        ))
        .await?;
        match bounded(proxy.call("Close", &())).await {
            Ok(()) => Ok(()),
            Err(error) => Err(error),
        }
    }
    pub async fn watch(
        &self,
        path: &OwnedObjectPath,
        closed: Arc<AtomicBool>,
        ended: Arc<AtomicBool>,
        killer: Arc<Mutex<Option<std::process::Child>>>,
    ) -> Result<tokio::task::JoinHandle<()>> {
        let proxy = bounded(zbus::Proxy::new_owned(
            self.connection.clone(),
            DEST,
            path.clone(),
            "org.freedesktop.portal.Session",
        ))
        .await?;
        let mut events = bounded(proxy.receive_signal("Closed")).await?;
        let mut owners = bounded(self.remote.receive_owner_changed()).await?;
        Ok(tokio::spawn(async move {
            tokio::select! {_=events.next()=>{},_=owners.next()=>{}}
            ended.store(true, Ordering::SeqCst);
            closed.store(true, Ordering::SeqCst);
            if let Ok(mut child) = killer.lock() {
                if let Some(mut p) = child.take() {
                    let _ = p.kill();
                    let _ = p.wait();
                }
            }
        }))
    }
}

#[cfg(test)]
#[path = "wayland_portal_tests.rs"]
pub(crate) mod tests;
