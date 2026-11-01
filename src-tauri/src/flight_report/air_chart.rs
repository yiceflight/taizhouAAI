use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirChart {
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
    Ok(())
}

pub fn archive(air: &AirData, root: &Path) -> Result<(), String> {
    if let Some(chart) = &air.chart {
        let (bytes, ext) = decode_image(&chart.data_url)?;
        fs::write(root.join(format!("airins-pm25-chart.{ext}")), bytes).map_err(|e| e.to_string())?;
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
    fn screenshot_is_archived_without_adding_content_to_fixed_template() {
        let data = sample();
        let png = super::super::tests::PNG;
        let root = std::env::temp_dir().join(format!("air-chart-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let saved = persist(&root, &data, &[png.into(), png.into()], false).unwrap();
        let dir = Path::new(&saved.path).parent().unwrap();
        let archived = fs::read(dir.join("airins-pm25-chart.png")).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(fs::read(&saved.path).unwrap())).unwrap();
        assert!(!archived.is_empty());
        assert!(zip.by_name("word/media/airins-pm25-chart.png").is_err());
        let mut doc = String::new();zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        assert!(doc.contains("最高值") && doc.contains("48.0"));
        assert!(!doc.contains("平台原图截图"));
        fs::remove_dir_all(root).unwrap();
    }
}
