// Each native/zenoh-<version>/ manifest builds the same source against that zenoh version.
fn main() {
    let manifest_directory = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let directory_name = std::path::Path::new(&manifest_directory).file_name().unwrap().to_string_lossy().to_string();
    let version = directory_name.strip_prefix("zenoh-").expect("native/zenoh-<version>/Cargo.toml");
    println!("cargo:rustc-env=ZENOH_VERSION={version}");
    let mut parts = version.split('.').map(|part| part.parse::<u32>().unwrap());
    let (major, minor) = (parts.next().unwrap(), parts.next().unwrap());
    // cfg(zenoh_at_least_1_10) etc., for the APIs older zenoh versions lack
    for known_minor in [6, 7, 8, 9, 10, 11, 12] {
        println!("cargo::rustc-check-cfg=cfg(zenoh_at_least_1_{known_minor})");
        if major > 1 || minor >= known_minor {
            println!("cargo:rustc-cfg=zenoh_at_least_1_{known_minor}");
        }
    }
}
