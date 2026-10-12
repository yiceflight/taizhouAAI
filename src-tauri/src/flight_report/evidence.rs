//! Traceable fill-in evidence. Native snapshots override any frontend-supplied evidence.
use super::*;
use exif::{In, Tag};
use sha2::{Digest, Sha256};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub captured_at: i64,
    pub city_hours: Vec<CityHour>,
    pub trigger: String,
    pub event: Option<Value>,
    pub reviews: HashMap<String, PhotoReview>,
    #[serde(default)]
    pub review_method: String,
    pub conclusion: String,
    pub recommendation: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CityHour {
    pub time: String,
    pub potassium: Option<f64>,
    pub source_url: String,
    pub synced_at: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct PhotoReview {
    pub description: String,
    pub result: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewFile {
    local_event_id: Option<String>,
    mission_start: i64,
    mission_end: i64,
    photos: HashMap<String, PhotoReview>,
    #[serde(default)]
    review_method: String,
    conclusion: String,
    recommendation: String,
}
pub fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

pub fn snapshot(db: &rusqlite::Connection, data: &Collected, review_path: &Path, now: i64) -> Result<Evidence, String> {
    let start = date(now, "%Y-%m-%d 00:00:00");
    let end = date(now, "%Y-%m-%d %H:%M:%S");
    // Legacy PM2.5 values are deliberately NOT treated as a verified city source.
    let mut stmt = db.prepare("SELECT observed_at,potassium,source_url,synced_at FROM hourly_observations WHERE city_code='321200' AND data_source='A_6' AND common_site_type='30' AND unit='μg/m³' AND observed_at>=?1 AND observed_at<=?2 ORDER BY observed_at").map_err(|e| e.to_string())?;
    let city_hours = stmt.query_map(params![start, end], |r| Ok(CityHour { time:r.get(0)?, potassium:r.get(1)?, source_url:r.get(2)?, synced_at:r.get(3)? })).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    let mut e = Evidence { captured_at:now, city_hours, ..Default::default() };
    if let Some(id) = &data.local_event_id {
        for key in ["flight_event".to_string(), format!("flight_history:{id}")] {
            if let Some(raw) = crate::monitoring::setting(db, &key)? {
                let event: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                if event["id"].as_str() == Some(id) && event["flightTime"]["startTime"].as_i64() == Some(data.mission.start_time) && event["flightTime"]["endTime"].as_i64() == Some(data.mission.end_time) {
                    e.trigger = match event["source"].as_str() { Some("manual") => "由人工手动发起", Some("auto") => "由K⁺监测触发流程发起", _ => "触发原因待核实" }.into();
                    e.event = Some(event);
                    break;
                }
            }
        }
    } else if let Some(reason) = list_reasons(db)?.get(&data.mission.mission_id.to_string()) {
        e.trigger = match reason.as_str() { "manual_immediate" => "由人工手动发起", "dji_scheduled" => "由司空定时任务发起", "potassium_manual" => "由K⁺巡查经人工确认发起", "potassium_auto" => "由K⁺监测自动触发", _ => "触发原因待核实" }.into();
    }
    // Reviews are explicit local editorial inputs, bound to exact image bytes and flight.
    // A different/partial flight never inherits a conclusion or a pollution finding.
    if review_path.is_file() {
        let raw = fs::read(review_path).map_err(|e| e.to_string())?;
        let review: ReviewFile = serde_json::from_slice(&raw).map_err(|e| format!("影像判读文件损坏：{e}"))?;
        if review.local_event_id == data.local_event_id && review.mission_start == data.mission.start_time && review.mission_end == data.mission.end_time {
            if review.review_method.chars().count() > 500 { return Err("影像判读来源说明过长".into()); }
            e.review_method = review.review_method.clone();
            for p in &data.photos {
                let (bytes, _) = decode_image(&p.data_url)?;
                let hash = digest(&bytes);
                if let Some(r) = review.photos.get(&hash) {
                    if r.description.chars().count() > 200 || r.result.chars().count() > 200 { return Err("单张影像判读文字过长".into()); }
                    e.reviews.insert(hash, r.clone());
                }
            }
            if !data.photos.is_empty() && e.reviews.len() == data.photos.len() && review.photos.len() == data.photos.len() {
                if review.conclusion.chars().count() > 1500 || review.recommendation.chars().count() > 1500 { return Err("影像结论文字过长".into()); }
                e.conclusion = review.conclusion;
                e.recommendation = review.recommendation;
            }
        }
    }
    Ok(e)
}

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoFacts {
    pub longitude: Option<f64>,
    pub latitude: Option<f64>,
    pub image_type: String,
    pub relative_height: Option<f64>,
    pub hash: String,
}
fn gps(ex: &exif::Exif, tag: Tag, direction: Tag, limit: f64) -> Option<f64> {
    let value = &ex.get_field(tag, In::PRIMARY)?.value;
    let exif::Value::Rational(parts) = value else { return None };
    if parts.len() != 3 || parts.iter().any(|p| p.denom == 0) { return None; }
    let (d,m,s)=(parts[0].to_f64(), parts[1].to_f64(), parts[2].to_f64());
    if d > limit || m >= 60.0 || s >= 60.0 { return None; }
    let exif::Value::Ascii(refs) = &ex.get_field(direction, In::PRIMARY)?.value else { return None };
    let sign = match (direction, refs.first()?.as_slice()) {
        (Tag::GPSLatitudeRef,b"N") | (Tag::GPSLongitudeRef,b"E") => 1.0,
        (Tag::GPSLatitudeRef,b"S") | (Tag::GPSLongitudeRef,b"W") => -1.0,
        _ => return None,
    };
    let v = sign*(d+m/60.0+s/3600.0);
    (v.is_finite() && v.abs() <= limit).then_some(v)
}
fn xmp(bytes: &[u8]) -> HashMap<String,String> {
    let mut values = HashMap::new();
    if !bytes.starts_with(&[0xff,0xd8]) { return values; }
    let mut at = 2;
    while at+4 <= bytes.len() && bytes[at] == 0xff {
        let marker = bytes[at+1];
        if marker == 0xda || marker == 0xd9 { break; }
        let len = u16::from_be_bytes([bytes[at+2],bytes[at+3]]) as usize;
        if len < 2 || at+2+len > bytes.len() { break; }
        let segment = &bytes[at+4..at+2+len];
        if marker == 0xe1 {
            if let Some(xml) = segment.strip_prefix(b"http://ns.adobe.com/xap/1.0/\0") {
                let mut reader = quick_xml::Reader::from_reader(xml);
                loop {
                    match reader.read_event() {
                        Ok(quick_xml::events::Event::Start(el)) | Ok(quick_xml::events::Event::Empty(el)) => {
                            let attrs: Vec<_> = el.attributes().filter_map(Result::ok).collect();
                            if attrs.iter().any(|a| a.key.as_ref()=="xmlns:drone-dji" && a.value.as_ref()=="http://www.dji.com/drone-dji/1.0/") {
                                for a in attrs { if let Ok(v)=a.normalized_value(quick_xml::XmlVersion::Implicit1_0) { values.insert(a.key.as_ref().to_string(),v.into_owned()); } }
                            }
                        }
                        Ok(quick_xml::events::Event::Eof) | Err(_) => break,
                        _ => (),
                    }
                }
            }
        }
        at += len+2;
    }
    values
}
pub fn photo_facts(bytes: &[u8]) -> PhotoFacts {
    let mut f = PhotoFacts { hash:digest(bytes), image_type:"影像类型未取得".into(), ..Default::default() };
    if let Ok(ex) = exif::Reader::new().read_from_container(&mut Cursor::new(bytes)) {
        f.latitude = gps(&ex, Tag::GPSLatitude, Tag::GPSLatitudeRef, 90.0);
        f.longitude = gps(&ex, Tag::GPSLongitude, Tag::GPSLongitudeRef, 180.0);
        if ex.get_field(Tag::GPSStatus,In::PRIMARY).is_some_and(|v| matches!(&v.value, exif::Value::Ascii(a) if a.first().is_some_and(|b| b==b"V"))) {
            f.latitude=None; f.longitude=None;
        }
    }
    let x=xmp(bytes);
    f.image_type=match x.get("drone-dji:ImageSource").map(String::as_str) {
        Some("InfraredCamera")=>"红外热成像", Some("ZoomCamera")=>"可见光（变焦）", Some("WideCamera")=>"可见光（广角）", _=>"影像类型未取得",
    }.into();
    f.relative_height=x.get("drone-dji:RelativeAltitude").and_then(|v| v.parse::<f64>().ok()).filter(|v|v.is_finite() && (-500.0..=10000.0).contains(v));
    f
}

impl Evidence {
    pub fn city_fields(&self) -> Vec<(&'static str,String)> {
        let valid: Vec<_> = self.city_hours.iter().filter_map(|h| h.potassium.filter(|v|v.is_finite() && *v>=0.0).map(|v|(h,v))).collect();
        let high:Vec<_>=valid.iter().filter(|(_,v)|*v>1.0).collect();
        let trend=match (valid.first(),valid.last()) {
            (Some((a,x)),Some((b,y))) if a.time!=b.time => format!("浓度由{}的{:.2}微克/立方米{}{}的{:.2}微克/立方米", &a.time[11..16],x,if y>x {"升至"}else if y<x {"降至"}else {"持平至"},&b.time[11..16],y),
            (Some((a,x)),_) => format!("浓度在{}为{:.2}微克/立方米，仅1个有效小时，不能计算变化",&a.time[11..16],x),
            _=>"浓度尚无有效观测".into(),
        };
        let peak=valid.iter().max_by(|a,b|a.1.total_cmp(&b.1));
        let high_text=if valid.is_empty(){"的高值小时数无法统计；".into()}else{
            format!("的高值在{}个有效观测小时中共{}小时，{}；",valid.len(),high.len(),if high.is_empty(){"未见高值时段（仅限有效小时）".into()}else{format!("对应时刻为{}",high.iter().map(|(h,_)|h.time[11..16].to_string()).collect::<Vec<_>>().join("、"))})
        };
        let peak_text=peak.map(|(h,v)|format!("明显高值过程划分尚未确定；全窗有效观测K⁺峰值为{v:.2}微克/立方米，发生于{}，该小时对应PM",&h.time[11..16])).unwrap_or_else(||"高值过程及K⁺峰值无法判断，对应PM".into());
        let expected=((self.captured_at+8*3600000).rem_euclid(86400000)/3600000+1) as usize;
        let note=format!("。本章使用泰州市城市口径K⁺小时数据；当日截至生成时刻应有{}个整点，已取得{}个有效值，{}个缺测或未发布，未补0。{}城市PM2.5未接入，不用无人机采样替代。当前资料不足以确认生物质燃烧；本次巡飞时间和启动原因见第二章。", expected,valid.len(),expected.saturating_sub(valid.len()),self.city_hours.last().map(|h|format!("来源最新返回时刻为{}。",&h.time)).unwrap_or_default());
        vec![("CITY_PM","浓度未取得，升降幅无法计算".into()),("CITY_K",trend),("CITY_RATIO","比值无法计算；高于".into()),("CITY_HIGH",high_text+&peak_text),("CITY_PEAK_PM","浓度未取得，时段内K⁺/PM".into()),("CITY_MAX_RATIO","最高比值无法计算".into()),("CITY_NOTE",note)]
    }
}

/// A coordinate scatter plot, never a reconstructed flight route or target map.
pub fn location_plot(facts: &[PhotoFacts]) -> Result<Option<Vec<u8>>,String> {
    let points:Vec<_>=facts.iter().enumerate().filter_map(|(i,f)|Some((i+1,f.longitude?,f.latitude?))).collect();
    if points.is_empty(){return Ok(None)}
    let (w,h)=(1000usize,650usize);
    let mut pixels=vec![255u8;w*h*3];
    fn dot(p:&mut [u8],x:i32,y:i32,c:[u8;3]) {if (0..1000).contains(&x)&&(0..650).contains(&y){let n=(y as usize*1000+x as usize)*3;p[n..n+3].copy_from_slice(&c);}}
    fn label(p:&mut [u8],x:i32,y:i32,s:&str) {
        for (i,c) in s.chars().enumerate(){
            let rows:[u8;7]=match c {'0'=>[14,17,19,21,25,17,14],'1'=>[4,12,4,4,4,4,14],'2'=>[14,17,1,2,4,8,31],'3'=>[30,1,1,14,1,1,30],'4'=>[2,6,10,18,31,2,2],'5'=>[31,16,16,30,1,1,30],'6'=>[14,16,16,30,17,17,14],'7'=>[31,1,2,4,8,8,8],'8'=>[14,17,17,14,17,17,14],'9'=>[14,17,17,15,1,1,14],'.'=>[0,0,0,0,0,6,6],'-'=>[0,0,0,31,0,0,0],'E'=>[31,16,16,30,16,16,31],'N'=>[17,25,25,21,19,19,17],_=>[0;7]};
            for (yy,row) in rows.iter().enumerate(){for xx in 0..5{if row&(1<<(4-xx))!=0{for dy in 0..2{for dx in 0..2{dot(p,x+i as i32*12+xx*2+dx,y+yy as i32*2+dy,[35,35,35]);}}}}}
        }
    }
    let minx=points.iter().map(|p|p.1).fold(f64::INFINITY,f64::min);
    let maxx=points.iter().map(|p|p.1).fold(f64::NEG_INFINITY,f64::max);
    let miny=points.iter().map(|p|p.2).fold(f64::INFINITY,f64::min);
    let maxy=points.iter().map(|p|p.2).fold(f64::NEG_INFINITY,f64::max);
    let dx=(maxx-minx).max(0.0001)*1.6;let dy=(maxy-miny).max(0.0001)*1.4;
    let left=(maxx+minx-dx)/2.0;let bottom=(maxy+miny-dy)/2.0;
    for tick in 0..=4 {
        let x=180+tick*180;let y=80+tick*115;
        for yy in 80..=540{dot(&mut pixels,x,yy,[215,215,215]);}
        for xx in 180..=900{dot(&mut pixels,xx,y,[215,215,215]);}
        label(&mut pixels,x-60,563,&format!("{:.5}",left+dx*tick as f64/4.0));
        label(&mut pixels,30,y-6,&format!("{:.5}",bottom+dy*(4-tick) as f64/4.0));
    }
    label(&mut pixels,970,563,"E");label(&mut pixels,30,40,"N");
    for (i,lon,lat) in points {
        let x=180+((lon-left)/dx*720.0).round() as i32;
        let y=540-((lat-bottom)/dy*460.0).round() as i32;
        for a in -6..=6{for b in -6..=6{if a*a+b*b<=36{dot(&mut pixels,x+a,y+b,[190,45,45]);}}}
        label(&mut pixels,if i%2==1{x+12}else{x-28},if i%2==1{y-22}else{y+10},&i.to_string());
    }
    let mut bytes=vec![];
    {let mut enc=png::Encoder::new(&mut bytes,w as u32,h as u32);enc.set_color(png::ColorType::Rgb);enc.set_depth(png::BitDepth::Eight);let mut writer=enc.write_header().map_err(|e|e.to_string())?;writer.write_image_data(&pixels).map_err(|e|e.to_string())?;}
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_hours_zero_and_threshold_are_not_confused() {
        let e=Evidence {captured_at:1791739800000,city_hours:vec![
            CityHour{time:"2026-10-12 00:00:00".into(),potassium:Some(0.0),source_url:String::new(),synced_at:String::new()},
            CityHour{time:"2026-10-12 01:00:00".into(),potassium:Some(1.0),source_url:String::new(),synced_at:String::new()},
            CityHour{time:"2026-10-12 02:00:00".into(),potassium:None,source_url:String::new(),synced_at:String::new()},
        ],..Default::default()};
        let fields=e.city_fields();
        let text=fields.iter().map(|(_,s)|s.as_str()).collect::<Vec<_>>().join("");
        assert!(text.contains("2个有效观测小时中共0小时"));
        assert!(text.contains("00:00的0.00"));
        assert!(text.contains("01:00的1.00"));
        assert!(!text.contains("02:00的1.00"));
        assert!(text.contains("最高比值无法计算"));
    }
    #[test]
    fn snapshot_uses_only_current_city_k_and_matching_event() {
        let db=crate::monitoring::connect(Path::new(":memory:")).unwrap();
        for (time,k,city) in [("2026-10-11 23:00:00",9.0,"321200"),("2026-10-12 00:00:00",0.39,"321200"),("2026-10-12 01:00:00",0.35,"321200"),("2026-10-12 00:00:00",8.0,"other")] {
            db.execute("INSERT INTO hourly_observations VALUES (?1,?2,?3,99,'μg/m³','source','A_6','30','sync')",params![city,time,k]).unwrap();
        }
        let mut data=super::super::tests::sample();
        data.local_event_id=Some("event".into());
        crate::monitoring::put(&db,"flight_event",&json!({"id":"different","source":"manual","flightTime":{"startTime":data.mission.start_time,"endTime":data.mission.end_time}}).to_string()).unwrap();
        let e=snapshot(&db,&data,Path::new("/nonexistent"),1791736491228).unwrap();
        assert_eq!(e.city_hours.len(),1); // generated 00:34; 01:00 is outside window
        assert_eq!(e.city_hours[0].potassium,Some(0.39));
        assert!(e.trigger.is_empty());
        assert!(e.city_fields().iter().any(|(k,v)|*k=="CITY_PM"&&v.contains("未取得")));
    }
    #[test]
    fn image_type_requires_metadata_and_missing_gps_never_becomes_zero() {
        let mut jpeg=vec![0xff,0xd8,0xff,0xe1];
        let mut segment=b"http://ns.adobe.com/xap/1.0/\0".to_vec();
        segment.extend_from_slice(br#"<rdf:Description xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" drone-dji:ImageSource="InfraredCamera" drone-dji:RelativeAltitude="109.94"/>"#);
        jpeg.extend_from_slice(&((segment.len()+2) as u16).to_be_bytes());jpeg.extend(segment);jpeg.extend([0xff,0xd9]);
        let f=photo_facts(&jpeg);
        assert_eq!(f.image_type,"红外热成像");assert_eq!(f.relative_height,Some(109.94));assert!(f.latitude.is_none());assert!(f.longitude.is_none());
        assert!(location_plot(&[f]).unwrap().is_none());
        for n in 0..jpeg.len(){let _=photo_facts(&jpeg[..n]);} // truncated metadata must not panic
    }
    #[test]
    fn reviews_require_exact_flight_and_complete_image_set_for_conclusions() {
        let db=crate::monitoring::connect(Path::new(":memory:")).unwrap();
        let mut data=super::super::tests::sample();
        let (bytes,_)=decode_image(super::super::tests::PNG).unwrap();
        data.photos=vec![Photo{name:"x".into(),kind:"x".into(),data_url:super::super::tests::PNG.into()}];
        let path=std::env::temp_dir().join(format!("{}.json",Uuid::new_v4()));
        let write=|hash:String,start:i64|fs::write(&path,json!({"localEventId":null,"missionStart":start,"missionEnd":data.mission.end_time,"photos":{hash:{"description":"test scene","result":"unverified"}},"conclusion":"reviewed","recommendation":"check"}).to_string()).unwrap();
        write(digest(&bytes),data.mission.start_time+1);
        assert!(snapshot(&db,&data,&path,1791736491228).unwrap().reviews.is_empty());
        write("wrong hash".into(),data.mission.start_time);
        assert!(snapshot(&db,&data,&path,1791736491228).unwrap().conclusion.is_empty());
        write(digest(&bytes),data.mission.start_time);
        assert_eq!(snapshot(&db,&data,&path,1791736491228).unwrap().conclusion,"reviewed");
        fs::remove_file(path).unwrap();
    }
}
