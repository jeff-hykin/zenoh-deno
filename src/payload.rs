// Payloads cross the FFI boundary either inline (copied) or as a handle to native memory that JS
// views in place. Wire format, one tag byte then:
//   0 inline:       bytes
//   1 native view:  u64 handle, u64 address, u64 length, bool is_shm   (native -> JS only)
//   2 shm buffer:   u64 handle of a ZShmMut JS allocated and filled     (JS -> native, consumed)
//   3 native view:  u64 handle of a payload JS received earlier         (JS -> native, shared)

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        LazyLock, Mutex,
    },
};

use zenoh::{bytes::ZBytes, shm::ZShmMut};
use zenoh_ext::{Deserialize, ZDeserializeError, ZDeserializer, ZSerializer};

const TAG_INLINE: u8 = 0;
const TAG_NATIVE_VIEW: u8 = 1;
const TAG_SHM_BUFFER: u8 = 2;
const TAG_NATIVE_HANDLE: u8 = 3;

/// Payloads at least this long are handed to JS as views on native memory instead of copies.
pub(crate) static ZERO_COPY_THRESHOLD: AtomicUsize = AtomicUsize::new(4096);

static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

pub(crate) fn next_handle() -> u64 {
    NEXT_HANDLE.fetch_add(1, Ordering::Relaxed)
}

/// Received payloads JS is viewing; each stays alive until JS's view of it is garbage-collected.
pub(crate) static VIEWS: LazyLock<Mutex<HashMap<u64, ZBytes>>> = LazyLock::new(Default::default);

/// Shared-memory buffers JS allocated and is writing into; taken out when published.
pub(crate) static SHM_BUFFERS: LazyLock<Mutex<HashMap<u64, ZShmMut>>> = LazyLock::new(Default::default);

/// A payload arriving from JS, already turned into the ZBytes zenoh sends.
pub(crate) struct WirePayload(pub(crate) ZBytes);

impl From<WirePayload> for ZBytes {
    fn from(payload: WirePayload) -> Self {
        payload.0
    }
}

impl Deserialize for WirePayload {
    fn deserialize(deserializer: &mut ZDeserializer) -> Result<Self, ZDeserializeError> {
        let tag: u8 = deserializer.deserialize()?;
        match tag {
            TAG_INLINE => Ok(WirePayload(ZBytes::from(deserializer.deserialize::<Vec<u8>>()?))),
            TAG_SHM_BUFFER => {
                let handle: u64 = deserializer.deserialize()?;
                match SHM_BUFFERS.lock().unwrap().remove(&handle) {
                    Some(buffer) => Ok(WirePayload(ZBytes::from(buffer))),
                    None => {
                        tracing::error!("shared-memory buffer {handle} was already published or freed");
                        Err(ZDeserializeError)
                    }
                }
            }
            TAG_NATIVE_HANDLE => {
                let handle: u64 = deserializer.deserialize()?;
                match VIEWS.lock().unwrap().get(&handle) {
                    Some(bytes) => Ok(WirePayload(bytes.clone())),
                    None => {
                        tracing::error!("payload {handle} was already freed");
                        Err(ZDeserializeError)
                    }
                }
            }
            _ => Err(ZDeserializeError),
        }
    }
}

/// Writes a payload going to JS: small ones inline, big ones as a view on native memory.
pub(crate) fn serialize_payload(serializer: &mut ZSerializer, payload: &ZBytes) {
    if payload.len() < ZERO_COPY_THRESHOLD.load(Ordering::Relaxed) {
        serializer.serialize(TAG_INLINE);
        serializer.serialize(payload.to_bytes());
        return;
    }
    let is_shm = payload.as_shm().is_some();
    // a payload in one piece is viewed where it is; a fragmented one is joined once
    let owned = match payload.to_bytes() {
        std::borrow::Cow::Borrowed(_) => payload.clone(),
        std::borrow::Cow::Owned(joined) => ZBytes::from(joined),
    };
    let (address, length) = {
        let bytes = owned.to_bytes();
        (bytes.as_ptr() as u64, bytes.len() as u64)
    };
    let handle = next_handle();
    VIEWS.lock().unwrap().insert(handle, owned);
    serializer.serialize(TAG_NATIVE_VIEW);
    serializer.serialize(handle);
    serializer.serialize(address);
    serializer.serialize(length);
    serializer.serialize(is_shm);
}
