// Embed the app icon and version information in the Windows executable.
fn main() {
    println!("cargo:rerun-if-changed=../assets/icon/icon.ico");
    println!("cargo:rerun-if-env-changed=SPOOFER_VERSION");
    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../assets/icon/icon.ico");
        res.set("ProductName", "Location Spoofer");
        res.set("FileDescription", "Location Spoofer");
        res.set("CompanyName", "YK3D");
        res.set("LegalCopyright", "Copyright (c) 2026 YK3D. All rights reserved. See LICENSE.");
        if let Err(e) = res.compile() {
            println!("cargo:warning=could not embed the Windows icon: {e}");
        }
    }
}
