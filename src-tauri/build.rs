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
        fs::read_to_string("../extension/src/bridge-config.js").unwrap(),
        endpoint("production"),
        "Production extension endpoint must match bridge-config.json"
    );
    // Only tauri dev uses the generated extension. Packaged builds (including
    // --debug) retain the production identity, port and resource directory.
    if tauri_build::is_dev() {
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
