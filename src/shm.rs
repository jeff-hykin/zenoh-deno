// Shared-memory providers and the buffers JS fills before publishing them without a copy.

use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
};

use zenoh::{
    shm::{BlockOn, Defragment, GarbageCollect, JustAlloc, PosixShmProviderBackend, ShmProvider, ShmProviderBuilder, ZShmMut},
    Wait,
};

use crate::{
    payload::{next_handle, SHM_BUFFERS},
    set_result,
};

type Provider = ShmProvider<PosixShmProviderBackend>;

static PROVIDERS: LazyLock<Mutex<HashMap<u64, Arc<Provider>>>> = LazyLock::new(Default::default);

fn provider(handle: u64) -> Option<Arc<Provider>> {
    PROVIDERS.lock().unwrap().get(&handle).cloned()
}

/// Creates a provider owning `size` bytes of shared memory. Returns its handle, or 0 with the error as the result.
#[no_mangle]
pub extern "C" fn zd_shm_provider_new(size: usize) -> u64 {
    match ShmProviderBuilder::default_backend(size).wait() {
        Ok(created) => {
            let handle = next_handle();
            PROVIDERS.lock().unwrap().insert(handle, Arc::new(created));
            handle
        }
        Err(error) => {
            set_result(format!("could not create a shared-memory provider of {size} bytes: {error}"));
            0
        }
    }
}

/// Forgets a provider; its memory is released once every buffer from it is gone.
#[no_mangle]
pub extern "C" fn zd_shm_provider_free(handle: u64) {
    PROVIDERS.lock().unwrap().remove(&handle);
}

#[no_mangle]
pub extern "C" fn zd_shm_provider_available(handle: u64) -> usize {
    provider(handle).map(|provider| provider.available()).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn zd_shm_provider_garbage_collect(handle: u64) -> usize {
    provider(handle).map(|provider| provider.garbage_collect()).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn zd_shm_provider_defragment(handle: u64) -> usize {
    provider(handle).map(|provider| provider.defragment()).unwrap_or(0)
}

pub(crate) const POLICY_JUST_ALLOC: u8 = 0;
pub(crate) const POLICY_GARBAGE_COLLECT: u8 = 1;
pub(crate) const POLICY_DEFRAGMENT: u8 = 2;
pub(crate) const POLICY_BLOCK: u8 = 3;

/// Allocates `length` bytes. Policies: 0 just allocate, 1 garbage-collect then retry, 2 also
/// defragment, 3 also wait until memory frees up (blocking; called nonblocking from JS).
/// Returns the buffer's handle, or 0 with the error as the result (on this thread).
#[no_mangle]
pub extern "C" fn zd_shm_alloc(provider_handle: u64, length: usize, policy: u8) -> u64 {
    let Some(provider) = provider(provider_handle) else {
        set_result("the shared-memory provider was freed");
        return 0;
    };
    let builder = provider.alloc(length);
    let allocated: Result<ZShmMut, String> = match policy {
        POLICY_JUST_ALLOC => builder.with_policy::<JustAlloc>().wait().map_err(|error| format!("{error:?}")),
        POLICY_GARBAGE_COLLECT => builder.with_policy::<GarbageCollect>().wait().map_err(|error| format!("{error:?}")),
        POLICY_DEFRAGMENT => builder.with_policy::<Defragment<GarbageCollect>>().wait().map_err(|error| format!("{error:?}")),
        POLICY_BLOCK => builder.with_policy::<BlockOn<Defragment<GarbageCollect>>>().wait().map_err(|error| format!("{error:?}")),
        _ => Err(format!("unknown allocation policy {policy}")),
    };
    match allocated {
        Ok(buffer) => {
            let handle = next_handle();
            SHM_BUFFERS.lock().unwrap().insert(handle, buffer);
            handle
        }
        Err(error) => {
            set_result(format!("could not allocate {length} bytes of shared memory: {error}"));
            0
        }
    }
}

/// The address of a buffer's bytes, for JS to view and write in place (null if it is gone).
#[no_mangle]
pub extern "C" fn zd_shm_buffer_address(handle: u64) -> *mut u8 {
    match SHM_BUFFERS.lock().unwrap().get_mut(&handle) {
        Some(buffer) => buffer.as_mut().as_mut_ptr(),
        None => std::ptr::null_mut(),
    }
}

/// Frees a buffer that was never published.
#[no_mangle]
pub extern "C" fn zd_shm_buffer_free(handle: u64) {
    SHM_BUFFERS.lock().unwrap().remove(&handle);
}
