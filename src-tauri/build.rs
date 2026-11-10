use std::{fs, path::Path};

fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir_all(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let output = target.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &output);
        } else {
            let bytes = fs::read(entry.path()).unwrap();
            write_changed(&output, &bytes);
        }
    }
}

fn write_changed(path: &Path, bytes: &[u8]) {
    if fs::read(path).ok().as_deref() != Some(bytes) {
        fs::write(path, bytes).unwrap();
    }
}

fn version(value: &str) -> [u16; 4] {
    let parts: Vec<_> = value.split('.').collect();
    assert!((1..=4).contains(&parts.len()), "Invalid extension version");
    let mut parsed = [0; 4];
    for (index, part) in parts.iter().enumerate() {
        assert!(!part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
        parsed[index] = part.parse().expect("Invalid extension version component");
    }
    parsed
}

fn main() {
    // Use the same bundled JPEG library on macOS and Windows; no external CLI.
    println!("cargo:rerun-if-changed=src/flight_report/jpeg_lossless.c");
    let includes = std::env::var_os("DEP_JPEG_INCLUDE").expect("bundled JPEG headers");
    cc::Build::new()
        .file("src/flight_report/jpeg_lossless.c")
        .includes(std::env::split_paths(&includes))
        .compile("report_jpeg_lossless");
    // Private release provisioning. Generate into ignored build output rather
    // than printing secrets as cargo:rustc-env (which would leak to build logs).
    let email_defaults = "../.secrets/email-defaults.json";
    println!("cargo:rerun-if-changed={email_defaults}");
    let password = match fs::read(email_defaults) {
        Ok(bytes) => {
            let config: serde_json::Value = serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| panic!("Invalid private email defaults JSON"));
            config["password"]
                .as_str()
                .expect("Missing private SMTP password")
                .to_owned()
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => panic!("Cannot read private email defaults"),
    };
    assert!(
        password.len() <= 512,
        "Invalid private SMTP password length"
    );
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    write_changed(
        &output.join("email-default-password.rs"),
        format!("{password:?}").as_bytes(),
    );
    println!("cargo:rustc-check-cfg=cfg(test_environment)");
    let packaged_test = std::env::var_os("CARGO_FEATURE_TEST_ENVIRONMENT").is_some();
    let test_environment = tauri_build::is_dev() || packaged_test;
    if test_environment {
        println!("cargo:rustc-cfg=test_environment");
    }
    // A test package must never carry the production installer identity.
    if packaged_test && !tauri_build::is_dev() {
        let overlay: serde_json::Value =
            serde_json::from_str(&std::env::var("TAURI_CONFIG").unwrap_or_default())
                .expect("Test packages require --config src-tauri/tauri.test.conf.json");
        assert_eq!(
            overlay["identifier"].as_str(),
            Some("com.taizhou.aai.dev"),
            "Test packages require the test config overlay"
        );
    }
    if !test_environment {
        if let Ok(overlay) = std::env::var("TAURI_CONFIG") {
            let overlay: serde_json::Value =
                serde_json::from_str(&overlay).expect("Invalid config overlay");
            assert_ne!(
                overlay["identifier"].as_str(),
                Some("com.taizhou.aai.dev"),
                "Test config requires --features test-environment when packaging"
            );
        }
    }
    println!("cargo:rerun-if-changed=../bridge-config.json");
    println!("cargo:rerun-if-changed=../extension");
    let config: serde_json::Value =
        serde_json::from_slice(&fs::read("../bridge-config.json").unwrap()).unwrap();
    let minimum = config["minimumExtensionVersion"].as_str().unwrap();
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read("../extension/manifest.json").unwrap()).unwrap();
    assert!(
        version(manifest["version"].as_str().unwrap()) >= version(minimum),
        "Bundled extension is older than minimumExtensionVersion"
    );
    println!("cargo:rustc-env=BRIDGE_MIN_EXTENSION_VERSION={minimum}");
    for (channel, prefix) in [("development", "DEV"), ("production", "PROD")] {
        for field in ["address", "origin"] {
            println!(
                "cargo:rustc-env=BRIDGE_{prefix}_{}={}",
                field.to_uppercase(),
                config[channel][field].as_str().unwrap()
            );
        }
    }
    let endpoint = |channel: &str| {
        format!(
            "export const ENDPOINT = \"http://{}\";\n",
            config[channel]["address"].as_str().unwrap()
        )
    };
    assert_eq!(
        fs::read_to_string("../extension/src/bridge-config.js")
            .unwrap()
            .replace("\r\n", "\n"),
        endpoint("production"),
        "Production extension endpoint must match bridge-config.json"
    );
    // Explicit test packages and tauri dev share the isolated test environment.
    // Ordinary packaged builds (including --debug) remain production.
    if test_environment {
        let output = Path::new("../extension-dev");
        copy_tree(Path::new("../extension"), output);
        manifest["name"] = format!("{} · 开发版", manifest["name"].as_str().unwrap()).into();
        manifest["key"] = config["development"]["key"].clone();
        manifest["action"]["default_title"] = "连接开发版桌面客户端".into();
        write_changed(
            &output.join("manifest.json"),
            serde_json::to_string_pretty(&manifest).unwrap().as_bytes(),
        );
        write_changed(
            &output.join("src/bridge-config.js"),
            endpoint("development").as_bytes(),
        );
    }
    tauri_build::build()
}
