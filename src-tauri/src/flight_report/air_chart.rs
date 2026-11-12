use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirChart {
    #[serde(default)]
    pub map: Option<AirMap>,
    pub method: String,
    pub source_channel: String,
    pub mission_id: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub point_count: usize,
    pub maximum: f64,
    pub minimum: f64,
    pub captured_at: i64,
    pub width: i64,
    pub height: i64,
    pub data_url: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirMap {
    pub method: String,
    pub mission_id: u64,
    pub source_channel: String,
    pub captured_at: i64,
    pub width: i64,
    pub height: i64,
    pub original_width: i64,
    pub original_height: i64,
    pub crop: MapCrop,
    pub padding_ratio: f64,
    pub legend_labels: Vec<String>,
    pub data_url: String,
    pub original_data_url: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct MapCrop { pub x: i64, pub y: i64, pub width: i64, pub height: i64 }

pub fn validate(air: &AirData) -> Result<(), String> {
    let Some(chart) = &air.chart else { return Ok(()) };
    let values: Vec<_> = air.points.iter().filter_map(|p| p.pm25).collect();
    if chart.method != "airins-page-screenshot" || chart.source_channel != "ad_9"
        || chart.mission_id != air.mission_id || chart.point_count != air.points.len()
        || Some(chart.start_time) != air.points.iter().map(|p| p.time).min()
        || Some(chart.end_time) != air.points.iter().map(|p| p.time).max()
        || values.is_empty() || chart.maximum != values.iter().copied().fold(f64::NEG_INFINITY, f64::max)
        || chart.minimum != values.iter().copied().fold(f64::INFINITY, f64::min)
        || chart.captured_at < chart.end_time || chart.width < 500 || chart.height < 150
        || chart.width > 10000 || chart.height > 10000 || chart.width * chart.height > 20000000
    { return Err("可飞 PM2.5 截图与本航次采样不匹配".into()); }
    let (bytes, _) = decode_image(&chart.data_url)?;
    if image_dimensions(&bytes)? != (chart.width, chart.height) {
        return Err("可飞 PM2.5 截图尺寸不匹配".into());
    }
    if let Some(map) = &chart.map {
        if !["airins-export-crop-v1", "airins-export-full-v1"].contains(&map.method.as_str()) || map.mission_id != air.mission_id || map.source_channel != "ad_9"
            || map.captured_at < chart.end_time || map.padding_ratio != 0.1 || map.legend_labels.len() != 2
            || map.legend_labels.iter().any(|s| s.parse::<f64>().ok().is_none_or(|n| !n.is_finite()))
            || map.crop.x < 0 || map.crop.y < 0 || map.crop.width < 1 || map.crop.height < 1
            || map.crop.x.checked_add(map.crop.width).is_none_or(|n| n > map.original_width)
            || map.crop.y.checked_add(map.crop.height).is_none_or(|n| n > map.original_height)
            || (map.method == "airins-export-full-v1"
                && (map.crop.x != 0 || map.crop.y != 0 || map.crop.width != map.original_width || map.crop.height != map.original_height))
        { return Err("可飞浓度轨迹图与航次或裁剪规则不匹配".into()); }
        for (url, width, height) in [(&map.data_url, map.width, map.height), (&map.original_data_url, map.original_width, map.original_height)] {
            if width < 200 || height < 200 || width > 10000 || height > 10000 || width * height > 20000000 {
                return Err("可飞浓度轨迹图尺寸无效".into());
            }
            let (bytes, ext) = decode_image(url)?;
            if ext != "png" || image_dimensions(&bytes)? != (width, height) { return Err("可飞浓度轨迹图尺寸不匹配".into()); }
        }
    }
    Ok(())
}

pub fn archive(air: &AirData, root: &Path) -> Result<(), String> {
    if let Some(chart) = &air.chart {
        let (bytes, ext) = decode_image(&chart.data_url)?;
        fs::write(root.join(format!("airins-pm25-chart.{ext}")), bytes).map_err(|e| e.to_string())?;
        if let Some(map) = &chart.map {
            for (name, url) in [("airins-pm25-map.png", &map.data_url), ("airins-pm25-map-original.png", &map.original_data_url)] {
                fs::write(root.join(name), decode_image(url)?.0).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Collected {
        let mut data = super::super::tests::sample();
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 900, 250);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&vec![100; 900 * 250 * 3]).unwrap();
        }
        data.air.chart = Some(AirChart {
            map: None,
            method: "airins-page-screenshot".into(), source_channel:"ad_9".into(), mission_id:1,
            start_time:data.air.points[0].time, end_time:data.air.points[1].time,
            point_count:2, maximum:65.0, minimum:31.0, captured_at:Utc::now().timestamp_millis(),
            width:900, height:250, data_url:format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
        });
        data
    }
    #[test]
    fn chart_is_bound_to_samples_and_absent_in_photo_only_mode() {
        let data = sample(); validate(&data.air).unwrap();
        let mut changed = data.clone(); changed.air.chart.as_mut().unwrap().mission_id = 2;
        assert!(validate(&changed.air).is_err());
        changed = data.clone(); changed.air.points[0].time += 1; assert!(validate(&changed.air).is_err());
        changed = data.clone(); changed.air.chart.as_mut().unwrap().width += 1; assert!(validate(&changed.air).is_err());
        changed = data.clone(); changed.air.points[0].pm25 = Some(0.0); assert!(validate(&changed.air).is_err());
        changed = data; changed.without_air_data = true;
        assert!(super::super::validate(&changed, i64::MAX).is_err());
    }
    #[test]
    fn screenshot_is_archived_and_map_is_included_in_report() {
        let mut data = sample();
        let chart = data.air.chart.as_mut().unwrap();
        chart.map = Some(AirMap {
            method: "airins-export-full-v1".into(), mission_id: chart.mission_id, source_channel: "ad_9".into(),
            captured_at: chart.captured_at, width: chart.width, height: chart.height,
            original_width: chart.width, original_height: chart.height,
            crop: MapCrop {x:0,y:0,width:chart.width,height:chart.height}, padding_ratio:0.1,
            legend_labels: vec!["0".into(),"50".into()], data_url:chart.data_url.clone(), original_data_url:chart.data_url.clone(),
        });
        if let Ok(path) = std::env::var("TAIZHOU_MAP_QA_IMAGE") {
            let bytes = fs::read(path).unwrap();
            let (w,h) = image_dimensions(&bytes).unwrap();
            let map = chart.map.as_mut().unwrap();
            map.width=w;map.height=h;map.original_width=w;map.original_height=h;
            map.crop.width=w;map.crop.height=h;
            map.data_url=format!("data:image/png;base64,{}", STANDARD.encode(&bytes));
            map.original_data_url=map.data_url.clone();
        }
        let mut invalid = data.clone(); invalid.air.chart.as_mut().unwrap().map.as_mut().unwrap().mission_id += 1;
        assert!(validate(&invalid.air).is_err());
        let png = super::super::tests::PNG;
        let root = std::env::temp_dir().join(format!("air-chart-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let saved = persist(&root, &data, &[png.into(), png.into()], false).unwrap();
        let dir = Path::new(&saved.path).parent().unwrap();
        let archived = fs::read(dir.join("airins-pm25-chart.png")).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(fs::read(&saved.path).unwrap())).unwrap();
        assert!(!archived.is_empty());
        let mut embedded = Vec::new();
        assert!(zip.by_name("word/media/airins-pm25-chart.png").is_err());
        zip.by_name("word/media/airins-pm25-map.png").unwrap().read_to_end(&mut embedded).unwrap();
        assert_eq!(embedded, fs::read(dir.join("airins-pm25-map.png")).unwrap());
        assert!(dir.join("airins-pm25-map-original.png").is_file());
        if let Ok(path) = std::env::var("TAIZHOU_MAP_QA_DOCX") { fs::copy(&saved.path, path).unwrap(); }
        let mut doc = String::new();zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        assert!(doc.contains("最高值") && doc.contains("48.0"));
        assert!(doc.contains("图3　可飞平台PM₂.₅浓度轨迹图"));
        assert!(doc.find("可飞平台PM₂.₅浓度轨迹图").unwrap() < doc.rfind("<w:tbl>").unwrap());
        fs::remove_dir_all(root).unwrap();
    }
}
