//! Reuse immutable flight assets, never the station evidence from an old report.
use super::*;

fn key(m: &Mission) -> String {
    evidence::digest(format!("{}:{}:{}", m.start_time, m.end_time, m.mission_name).as_bytes())
}
fn same_flight(a: &Mission, b: &Mission) -> bool {
    a.start_time == b.start_time && a.end_time == b.end_time && a.mission_name == b.mission_name
}
fn empty_media() -> Media {
    Media { url: format!("https://fh.dji.com{PROJECT}#/plan"), folder: String::new(), files: vec![], file_pages: HashMap::new(), no_media: true, root_folder_id: None }
}
fn air_only(mission: &Mission, air: AirData) -> Collected {
    Collected { data_generation: None, evidence: None, without_air_data: false, local_event_id: None,
        mission: mission.clone(), air, media: empty_media(), photos: vec![] }
}
fn candidates(root: &Path, mission: &Mission, kind: &str) -> Vec<PathBuf> {
    let mut paths = vec![root.join(".cache").join(format!("{}-{kind}.json", key(mission)))];
    // Old reports already contain original images and platform presentations.
    // Read their small summaries first rather than decoding every report's photos.
    let mut saved = vec![];
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let p = entry.path();
            let summary = fs::read(p.join("summary.json")).ok()
                .and_then(|bytes| serde_json::from_slice::<Summary>(&bytes).ok());
            if let Some(s) = summary.filter(|s| s.mission.as_ref().is_some_and(|m| same_flight(m, mission))) {
                saved.push((s.created_at, p.join("source.json")));
            }
        }
    }
    saved.sort_by(|a,b| b.0.cmp(&a.0));
    paths.extend(saved.into_iter().map(|(_,p)|p));
    paths
}
fn read(path: &Path) -> Option<Collected> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}
pub(super) fn air(root: &Path, mission: &Mission, now: i64) -> Option<AirData> {
    candidates(root, mission, "air").into_iter().find_map(|p| {
        let data = read(&p)?;
        if !same_flight(&data.mission, mission) || data.without_air_data || data.air.chart.is_none() { return None; }
        let candidate = air_only(mission, data.air);
        validate(&candidate, now).ok()?;
        Some(candidate.air)
    })
}
pub(super) fn photos(root: &Path, mission: &Mission, media: &Media, now: i64) -> Option<Vec<Photo>> {
    candidates(root, mission, "photos").into_iter().find_map(|p| {
        let mut data = read(&p)?;
        if !same_flight(&data.mission, mission) || data.media.no_media != media.no_media
            || !same_media_folder(&data.media.url, &media.url) || data.media.folder != media.folder
            || data.media.root_folder_id != media.root_folder_id || data.photos.len() != media.files.len()
            || data.media.files.len() != media.files.len() { return None; }
        let mut by_name: HashMap<_,_> = data.photos.into_iter().map(|p|(p.name.clone(),p)).collect();
        let photos: Vec<_> = media.files.iter().map(|n| by_name.remove(n)).collect::<Option<_>>()?;
        for photo in &photos { photo.validate_presentation(now, true).ok()?; }
        data.mission = mission.clone();
        data.media = media.clone();
        data.photos = photos;
        data.without_air_data = true;
        data.air = AirData { url: String::new(), mission_id: 0, unit: String::new(), points: vec![], channels: HashMap::new(), chart: None };
        data.local_event_id = None;
        validate(&data, now).ok()?;
        Some(data.photos)
    })
}
fn write(root: &Path, data: &Collected, kind: &str) -> Result<(), String> {
    let dir = root.join(".cache");
    fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
    let temp = dir.join(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| {
        fs::write(&temp, serde_json::to_vec(data).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        fs::rename(&temp, dir.join(format!("{}-{kind}.json", key(&data.mission)))).map_err(|e|e.to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}
pub(super) fn store_air(root: &Path, mission: &Mission, air: &AirData, now: i64) -> Result<(), String> {
    let data = air_only(mission, air.clone());
    validate(&data, now)?;
    write(root, &data, "air")
}
pub(super) fn store_photos(root: &Path, data: &Collected) -> Result<(), String> {
    let mut data = data.clone();
    data.evidence = None;
    data.data_generation = None;
    data.local_event_id = None;
    data.without_air_data = true;
    data.air = AirData { url: String::new(), mission_id: 0, unit: String::new(), points: vec![], channels: HashMap::new(), chart: None };
    write(root, &data, "photos")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Collected {
        let mut data = super::super::tests::sample();
        let mut bytes = vec![];
        {
            let mut encoder = png::Encoder::new(&mut bytes, 600, 400);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().unwrap().write_image_data(&vec![100; 600 * 400 * 3]).unwrap();
        }
        let url = format!("data:image/png;base64,{}", STANDARD.encode(bytes));
        data.air.chart = Some(air_chart::AirChart {
            method: "airins-page-screenshot".into(), source_channel: "ad_9".into(),
            mission_id: 1, start_time: data.air.points[0].time, end_time: data.air.points[1].time,
            point_count: 2, maximum: 65.0, minimum: 31.0, captured_at: Utc::now().timestamp_millis(),
            width: 600, height: 400, data_url: url.clone(),
        });
        for name in ["DJI_20260922070120_0001_V.jpeg", "DJI_20260922070121_0002_V.jpeg"] {
            data.media.files.push(name.into());
            data.photos.push(Photo { name: name.into(), kind: "visible".into(), data_url: url.clone(),
                presentation: Some(presentation::Presentation { method: "dji-viewer-capture-v1".into(),
                    width: 600, height: 400, image_rect: None, annotation_count: 0, labels: vec![],
                    captured_at: Utc::now().timestamp_millis(), data_url: None }) });
        }
        data
    }
    #[test]
    fn cached_assets_require_matching_identity_and_complete_current_list() {
        let dir = std::env::temp_dir().join(Uuid::new_v4().to_string());
        let data = fixture();
        let now = Utc::now().timestamp_millis();
        validate(&data, now).unwrap();
        store_air(&dir, &data.mission, &data.air, now).unwrap();
        store_photos(&dir, &data).unwrap();
        assert!(air(&dir, &data.mission, now).is_some());
        let mut mission = data.mission.clone(); mission.mission_id += 1;
        assert!(air(&dir, &mission, now).is_none());
        // An Airins association may be added later without invalidating photos.
        assert!(photos(&dir, &mission, &data.media, now).is_some());
        mission.start_time += 1;
        assert!(photos(&dir, &mission, &data.media, now).is_none());
        let mut media = data.media.clone(); media.files.reverse();
        let reused = photos(&dir, &data.mission, &media, now).unwrap();
        assert_eq!(reused[0].name, media.files[0]);
        media.files.pop();
        assert!(photos(&dir, &data.mission, &media, now).is_none());
        media = data.media.clone(); media.files[0] = "DJI_20260922070122_0003_V.jpeg".into();
        assert!(photos(&dir, &data.mission, &media, now).is_none());
        media = data.media.clone(); media.url = media.url.replace("pid=1", "pid=2");
        assert!(photos(&dir, &data.mission, &media, now).is_none());
        let mut broken = data.clone(); broken.photos[0].data_url = "broken".into();
        store_photos(&dir, &broken).unwrap();
        assert!(photos(&dir, &data.mission, &data.media, now).is_none());
        assert!(air(&dir, &data.mission, now).is_some());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn existing_report_is_reused_without_reusing_station_evidence() {
        let dir = std::env::temp_dir().join(Uuid::new_v4().to_string());
        let mut data = fixture();
        data.evidence = Some(Evidence { city_hours: vec![evidence::CityHour {
            time: "2026-09-22 07:00:00".into(), potassium: Some(99.0), pm25: Some(99.0),
            source_url: String::new(), synced_at: String::new(),
        }], ..Default::default() });
        // Archive format used by existing installed versions.
        let report = dir.join(Uuid::new_v4().to_string()); fs::create_dir_all(&report).unwrap();
        fs::write(report.join("source.json"), serde_json::to_vec(&data).unwrap()).unwrap();
        fs::write(report.join("summary.json"), json!({"id":"test", "createdAt":1, "title":"test", "path":"test", "photoCount":2, "pointCount":2, "warning":"", "mission":data.mission}).to_string()).unwrap();
        let now = Utc::now().timestamp_millis();
        assert!(air(&dir, &data.mission, now).is_some());
        assert_eq!(photos(&dir, &data.mission, &data.media, now).unwrap().len(), 2);
        fs::write(report.join("source.json"), "truncated").unwrap();
        assert!(air(&dir, &data.mission, now).is_none());
        assert!(photos(&dir, &data.mission, &data.media, now).is_none());
        fs::remove_dir_all(dir).unwrap();
    }
}
