fn main() {
    // Detect Xcode developer path dynamically
    let xcode_dev_path = std::process::Command::new("xcode-select")
        .arg("-p")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "/Applications/Xcode.app/Contents/Developer".to_string());

    let private_fw_flag = format!("-F{}/Library/PrivateFrameworks", xcode_dev_path);

    // Compile the ObjC bridge for simulator control (split into modules)
    cc::Build::new()
        .file("objc/sim_bridge.m")
        .file("objc/sim_framework.m")
        .file("objc/sim_encoding.m")
        .file("objc/sim_screen.m")
        .file("objc/sim_input.m")
        .flag("-fobjc-arc")
        .flag("-fmodules")
        .include("objc")
        // Private framework search paths
        .flag("-F/Library/Developer/PrivateFrameworks")
        .flag(&private_fw_flag)
        .compile("sim_bridge");

    // Link required system frameworks
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=CoreGraphics");
    println!("cargo:rustc-link-lib=framework=ImageIO");
    println!("cargo:rustc-link-lib=framework=IOSurface");
    println!("cargo:rustc-link-lib=framework=VideoToolbox");
    println!("cargo:rustc-link-lib=framework=CoreMedia");
    println!("cargo:rustc-link-lib=framework=CoreVideo");
    println!("cargo:rustc-link-lib=framework=AppKit");

    // Rerun if ObjC sources change
    println!("cargo:rerun-if-changed=objc/sim_bridge.m");
    println!("cargo:rerun-if-changed=objc/sim_bridge.h");
    println!("cargo:rerun-if-changed=objc/sim_bridge_internal.h");
    println!("cargo:rerun-if-changed=objc/sim_framework.m");
    println!("cargo:rerun-if-changed=objc/sim_encoding.m");
    println!("cargo:rerun-if-changed=objc/sim_screen.m");
    println!("cargo:rerun-if-changed=objc/sim_input.m");
}
