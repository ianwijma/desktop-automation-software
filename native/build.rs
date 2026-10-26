use std::{env, path::PathBuf, process::Command};
fn main() {
    println!("cargo:rerun-if-changed=macos/RelayMacOS.m");
    println!("cargo:rerun-if-changed=macos/Fixture.m");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        other => panic!("Unsupported macOS architecture: {other}"),
    };
    let object = output.join("RelayMacOS.o");
    let status = Command::new("xcrun")
        .args([
            "clang",
            "-arch",
            arch,
            "-mmacosx-version-min=14.0",
            "-fobjc-arc",
            "-fblocks",
            "-O2",
            "-Wall",
            "-c",
            "macos/RelayMacOS.m",
            "-o",
        ])
        .arg(&object)
        .status()
        .expect("Xcode command line tools are required");
    assert!(
        status.success(),
        "macOS framework bridge compilation failed"
    );
    assert!(Command::new("ar")
        .arg("crs")
        .arg(output.join("librelay_macos.a"))
        .arg(object)
        .status()
        .unwrap()
        .success());
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=relay_macos");
    for framework in [
        "AppKit",
        "Foundation",
        "ScreenCaptureKit",
        "ApplicationServices",
        "CoreGraphics",
        "CoreMedia",
        "CoreVideo",
        "CoreImage",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rustc-link-lib=objc");
    println!("cargo:rustc-link-arg=-mmacosx-version-min=14.0");
    // The standalone AppKit fixture is excluded by the packaging resource filter.
    let profile = output.ancestors().nth(3).unwrap();
    assert!(Command::new("xcrun")
        .args([
            "clang",
            "-arch",
            arch,
            "-mmacosx-version-min=14.0",
            "-fobjc-arc",
            "-fblocks",
            "-O2",
            "macos/Fixture.m",
            "-framework",
            "AppKit",
            "-framework",
            "Foundation",
            "-framework",
            "CoreGraphics",
            "-framework",
            "Metal",
            "-framework",
            "QuartzCore",
            "-o"
        ])
        .arg(profile.join("relay-appkit-fixture"))
        .status()
        .unwrap()
        .success());
}
