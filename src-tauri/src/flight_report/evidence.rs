//! Traceable fill-in evidence. Native snapshots override any frontend-supplied evidence.
use super::*;
use exif::{In, Tag};
use sha2::{Digest, Sha256};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub captured_at: i64,
    /// Actual departure hour for flights without a local monitoring trigger.
    #[serde(default)]
    pub flight_hour: Option<String>,
    pub city_hours: Vec<CityHour>,
    pub trigger: String,
    pub event: Option<Value>,
    pub reviews: HashMap<String, PhotoReview>,
    #[serde(default)]
    pub review_method: String,
    #[serde(default)]
    pub anomaly_count: Option<u32>,
    #[serde(default)]
    pub combustion_confirmed: bool,
    pub conclusion: String,
    pub recommendation: String,
    #[serde(default)]
    pub dji_task: Option<DjiTask>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CityHour {
    pub time: String,
    pub potassium: Option<f64>,
    #[serde(default)]
    pub pm25: Option<f64>,
    pub source_url: String,
    pub synced_at: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct PhotoReview {
    #[serde(default)]
    pub location: String,
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
    #[serde(default)]
    anomaly_count: Option<u32>,
    #[serde(default)]
    combustion_confirmed: bool,
    conclusion: String,
    recommendation: String,
}
pub fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

pub fn snapshot(db: &rusqlite::Connection, data: &Collected, review_path: &Path, now: i64) -> Result<Evidence, String> {
    let mut e = Evidence {
        captured_at:now,
        flight_hour: DateTime::from_timestamp_millis(data.mission.start_time)
            .filter(|_| data.mission.start_time > 0)
            .map(|_| date(data.mission.start_time, "%Y-%m-%d %H:00:00")),
        ..Default::default()
    };
    let tasks = read_dji_tasks(db)?;
    let matching: Vec<_> = tasks.into_iter().filter(|t| !t.actual_time_missing
        && t.mission.mission_name == data.mission.mission_name
        && t.mission.start_time == data.mission.start_time && t.mission.end_time == data.mission.end_time).collect();
    if matching.len() == 1 { e.dji_task = matching.into_iter().next(); }
    // Platform-history exports may omit localEventId. Recover only an exact,
    // unique flight-time match; never guess from task names or nearby times.
    let mut stmt = db.prepare("SELECT value FROM monitor_settings WHERE key='flight_event' OR key LIKE 'flight_history:%'").map_err(|e| e.to_string())?;
    let raws = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    let mut events: HashMap<String, Value> = HashMap::new();
    for raw in raws {
        let event: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let Some(id) = event["id"].as_str() else { continue };
        if data.local_event_id.as_ref().is_some_and(|wanted| wanted != id) { continue; }
        if event["flightTime"]["startTime"].as_i64() == Some(data.mission.start_time)
            && event["flightTime"]["endTime"].as_i64() == Some(data.mission.end_time) {
            events.insert(id.to_owned(), event);
        }
    }
    if events.len() == 1 {
        let event = events.into_values().next().unwrap();
        e.trigger = match event["source"].as_str() { Some("manual") => "由人工手动发起", Some("auto") if event["name"].as_str().is_some_and(|name| name.starts_with("PM2.5超标巡查-")) => "由PM2.5监测触发流程发起", Some("auto") => "由K⁺/PM2.5监测触发流程发起", _ => "触发原因待核实" }.into();
        e.event = Some(event);
    } else if let Some(reason) = list_reasons(db)?.get(&data.mission.mission_id.to_string()) {
        e.trigger = match reason.as_str() { "manual_immediate" => "由人工手动发起", "dji_scheduled" => "由司空定时任务发起", "potassium_manual" => "由K⁺/PM2.5巡查经人工确认发起", "potassium_auto" => "由K⁺或PM2.5监测自动触发", _ => "触发原因待核实" }.into();
    }
    // Include earlier valid readings across midnight, but never later hours.
    if let Some(end) = e.trigger_hour() {
        let mut stmt = db.prepare("SELECT observed_at,potassium,source_url,synced_at,pm25 FROM hourly_observations WHERE city_code='321200' AND data_source='A_6' AND common_site_type='30' AND unit='μg/m³' AND observed_at<=?1 ORDER BY observed_at").map_err(|e| e.to_string())?;
        e.city_hours = stmt.query_map(params![end], |r| Ok(CityHour { time:r.get(0)?, potassium:r.get(1)?, source_url:r.get(2)?, synced_at:r.get(3)?, pm25:r.get(4)? })).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    }
    // Reviews are explicit local editorial inputs, bound to exact image bytes and flight.
    // A different/partial flight never inherits a conclusion or a pollution finding.
    if review_path.is_file() {
        let raw = fs::read(review_path).map_err(|e| e.to_string())?;
        let review: ReviewFile = serde_json::from_slice(&raw).map_err(|e| format!("影像判读文件损坏：{e}"))?;
        if review.local_event_id == data.local_event_id && review.mission_start == data.mission.start_time && review.mission_end == data.mission.end_time {
            if review.review_method.chars().count() > 500 { return Err("影像判读来源说明过长".into()); }

            for p in &data.photos {
                let (bytes, _) = decode_image(&p.data_url)?;
                let hash = digest(&bytes);
                if let Some(r) = review.photos.get(&hash) {
                    if r.location.chars().count() > 200 || r.description.chars().count() > 200 || r.result.chars().count() > 200 { return Err("单张影像判读文字过长".into()); }
                    e.reviews.insert(hash, r.clone());
                }
            }
            if !data.photos.is_empty() && e.reviews.len() == data.photos.len() && review.photos.len() == data.photos.len() {
                if review.conclusion.chars().count() > 1500 || review.recommendation.chars().count() > 1500 { return Err("影像结论文字过长".into()); }
                e.review_method = review.review_method;
                e.anomaly_count = review.anomaly_count;
                e.combustion_confirmed = review.combustion_confirmed;
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

fn hour(time: &str) -> &str { time.get(11..16).unwrap_or("时刻未取得") }
fn valid_value(value: Option<f64>) -> Option<f64> { value.filter(|v| v.is_finite() && *v >= 0.0) }
fn number(value: Option<f64>) -> String {
    value.map(|v| format!("{v:.2}")).unwrap_or_else(|| "【 】".into())
}
impl Evidence {
    pub fn trigger_hour(&self) -> Option<String> {
        let event_hour = self.event.as_ref().filter(|event| event["source"].as_str() == Some("auto"))
            .and_then(|event| event["sourceHour"].as_str().or_else(|| event["observedAt"].as_str()));
        let valid_hour = |raw: &str| {
            let parsed = NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S").ok()?;
            (parsed.format("%M:%S").to_string() == "00:00").then(|| raw.to_owned())
        };
        event_hour.and_then(valid_hour).or_else(|| self.flight_hour.as_deref().and_then(valid_hour))
    }
    pub fn trigger_hour_label(&self) -> String {
        self.trigger_hour().and_then(|h| NaiveDateTime::parse_from_str(&h, "%Y-%m-%d %H:%M:%S").ok())
            .map(|h| h.format("%Y年%m月%d日%H时").to_string()).unwrap_or_else(|| "【 】".into())
    }

    pub fn city_fields(&self) -> Vec<(&'static str, String)> {
        let trigger = self.trigger_hour();
        let mut hours: Vec<_> = self.city_hours.iter().filter(|h| trigger.as_ref().is_some_and(|t| h.time <= *t)).collect();
        hours.sort_by(|a,b| a.time.cmp(&b.time));
        let k: Vec<_> = hours.iter().filter_map(|h| valid_value(h.potassium).map(|v|(*h,v))).collect();
        let pm: Vec<_> = hours.iter().filter_map(|h| valid_value(h.pm25).map(|v|(*h,v))).collect();
        let ratios: Vec<_> = hours.iter().filter_map(|h| {
            let p=valid_value(h.pm25).filter(|v|*v>0.0)?;
            Some((*h, valid_value(h.potassium)?/p*100.0))
        }).collect();
        let mut fields = Vec::new();
        for (values, start, end, direction) in [
            (&pm, "CITY_PM_START", "CITY_PM_END", "CITY_PM_DIRECTION"),
            (&k, "CITY_K_START", "CITY_K_END", "CITY_K_DIRECTION"),
            (&ratios, "CITY_RATIO_START", "CITY_RATIO_END", "CITY_RATIO_DIRECTION"),
        ] {
            let previous = values.iter().rev().find(|(h,_)| Some(&h.time) < trigger.as_ref());
            let current = values.iter().find(|(h,_)| Some(&h.time) == trigger.as_ref());
            fields.push((start, number(previous.map(|(_,v)|*v))));
            let pair = previous.zip(current);
            fields.push((end, number(current.map(|(_,v)|*v))));
            fields.push((direction, pair.map(|(a,b)| if b.1>a.1 {"升至"} else if b.1<a.1 {"降至"} else {"持平于"}).unwrap_or("【 】").into()));
        }
        let pair = pm.iter().rev().find(|(h,_)| Some(&h.time) < trigger.as_ref())
            .zip(pm.iter().find(|(h,_)| Some(&h.time) == trigger.as_ref()));
        fields.push(("CITY_PM_CHANGE", pair.filter(|(a,_)|a.1>0.0).map(|(a,b)|format!("{:.1}",(b.1-a.1).abs()/a.1*100.0)).unwrap_or_else(||"【 】".into())));
        fields.push(("CITY_PM_CHANGE_LABEL", pair.map(|(a,b)|if b.1<a.1 {"降幅"} else {"升幅"}).unwrap_or("【 】").into()));
        // Remaining process statistics cover the trigger day through that hour.
        let k: Vec<_> = k.into_iter().filter(|(h,_)| trigger.as_ref().is_some_and(|t| h.time[..10] == t[..10])).collect();
        let ratios: Vec<_> = ratios.into_iter().filter(|(h,_)| trigger.as_ref().is_some_and(|t| h.time[..10] == t[..10])).collect();
        let high:Vec<_> = k.iter().filter(|(_,v)|*v>1.0).collect();
        fields.push(("CITY_HIGH_HOURS", if k.is_empty() {"【 】".into()} else {high.len().to_string()}));
        fields.push(("CITY_HIGH_WINDOW", if high.is_empty() {"【 】".into()} else {high.iter().map(|(h,_)|hour(&h.time)).collect::<Vec<_>>().join("、")}));
        // Process segmentation and combustion attribution require approved evidence.
        fields.push(("CITY_PROCESS_COUNT", "【 】".into()));
        fields.push(("CITY_PROCESS_TIME", "【 】".into()));
        fields.push(("COMBUSTION_FINDING", if self.combustion_confirmed {"生物质燃烧特征明显"} else {"【 】"}.into()));
        let peak = k.iter().max_by(|a,b|a.1.total_cmp(&b.1));
        fields.push(("CITY_K_PEAK", number(peak.map(|(_,v)|*v))));
        fields.push(("CITY_PEAK_PM", number(peak.and_then(|(h,_)|valid_value(h.pm25)))));
        fields.push(("CITY_MAX_RATIO", number(ratios.iter().map(|(_,v)|*v).max_by(f64::total_cmp))));
        fields
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
    // Keep labels legible for paired cameras and nearby capture points. Leader
    // lines connect a displaced label to its unchanged coordinate, not a route.
    let projected:Vec<_>=points.iter().map(|(i,lon,lat)|(*i,
        180+((lon-left)/dx*720.0).round() as i32,
        540-((lat-bottom)/dy*460.0).round() as i32)).collect();
    let mut occupied:Vec<(i32,i32,i32,i32)>=vec![];
    for (i,x,y) in &projected {
        let text=i.to_string();let width=text.len() as i32*12;
        let mut position=None;
        'search: for radius in [14,30,46,62,78,94,110,126,142] {
            for (a,b) in [(radius,-radius),(radius,radius),(-radius-width,-radius),(-radius-width,radius),(-width/2,-radius),(-width/2,radius)] {
                let (lx,ly)=(x+a,y+b);
                let rect=(lx-3,ly-3,lx+width+3,ly+17);
                if rect.0<181||rect.1<81||rect.2>899||rect.3>539 {continue;}
                if occupied.iter().any(|r|rect.0<r.2&&rect.2>r.0&&rect.1<r.3&&rect.3>r.1)
                    ||projected.iter().any(|(_,px,py)|*px+8>rect.0&&*px-8<rect.2&&*py+8>rect.1&&*py-8<rect.3){continue;}
                occupied.push(rect);position=Some((lx,ly));break 'search;
            }
        }
        if let Some((lx,ly))=position {
            let (tx,ty)=(lx+width/2,ly+7);
            let steps=(tx-x).abs().max((ty-y).abs()).max(1);
            for step in 0..=steps {dot(&mut pixels,x+(tx-x)*step/steps,y+(ty-y)*step/steps,[175,175,175]);}
            label(&mut pixels,lx,ly,&text);
        }
    }
    for (_,x,y) in projected {for a in -6..=6{for b in -6..=6{if a*a+b*b<=36{dot(&mut pixels,x+a,y+b,[190,45,45]);}}}}
    let mut bytes=vec![];
    {let mut enc=png::Encoder::new(&mut bytes,w as u32,h as u32);enc.set_color(png::ColorType::Rgb);enc.set_depth(png::BitDepth::Eight);let mut writer=enc.write_header().map_err(|e|e.to_string())?;writer.write_image_data(&pixels).map_err(|e|e.to_string())?;}
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_hours_zero_and_threshold_are_not_confused() {
        let e=Evidence {event:Some(json!({"source":"auto","sourceHour":"2026-10-12 01:00:00"})),captured_at:1791739800000,city_hours:vec![
            CityHour{time:"2026-10-12 00:00:00".into(),potassium:Some(0.0),pm25:None,source_url:String::new(),synced_at:String::new()},
            CityHour{time:"2026-10-12 01:00:00".into(),potassium:Some(1.0),pm25:None,source_url:String::new(),synced_at:String::new()},
            CityHour{time:"2026-10-12 02:00:00".into(),potassium:None,pm25:None,source_url:String::new(),synced_at:String::new()},
        ],..Default::default()};
        let fields:HashMap<_,_>=e.city_fields().into_iter().collect();
        assert_eq!(fields["CITY_HIGH_HOURS"], "0");
        assert_eq!(fields["CITY_K_START"], "0.00");
        assert_eq!(fields["CITY_K_END"], "1.00");
        assert_eq!(fields["CITY_MAX_RATIO"], "【 】");
        assert_eq!(fields["CITY_PM_END"], "【 】");
    }
    #[test]
    fn snapshot_uses_verified_city_hours_and_matching_event() {
        let db=crate::monitoring::connect(Path::new(":memory:")).unwrap();
        for (time,k,city) in [("2026-10-11 23:00:00",9.0,"321200"),("2026-10-12 00:00:00",0.39,"321200"),("2026-10-12 01:00:00",0.35,"321200"),("2026-10-12 00:00:00",8.0,"other")] {
            db.execute("INSERT INTO hourly_observations VALUES (?1,?2,?3,99,'μg/m³','source','A_6','30','sync')",params![city,time,k]).unwrap();
        }
        let mut data=super::super::tests::sample();
        data.local_event_id=Some("event".into());
        crate::monitoring::put(&db,"flight_event",&json!({"id":"different","source":"manual","flightTime":{"startTime":data.mission.start_time,"endTime":data.mission.end_time}}).to_string()).unwrap();
        let e=snapshot(&db,&data,Path::new("/nonexistent"),1791736491228).unwrap();
        assert!(e.city_hours.is_empty()); // An unrelated event cannot establish a trigger hour.
        assert!(e.trigger.is_empty());
        assert_eq!(e.trigger_hour_label(), date(data.mission.start_time, "%Y年%m月%d日%H时"));
        crate::monitoring::put(&db,"flight_event",&json!({"id":"event","source":"auto","sourceHour":"2026-10-12 00:00:00","flightTime":{"startTime":data.mission.start_time,"endTime":data.mission.end_time}}).to_string()).unwrap();
        let e=snapshot(&db,&data,Path::new("/nonexistent"),1791836491228).unwrap();
        assert_eq!(e.city_hours.len(),2);
        let fields:HashMap<_,_>=e.city_fields().into_iter().collect();
        assert_eq!(fields["CITY_K_START"], "9.00");
        assert_eq!(fields["CITY_K_END"], "0.39");
        assert_eq!(e.trigger_hour_label(), "2026年10月12日00时");
    }
    #[test]
    fn platform_flight_without_local_event_fills_departure_hour() {
        let db=crate::monitoring::connect(Path::new(":memory:")).unwrap();
        let mut data=super::super::tests::sample();
        data.local_event_id=None;
        data.mission.start_time=1793523600000; // 2026-11-01 17:00 Beijing
        data.mission.end_time=1793525040000;
        for (hour,k,pm) in [("16",0.39,30.0),("17",0.40,31.0),("18",0.35,32.0)] {
            db.execute("INSERT INTO hourly_observations VALUES ('321200',?1,?2,?3,'μg/m³','source','A_6','30','sync')",
                params![format!("2026-11-01 {hour}:00:00"),k,pm]).unwrap();
        }
        let e=snapshot(&db,&data,Path::new("/nonexistent"),1793540000000).unwrap();
        assert!(e.event.is_none());
        assert_eq!(e.trigger_hour_label(),"2026年11月01日17时");
        let fields:HashMap<_,_>=e.city_fields().into_iter().collect();
        assert_eq!(fields["CITY_PM_START"],"30.00");
        assert_eq!(fields["CITY_PM_END"],"31.00");
        assert_eq!(fields["CITY_K_START"],"0.39");
        assert_eq!(fields["CITY_K_END"],"0.40");
        // A platform export of a delayed local task must recover its source hour.
        crate::monitoring::put(&db,"flight_history:matched",&json!({
            "id":"matched","source":"auto","sourceHour":"2026-11-01 16:00:00",
            "flightTime":{"startTime":data.mission.start_time,"endTime":data.mission.end_time}
        }).to_string()).unwrap();
        let e=snapshot(&db,&data,Path::new("/nonexistent"),1793540000000).unwrap();
        assert_eq!(e.trigger_hour_label(),"2026年11月01日16时");
        assert!(e.event.is_some());
    }
    #[test]
    fn city_ratios_pair_same_hour_and_k_peak_uses_corresponding_pm() {
        let mut e=Evidence { event:Some(json!({"source":"auto","sourceHour":"2026-10-25 03:00:00"})), ..Default::default() };
        for (hour,k,pm) in [("00:00",Some(0.0),Some(0.0)),("01:00",Some(2.0),Some(10.0)),("02:00",None,Some(100.0)),("03:00",Some(1.0),Some(2.0))] {
            e.city_hours.push(CityHour{time:format!("2026-10-25 {hour}:00"),potassium:k,pm25:pm,source_url:String::new(),synced_at:String::new()});
        }
        let fields:HashMap<_,_>=e.city_fields().into_iter().collect();
        assert_eq!(fields["CITY_PM_CHANGE"], "98.0");
        assert!(fields["CITY_PEAK_PM"].contains("10.00"));
        assert_eq!(fields["CITY_MAX_RATIO"], "50.00");
        assert_eq!(fields["COMBUSTION_FINDING"], "【 】");
        assert_eq!(fields["CITY_HIGH_HOURS"], "1");
    }
    #[test]
    fn declining_city_values_and_absent_evidence_remain_field_values() {
        let empty:HashMap<_,_> = Evidence::default().city_fields().into_iter().collect();
        assert!(empty.values().all(|v|v=="【 】"));
        let mut e = Evidence { event:Some(json!({"source":"auto","sourceHour":"2026-10-31 11:00:00"})), ..Default::default() };
        for (time, value) in [("2026-10-31 11:00:00",43.0),("2026-10-31 00:00:00",48.0)] {
            e.city_hours.push(CityHour {time:time.into(),pm25:Some(value),potassium:None,source_url:String::new(),synced_at:String::new()});
        }
        let fields:HashMap<_,_> = e.city_fields().into_iter().collect();
        assert_eq!(fields["CITY_PM_DIRECTION"], "降至");
        assert_eq!(fields["CITY_PM_CHANGE_LABEL"], "降幅");
        assert_eq!(fields["CITY_PM_CHANGE"], "10.4");
        assert_eq!(fields["CITY_PM_START"], "48.00");
        assert_eq!(fields["CITY_K_PEAK"], "【 】");
        e.combustion_confirmed = true;
        assert!(e.city_fields().iter().any(|(k,v)|*k=="COMBUSTION_FINDING" && v=="生物质燃烧特征明显"));
    }
    #[test]
    fn current_missing_k_never_reuses_old_or_future_values() {
        let mut e = Evidence { event:Some(json!({"source":"auto","sourceHour":"2026-10-31 12:00:00","observedAt":"2026-10-31 13:00:00"})), ..Default::default() };
        for (time,k,pm) in [("09",Some(0.4),Some(20.0)),("10",Some(0.6),Some(30.0)),("11",None,None),("12",None,Some(60.0)),("13",Some(9.0),Some(99.0))] {
            e.city_hours.push(CityHour {time:format!("2026-10-31 {time}:00:00"),potassium:k,pm25:pm,source_url:String::new(),synced_at:String::new()});
        }
        let fields:HashMap<_,_>=e.city_fields().into_iter().collect();
        assert_eq!(e.trigger_hour_label(), "2026年10月31日12时");
        assert_eq!(fields["CITY_PM_START"], "30.00");
        assert_eq!(fields["CITY_PM_END"], "60.00");
        assert_eq!(fields["CITY_PM_CHANGE"], "100.0");
        assert_eq!(fields["CITY_K_START"], "0.60");
        assert_eq!(fields["CITY_RATIO_START"], "2.00");
        for key in ["CITY_K_END","CITY_RATIO_END","CITY_K_DIRECTION","CITY_RATIO_DIRECTION"] {
            assert_eq!(fields[key], "【 】");
        }
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
        data.photos=vec![Photo{name:"x".into(),kind:"x".into(),data_url:super::super::tests::PNG.into(),presentation:None}];
        let path=std::env::temp_dir().join(format!("{}.json",Uuid::new_v4()));
        let write=|hash:String,start:i64|fs::write(&path,json!({"localEventId":null,"missionStart":start,"missionEnd":data.mission.end_time,"photos":{hash:{"description":"test scene","result":"unverified"}},"conclusion":"reviewed","recommendation":"check","anomalyCount":0,"combustionConfirmed":true,"reviewMethod":"经人工复核"}).to_string()).unwrap();
        write(digest(&bytes),data.mission.start_time+1);
        assert!(snapshot(&db,&data,&path,1791736491228).unwrap().reviews.is_empty());
        write("wrong hash".into(),data.mission.start_time);
        assert!(snapshot(&db,&data,&path,1791736491228).unwrap().conclusion.is_empty());
        write(digest(&bytes),data.mission.start_time);
        let complete = snapshot(&db,&data,&path,1791736491228).unwrap();
        assert_eq!(complete.conclusion,"reviewed");
        assert_eq!(complete.anomaly_count,Some(0));
        assert!(complete.combustion_confirmed);
        assert_eq!(complete.review_method,"经人工复核");
        fs::remove_file(path).unwrap();
    }
}
