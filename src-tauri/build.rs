use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn collect_pdfium_source_candidates(manifest_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();

    if let Ok(custom_path) = env::var("PDFIUM_DYNAMIC_LIB_PATH") {
        let custom = PathBuf::from(custom_path);
        if custom.is_file() {
            candidates.push(custom);
        } else {
            candidates.push(custom.join("pdfium.dll"));
        }
    }

    candidates.push(manifest_dir.join("pdfium.dll"));
    if let Some(workspace_root) = manifest_dir.parent() {
        candidates.push(workspace_root.join("pdfium.dll"));
        candidates.push(workspace_root.join("resources").join("pdfium.dll"));
        candidates.push(workspace_root.join("lib").join("pdfium.dll"));
    }

    if let Some(lib) = find_lib_dir(manifest_dir) {
        candidates.push(lib.join("pdfium.dll"));
    }

    candidates
}

fn find_lib_dir(manifest_dir: &Path) -> Option<PathBuf> {
    for ancestor in manifest_dir.ancestors().take(8) {
        let candidate = ancestor.join("lib").join("llama.dll");
        if candidate.exists() {
            return Some(ancestor.join("lib"));
        }
    }
    let workspace_lib = manifest_dir.parent()?.join("lib");
    workspace_lib.exists().then_some(workspace_lib)
}

fn collect_output_dirs(manifest_dir: &Path) -> Vec<PathBuf> {
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let target = env::var("TARGET").ok();

    let target_dir = env::var("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest_dir.join("target"));

    let mut output_dirs = vec![target_dir.join(&profile)];
    if let Some(target_triple) = target {
        output_dirs.push(target_dir.join(target_triple).join(&profile));
    }

    output_dirs.sort();
    output_dirs.dedup();
    output_dirs
}

fn try_copy_pdfium_dll() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string()));

    let source = collect_pdfium_source_candidates(&manifest_dir)
        .into_iter()
        .find(|p| p.exists());

    let Some(source_dll) = source else {
        println!(
            "cargo:warning=pdfium.dll not found during build. Expected in src-tauri/, lib/, workspace root, resources/, or set PDFIUM_DYNAMIC_LIB_PATH."
        );
        return;
    };

    for dir in collect_output_dirs(&manifest_dir) {
        if let Err(e) = fs::create_dir_all(&dir) {
            println!(
                "cargo:warning=Failed to create output dir {}: {}",
                dir.display(),
                e
            );
            continue;
        }

        let destination = dir.join("pdfium.dll");
        if let Err(e) = fs::copy(&source_dll, &destination) {
            println!(
                "cargo:warning=Failed to copy {} to {}: {}",
                source_dll.display(),
                destination.display(),
                e
            );
        }
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=PDFIUM_DYNAMIC_LIB_PATH");
    println!("cargo:rerun-if-changed=pdfium.dll");
    println!("cargo:rerun-if-changed=../pdfium.dll");
    println!("cargo:rerun-if-changed=../resources/pdfium.dll");
    println!("cargo:rerun-if-changed=../lib/pdfium.dll");

    try_copy_pdfium_dll();

    // Pass grobid assets path to the lib crate (set by grobid-rs build script)
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string()));
    let grobid_assets = manifest_dir.join("target").join("grobid_assets").join("grobid-0.9.1");
    println!("cargo:rustc-env=GROBID_RS_ASSETS_PATH={}", grobid_assets.display());

    tauri_build::build()
}
