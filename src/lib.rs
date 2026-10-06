// zenoh 1.6 builds compile out the connectivity API, leaving its wire types unused
#![cfg_attr(not(zenoh_at_least_1_10), allow(unused_imports, dead_code))]

// zenoh for Deno: a zenoh session inside the Deno process, driven through Deno.dlopen.
//
// The JS side speaks zenoh-ts's remote-api protocol (the same messages zenoh-ts sends a zenohd
// remote-api plugin over a websocket), but the "plugin" (remote_state.rs, from zenoh-ts) runs in
// this library, and payloads may cross as views on native or shared memory instead of copies.

mod interface;
mod payload;
mod remote_state;
mod shm;

use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::Duration,
};

use flume::{Receiver, Sender};
use interface::{InRemoteMessage, OutRemoteMessage, SequenceId};
use remote_state::RemoteState;
use zenoh::{key_expr::keyexpr, Wait};

use crate::interface::{LivelinessTokenId, PublisherId, QuerierId, QueryableId, SubscriberId};

/// Bumped whenever a symbol's signature or a wire format between JS and this library changes.
const ABI_VERSION: u32 = 2;

static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("zenoh-deno")
        .enable_all()
        .build()
        .expect("zenoh-deno: could not start the tokio runtime")
});

// remote_state.rs keeps a per-client record for zenohd's admin space; in-process there is no
// admin space, so only the id is kept.
pub(crate) struct AdminSpaceClient {
    uuid: String,
}

impl AdminSpaceClient {
    pub(crate) fn register_publisher(&mut self, _id: PublisherId, _key_expr: &str) {}
    pub(crate) fn register_subscriber(&mut self, _id: SubscriberId, _key_expr: &str) {}
    pub(crate) fn register_queryable(&mut self, _id: QueryableId, _key_expr: &str) {}
    pub(crate) fn register_querier(&mut self, _id: QuerierId, _key_expr: &str) {}
    pub(crate) fn unregister_publisher(&mut self, _id: PublisherId) {}
    pub(crate) fn unregister_subscriber(&mut self, _id: SubscriberId) {}
    pub(crate) fn unregister_queryable(&mut self, _id: QueryableId) {}
    pub(crate) fn unregister_querier(&mut self, _id: QuerierId) {}
    #[allow(dead_code)]
    pub(crate) fn register_liveliness_token(&mut self, _id: LivelinessTokenId, _key_expr: &str) {}
    pub(crate) fn id(&self) -> &str {
        &self.uuid
    }
}

type Outgoing = (OutRemoteMessage, Option<SequenceId>);

type Incoming = (interface::Header, InRemoteMessage);

struct NativeSession {
    inbox: Sender<Incoming>,
    /// for answering a malformed message without going through the session task
    outbox_sender: Sender<Outgoing>,
    outbox: Receiver<Outgoing>,
    wake_sender: Sender<()>,
    wake_receiver: Receiver<()>,
    /// a message `zd_wait` took off the outbox, handed out first by the next drain
    held: Mutex<Option<Outgoing>>,
    session: zenoh::Session,
}

static SESSIONS: LazyLock<Mutex<HashMap<u32, Arc<NativeSession>>>> = LazyLock::new(Default::default);
static NEXT_SESSION: AtomicU32 = AtomicU32::new(1);

fn session(id: u32) -> Option<Arc<NativeSession>> {
    SESSIONS.lock().unwrap().get(&id).cloned()
}

thread_local! {
    /// the text or bytes a synchronous call produced, fetched by `zd_take_result`
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_result(bytes: impl Into<Vec<u8>>) -> usize {
    let bytes = bytes.into();
    let length = bytes.len();
    RESULT.with(|result| *result.borrow_mut() = bytes);
    length
}

/// # Safety
/// `pointer` must be valid for `length` bytes (Deno passes a buffer argument this way).
unsafe fn slice<'a>(pointer: *const u8, length: usize) -> &'a [u8] {
    if length == 0 || pointer.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(pointer, length)
    }
}

fn write_text(text: &str, out: *mut u8, capacity: usize) -> usize {
    let bytes = text.as_bytes();
    let length = bytes.len().min(capacity);
    if length > 0 && !out.is_null() {
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, length) };
    }
    length
}

/// Keeps this library loaded for the life of the process. Deno closes a `dlopen` handle when the
/// runtime that opened it ends (each `deno test` file, each Worker), and on Windows that unmaps
/// the DLL under the zenoh and tokio threads still running in it. Linux and macOS never unload it
/// anyway (it has thread-local destructors).
fn pin_library() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_PIN};
        let mut module = std::ptr::null_mut();
        unsafe {
            GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                pin_library as *const () as *const u16,
                &mut module,
            );
        }
    }
}

/// JS calls this first, on every load.
#[no_mangle]
pub extern "C" fn zd_abi_version() -> u32 {
    pin_library();
    ABI_VERSION
}

/// The zenoh version this library was built with, as text in the result buffer.
#[no_mangle]
pub extern "C" fn zd_zenoh_version() -> usize {
    set_result(env!("ZENOH_VERSION"))
}

/// The length of what the last synchronous call on this thread produced.
#[no_mangle]
pub extern "C" fn zd_result_length() -> usize {
    RESULT.with(|result| result.borrow().len())
}

/// Copies what the last synchronous call on this thread produced into `out`.
#[no_mangle]
pub unsafe extern "C" fn zd_take_result(out: *mut u8, capacity: usize) -> usize {
    RESULT.with(|result| {
        let result = std::mem::take(&mut *result.borrow_mut());
        let length = result.len().min(capacity);
        if length > 0 {
            std::ptr::copy_nonoverlapping(result.as_ptr(), out, length);
        }
        length
    })
}

/// Starts zenoh's logging; `filter` is a tracing filter such as "info" or "zenoh=debug".
#[no_mangle]
pub unsafe extern "C" fn zd_init_log(filter: *const u8, length: usize) -> i32 {
    let filter = String::from_utf8_lossy(slice(filter, length)).to_string();
    let result = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(filter))
        .with_writer(std::io::stderr)
        .try_init();
    if result.is_ok() {
        0
    } else {
        -1
    }
}

#[no_mangle]
pub extern "C" fn zd_set_zero_copy_threshold(bytes: usize) {
    payload::ZERO_COPY_THRESHOLD.store(bytes, Ordering::Relaxed);
}

/// `{"config": "<JSON5 zenoh config>", "inserts": [["path/to/key", "<JSON5 value>"], ...]}`
fn parse_config(text: &str) -> Result<zenoh::Config, String> {
    let request: serde_json::Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    let json5 = request["config"].as_str().unwrap_or("{}");
    let mut config = zenoh::Config::from_json5(if json5.trim().is_empty() { "{}" } else { json5 }).map_err(|error| error.to_string())?;
    for insert in request["inserts"].as_array().cloned().unwrap_or_default() {
        let (Some(path), Some(value)) = (insert[0].as_str(), insert[1].as_str()) else {
            return Err(format!("bad insert {insert}"));
        };
        config.insert_json5(path, value).map_err(|error| format!("{path} = {value}: {error}"))?;
    }
    Ok(config)
}

/// Opens a session from a config request (see `parse_config`). Blocking (called nonblocking from JS).
/// Returns the session id, or 0 with the error text written to `error_out`.
#[no_mangle]
pub unsafe extern "C" fn zd_open(config: *const u8, config_length: usize, error_out: *mut u8, error_capacity: usize) -> u32 {
    let text = String::from_utf8_lossy(slice(config, config_length)).to_string();
    let error_out = error_out as usize;
    let fail = move |message: String| {
        let length = write_text(&message, error_out as *mut u8, error_capacity);
        if length < error_capacity {
            unsafe { *(error_out as *mut u8).add(length) = 0 };
        }
        0
    };
    let config = match parse_config(&text) {
        Ok(config) => config,
        Err(error) => return fail(format!("invalid zenoh config: {error}")),
    };
    let opened = RUNTIME.block_on(async move { zenoh::open(config).await });
    let session = match opened {
        Ok(session) => session,
        Err(error) => return fail(format!("could not open the zenoh session: {error}")),
    };
    let (inbox, inbox_receiver) = flume::unbounded::<Incoming>();
    let (outbox_sender, outbox) = flume::unbounded::<Outgoing>();
    let (wake_sender, wake_receiver) = flume::unbounded::<()>();
    let uuid = uuid::Uuid::new_v4().to_string();
    let admin_client = Arc::new(Mutex::new(AdminSpaceClient { uuid }));
    let mut remote_state = RemoteState::new(outbox_sender.clone(), admin_client, session.clone());
    let task_outbox = outbox_sender.clone();
    RUNTIME.spawn(async move {
        while let Ok((header, message)) = inbox_receiver.recv_async().await {
            if let Some(response) = handle_message(header, message, &mut remote_state).await {
                if task_outbox.send(response).is_err() {
                    break;
                }
            }
        }
        remote_state.clear().await;
    });
    let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    SESSIONS.lock().unwrap().insert(
        id,
        Arc::new(NativeSession {
            inbox,
            outbox_sender,
            outbox,
            wake_sender,
            wake_receiver,
            held: Mutex::new(None),
            session,
        }),
    );
    id
}

async fn handle_message(header: interface::Header, message: InRemoteMessage, state: &mut RemoteState) -> Option<Outgoing> {
    match state.handle_message(message).await {
        Ok(Some(response)) => Some((response, header.sequence_id)),
        Ok(None) => header.sequence_id.map(|_| {
            (
                OutRemoteMessage::Ok(interface::Ok {
                    content_id: header.content_id,
                }),
                header.sequence_id,
            )
        }),
        Err(error) => {
            tracing::error!("zenoh-deno: {:?} failed: {}", header.content_id, error);
            header.sequence_id.map(|_| (OutRemoteMessage::Error(interface::Error { error: error.to_string() }), header.sequence_id))
        }
    }
}

/// Parses a remote-api message from JS and queues it. Parsing happens here, synchronously, so the
/// payload handles it names are resolved while JS still holds them. Returns 0, -1 if the session
/// is gone, or -2 if the message is malformed (answered with an error if it asked for an answer).
#[no_mangle]
pub unsafe extern "C" fn zd_send(session_id: u32, message: *const u8, length: usize) -> i32 {
    let Some(native) = session(session_id) else {
        return -1;
    };
    match InRemoteMessage::from_wire(bytes::Bytes::copy_from_slice(slice(message, length))) {
        Ok(incoming) => match native.inbox.send(incoming) {
            Ok(()) => 0,
            Err(_) => -1,
        },
        Err(interface::FromWireError::HeaderError(error)) => {
            tracing::error!("zenoh-deno: bad message header: {}", error);
            -2
        }
        Err(interface::FromWireError::BodyError((header, error))) => {
            tracing::error!("zenoh-deno: bad {:?} message: {}", header.content_id, error);
            if header.sequence_id.is_some() {
                let _ = native.outbox_sender.send((OutRemoteMessage::Error(interface::Error { error: error.to_string() }), header.sequence_id));
            }
            -2
        }
    }
}

/// Blocks until a message for JS is ready (1), `zd_wake` is called or the timeout passes (0), or
/// the session is gone (2). Called nonblocking from JS.
#[no_mangle]
pub extern "C" fn zd_wait(session_id: u32, timeout_ms: i32) -> u32 {
    let Some(native) = session(session_id) else {
        return 2;
    };
    if native.held.lock().unwrap().is_some() || !native.outbox.is_empty() {
        return 1;
    }
    let timeout = Duration::from_millis(timeout_ms.max(0) as u64);
    let selected = flume::Selector::new()
        .recv(&native.outbox, |message| message.ok().map(Some))
        .recv(&native.wake_receiver, |_| Some(None))
        .wait_timeout(timeout);
    match selected {
        Ok(Some(Some(message))) => {
            *native.held.lock().unwrap() = Some(message);
            1
        }
        Ok(Some(None)) | Err(_) => 0,
        Ok(None) => 2,
    }
}

/// Makes a pending `zd_wait` return.
#[no_mangle]
pub extern "C" fn zd_wake(session_id: u32) {
    if let Some(native) = session(session_id) {
        let _ = native.wake_sender.send(());
    }
}

/// Serializes the ready messages for JS: each is a u32 little-endian length then its bytes.
/// Returns the total length; read it with `zd_take_result`.
#[no_mangle]
pub extern "C" fn zd_drain(session_id: u32, max_messages: u32) -> usize {
    let Some(native) = session(session_id) else {
        return 0;
    };
    let mut out = Vec::new();
    let mut count = 0;
    let mut next = native.held.lock().unwrap().take();
    while count < max_messages {
        let Some((message, sequence_id)) = next.take().or_else(|| native.outbox.try_recv().ok()) else {
            break;
        };
        let bytes = message.to_wire(sequence_id);
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(&bytes);
        count += 1;
    }
    set_result(out)
}

/// Closes the session (blocking; called nonblocking from JS).
#[no_mangle]
pub extern "C" fn zd_close(session_id: u32) -> i32 {
    let Some(native) = SESSIONS.lock().unwrap().remove(&session_id) else {
        return -1;
    };
    let _ = native.wake_sender.send(());
    let session = native.session.clone();
    // dropping the inbox ends the message loop, which undeclares everything
    drop(native);
    match RUNTIME.block_on(async move { session.close().await }) {
        Ok(()) => 0,
        Err(error) => {
            tracing::error!("zenoh-deno: closing the session: {error}");
            -1
        }
    }
}

/// Frees a received payload JS was viewing (its view was garbage-collected).
#[no_mangle]
pub extern "C" fn zd_view_free(handle: u64) {
    payload::VIEWS.lock().unwrap().remove(&handle);
}

#[no_mangle]
pub extern "C" fn zd_view_count() -> usize {
    payload::VIEWS.lock().unwrap().len()
}

const KEYEXPR_VALIDATE: u8 = 0;
const KEYEXPR_JOIN: u8 = 1;
const KEYEXPR_CONCAT: u8 = 2;
const KEYEXPR_INCLUDES: u8 = 3;
const KEYEXPR_INTERSECTS: u8 = 4;
const KEYEXPR_AUTOCANONIZE: u8 = 5;

/// Key expression operations. Returns 1/0 for includes/intersects and validate, and for join,
/// concat and autocanonize 1 with the key expression as the result; -1 with an error as the result.
#[no_mangle]
pub unsafe extern "C" fn zd_keyexpr(operation: u8, a: *const u8, a_length: usize, b: *const u8, b_length: usize) -> i32 {
    let a = String::from_utf8_lossy(slice(a, a_length)).to_string();
    let b = String::from_utf8_lossy(slice(b, b_length)).to_string();
    let result: Result<i32, String> = (|| {
        let parse = |text: &str| keyexpr::new(text).map(|_| ()).map_err(|error| error.to_string());
        match operation {
            KEYEXPR_VALIDATE => parse(&a).map(|_| 1),
            KEYEXPR_JOIN => {
                let joined = keyexpr::new(&a).map_err(|e| e.to_string())?.join(&b).map_err(|e| e.to_string())?;
                set_result(joined.as_str());
                Ok(1)
            }
            KEYEXPR_CONCAT => {
                let joined = zenoh::key_expr::KeyExpr::try_from(a.as_str()).map_err(|e| e.to_string())?.concat(&b).map_err(|e| e.to_string())?;
                set_result(joined.as_str());
                Ok(1)
            }
            KEYEXPR_INCLUDES => Ok(keyexpr::new(&a).map_err(|e| e.to_string())?.includes(keyexpr::new(&b).map_err(|e| e.to_string())?) as i32),
            KEYEXPR_INTERSECTS => Ok(keyexpr::new(&a).map_err(|e| e.to_string())?.intersects(keyexpr::new(&b).map_err(|e| e.to_string())?) as i32),
            KEYEXPR_AUTOCANONIZE => {
                let canon = zenoh::key_expr::OwnedKeyExpr::autocanonize(a).map_err(|e| e.to_string())?;
                set_result(canon.as_str());
                Ok(1)
            }
            _ => Err(format!("unknown key expression operation {operation}")),
        }
    })();
    match result {
        Ok(value) => value,
        Err(error) => {
            set_result(error);
            -1
        }
    }
}

/// Writes the session's zenoh id (hex) as the result; returns its length (0 if no session).
#[no_mangle]
pub extern "C" fn zd_session_zid(session_id: u32) -> usize {
    match session(session_id) {
        Some(native) => set_result(native.session.info().zid().wait().to_string()),
        None => 0,
    }
}
