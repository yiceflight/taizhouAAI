//! The original remains the source of EXIF and review identity. A separately
//! captured FlightHub rendering is used only for presentation and DOCX media.
use super::{decode_image, evidence, image_dimensions, Photo};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::Path};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRect {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    pub method: String,
    pub width: i64,
    pub height: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_rect: Option<ImageRect>,
    pub annotation_count: usize,
    pub labels: Vec<String>,
    pub captured_at: i64,
    pub data_url: Option<String>,
}

impl Photo {
    pub fn display_url(&self) -> &str {
        self.presentation
            .as_ref()
            .and_then(|p| p.data_url.as_deref())
            .unwrap_or(&self.data_url)
    }

    pub fn validate_presentation(&self, now: i64, required: bool) -> Result<(), String> {
        let Some(p) = &self.presentation else {
            return if required {
                Err("浏览器插件未核对照片标注，请更新并重新加载插件后重新采集。".into())
            } else {
                Ok(())
            };
        };
        let (original, _) = decode_image(&self.data_url)?;
        let (width, height) = image_dimensions(&original)?;
        let valid_geometry = match p.method.as_str() {
            "dji-viewer-capture-v1" => {
                p.image_rect.is_none() && (p.width, p.height) == (width, height)
            }
            "dji-viewer-capture-v2" => p.image_rect.as_ref().is_some_and(|r| {
                r.width == width
                    && r.height == height
                    && r.x >= 0
                    && r.y >= 0
                    && p.width >= width
                    && p.height >= height
                    && p.width <= width * 3
                    && p.height <= height * 3
                    && r.x <= p.width - width
                    && r.y <= p.height - height
                    && p.width * p.height <= 100_000_000
                    && (p.annotation_count > 0
                        || (r.x == 0 && r.y == 0 && p.width == width && p.height == height))
            }),
            _ => false,
        };
        if !valid_geometry
            || p.annotation_count > 1000
            || p.captured_at <= 0
            || p.captured_at > now.saturating_add(60000)
            || p.labels.len() > 2000
            || p.labels.iter().any(|s| s.len() > 10000)
            || p.labels.iter().map(|s| s.len()).sum::<usize>() > 100000
            || (p.annotation_count == 0 && (!p.labels.is_empty() || p.data_url.is_some()))
        {
            return Err("司空照片标注回执不完整或与原图不符。".into());
        }
        if p.annotation_count > 0 {
            let url = p
                .data_url
                .as_deref()
                .ok_or("司空照片含标注但缺少合成图，已停止生成。")?;
            let (bytes, ext) = decode_image(url)?;
            if ext != "png" || image_dimensions(&bytes)? != (p.width, p.height) {
                return Err("司空标注合成图格式或尺寸与原图不符。".into());
            }
        }
        Ok(())
    }
}

pub fn archive(photos: &[Photo], root: &Path) -> Result<(), String> {
    let mut manifest: Vec<Value> = vec![];
    for (i, photo) in photos.iter().enumerate() {
        let (original, ext) = decode_image(&photo.data_url)?;
        let original_file = format!("photo-{}.{ext}", i + 1);
        fs::write(root.join(&original_file), &original).map_err(|e| e.to_string())?;
        let mut item = json!({"name": photo.name, "originalFile": original_file,
            "originalSha256": evidence::digest(&original), "presentation": null});
        if let Some(p) = &photo.presentation {
            let (display_file, display_hash) = if let Some(url) = &p.data_url {
                let (bytes, _) = decode_image(url)?;
                let file = format!("photo-{}-annotated.png", i + 1);
                fs::write(root.join(&file), &bytes).map_err(|e| e.to_string())?;
                (file, evidence::digest(&bytes))
            } else {
                (original_file, evidence::digest(&original))
            };
            item["presentation"] = json!({"method": p.method, "file": display_file,
                "sha256": display_hash, "width": p.width, "height": p.height,
                "imageRect": p.image_rect,
                "annotationCount": p.annotation_count, "labels": p.labels, "capturedAt": p.captured_at});
        }
        manifest.push(item);
    }
    fs::write(
        root.join("photo-manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::{
        persist,
        tests::{sample, PNG},
        validate, Collected,
    };
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::io::{Cursor, Read};

    fn image(color: u8, width: u32, height: u32) -> String {
        let mut bytes = vec![];
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(png::ColorType::Grayscale);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .unwrap()
                .write_image_data(&vec![color; (width * height) as usize])
                .unwrap();
        }
        format!("data:image/png;base64,{}", STANDARD.encode(bytes))
    }
    fn annotated() -> Collected {
        let mut data = sample();
        data.media.files = vec!["DJI_20260922070121_0001_T.png".into()];
        data.photos = vec![Photo {
            name: data.media.files[0].clone(),
            kind: "司空原始照片".into(),
            data_url: image(30, 640, 480),
            presentation: Some(Presentation {
                method: "dji-viewer-capture-v1".into(),
                width: 640,
                height: 480,
                image_rect: None,
                annotation_count: 2,
                labels: vec!["最高温度: 76.7℃".into(), "最低温度: -2.5℃".into()],
                captured_at: data.mission.end_time + 60000,
                data_url: Some(image(60, 640, 480)),
            }),
        }];
        data
    }
    #[test]
    fn rejects_missing_mismatched_or_inconsistent_capture_but_reads_legacy_archives() {
        let mut data = annotated();
        let now = data.mission.end_time + 120000;
        assert!(validate(&data, now).is_ok());
        let valid = data.photos[0].presentation.clone();
        data.photos[0].presentation = None;
        assert!(data.photos[0].validate_presentation(now, false).is_ok());
        assert!(data.photos[0].validate_presentation(now, true).is_err());
        let legacy: Photo =
            serde_json::from_value(json!({"name":"legacy", "kind":"original", "dataUrl": PNG}))
                .unwrap();
        assert_eq!(legacy.display_url(), PNG);
        for mode in 0..7 {
            data.photos[0].presentation = valid.clone();
            let p = data.photos[0].presentation.as_mut().unwrap();
            match mode {
                0 => p.data_url = None,
                1 => p.data_url = Some(image(60, 320, 240)),
                2 => p.width = 320,
                3 => p.method = "unverified".into(),
                4 => p.captured_at = now + 60001,
                5 => p.annotation_count = 0,
                _ => p.annotation_count = 1001,
            }
            assert!(validate(&data, now).is_err(), "case {mode}");
        }
        let p = data.photos[0].presentation.as_mut().unwrap();
        p.annotation_count = 0;
        p.labels.clear();
        p.data_url = None;
        assert!(validate(&data, now).is_ok());
        assert_eq!(data.photos[0].display_url(), data.photos[0].data_url);
    }
    #[test]
    fn padded_capture_preserves_original_dimensions_inside_a_bounded_canvas() {
        let mut data = annotated();
        let now = data.mission.end_time + 120000;
        let p = data.photos[0].presentation.as_mut().unwrap();
        p.method = "dji-viewer-capture-v2".into();
        p.width = 650;
        p.height = 500;
        p.image_rect = Some(ImageRect {
            x: 4,
            y: 12,
            width: 640,
            height: 480,
        });
        p.data_url = Some(image(60, 650, 500));
        assert!(validate(&data, now).is_ok());
        let good = data.photos[0].presentation.clone();
        for mode in 0..6 {
            data.photos[0].presentation = good.clone();
            let p = data.photos[0].presentation.as_mut().unwrap();
            match mode {
                0 => p.image_rect.as_mut().unwrap().x = -1,
                1 => p.image_rect.as_mut().unwrap().width = 320,
                2 => p.image_rect.as_mut().unwrap().y = 21,
                3 => p.image_rect = None,
                4 => p.width = 1921,
                _ => p.annotation_count = 0,
            }
            assert!(validate(&data, now).is_err(), "padded case {mode}");
        }
    }
    #[test]
    fn word_embeds_annotation_image_and_archive_retains_original_and_both_hashes() {
        let mut data = annotated();
        let p = data.photos[0].presentation.as_mut().unwrap();
        p.method = "dji-viewer-capture-v2".into();
        p.height = 500;
        p.image_rect = Some(ImageRect {
            x: 0,
            y: 20,
            width: 640,
            height: 480,
        });
        p.data_url = Some(image(60, 640, 500));
        let root =
            std::env::temp_dir().join(format!("taizhou-annotations-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let summary = persist(&root, &data, &[PNG.into(), PNG.into()], false).unwrap();
        let dir = Path::new(&summary.path).parent().unwrap();
        let original = decode_image(&data.photos[0].data_url).unwrap().0;
        let display = decode_image(data.photos[0].display_url()).unwrap().0;
        assert_ne!(original, display);
        assert_eq!(fs::read(dir.join("photo-1.png")).unwrap(), original);
        assert_eq!(
            fs::read(dir.join("photo-1-annotated.png")).unwrap(),
            display
        );
        let manifest: Value =
            serde_json::from_slice(&fs::read(dir.join("photo-manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest[0]["originalSha256"], evidence::digest(&original));
        assert_eq!(
            manifest[0]["presentation"]["sha256"],
            evidence::digest(&display)
        );
        assert_eq!(manifest[0]["presentation"]["annotationCount"], 2);
        assert_eq!(manifest[0]["presentation"]["imageRect"]["y"], 20);
        let saved: Collected =
            serde_json::from_slice(&fs::read(dir.join("source.json")).unwrap()).unwrap();
        assert_eq!(saved.photos[0].data_url, data.photos[0].data_url);
        assert_eq!(saved.photos[0].display_url(), data.photos[0].display_url());
        assert_eq!(
            evidence::photo_facts(&original).hash,
            manifest[0]["originalSha256"]
        );
        let mut zip = zip::ZipArchive::new(Cursor::new(fs::read(&summary.path).unwrap())).unwrap();
        let mut document = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut document)
            .unwrap();
        assert_eq!(document.matches("rIdFlight1000").count(), 1, "the media photo belongs only to 表2/附件1");
        assert!(document.contains("高温疑似问题1组"));
        assert!(!document.contains("最低温度:"));
        assert_eq!(summary.issue_count, Some(1));
        assert!(document.contains("最高温度: 76.7℃"));
        let mut bytes = vec![];
        zip.by_name("word/media/flight-1000.png")
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, display);
        assert_eq!(summary.photo_count, 1);
        if let Ok(path) = std::env::var("TAIZHOU_REPORT_QA_PHOTO_SAMPLE") {
            fs::copy(&summary.path, path).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }
}
