//! Deterministic station charts, generated offline from archived hourly evidence.
use super::*;
use chrono::Timelike;
use image::{Rgba, RgbaImage};

const GLYPHS: &str = "0123456789.:-/ PM₂₅K⁺µgm³";
const WIDTH: u32 = 1600;
const HEIGHT: u32 = 600;

pub fn values(e: &Evidence, day: &str, potassium: bool) -> [Option<f64>; 24] {
    let mut values = [None; 24];
    for row in &e.city_hours {
        let Ok(time) = NaiveDateTime::parse_from_str(&row.time, "%Y-%m-%d %H:%M:%S") else { continue };
        if time.format("%Y-%m-%d").to_string() != day || time.minute() != 0 || time.second() != 0 { continue; }
        values[time.hour() as usize] = (if potassium { row.potassium } else { row.pm25 })
            .filter(|v| v.is_finite() && *v >= 0.0);
    }
    values
}

fn line(im: &mut RgbaImage, a: (i32,i32), b: (i32,i32), color: Rgba<u8>, radius: i32) {
    let steps = (b.0-a.0).abs().max((b.1-a.1).abs()).max(1);
    for i in 0..=steps {
        let x = a.0+(b.0-a.0)*i/steps;
        let y = a.1+(b.1-a.1)*i/steps;
        for dx in -radius..=radius { for dy in -radius..=radius {
            if x+dx >= 0 && y+dy >= 0 && x+dx < WIDTH as i32 && y+dy < HEIGHT as i32 {
                im.put_pixel((x+dx) as u32,(y+dy) as u32,color);
            }
        }}
    }
}
fn text(im: &mut RgbaImage, atlas: &RgbaImage, x: i64, y: i64, s: &str) {
    for (i,c) in s.chars().enumerate() {
        if let Some(index) = GLYPHS.chars().position(|g| g==c) {
            let glyph = image::imageops::crop_imm(atlas,index as u32*40,0,40,48).to_image();
            image::imageops::overlay(im,&glyph,x+i as i64*22,y);
        }
    }
}

pub fn render(values: &[Option<f64>;24], day: &str, potassium: bool, threshold: Option<f64>) -> Result<Vec<u8>,String> {
    let atlas = image::load_from_memory(include_bytes!("../../assets/station-chart-glyphs.png"))
        .map_err(|e| e.to_string())?.to_rgba8();
    let mut im = RgbaImage::from_pixel(WIDTH,HEIGHT,Rgba([255,255,255,255]));
    let ink = if potassium { Rgba([26,139,122,255]) } else { Rgba([42,100,175,255]) };
    let grid = Rgba([226,231,237,255]);
    let threshold = threshold.filter(|v| v.is_finite() && *v > 0.0);
    let max = values.iter().flatten().copied().fold(threshold.unwrap_or(0.0),f64::max).max(if potassium {0.1} else {1.0});
    let rough = max*1.15/4.0;
    let magnitude = 10_f64.powf(rough.log10().floor());
    let step = [1.0,2.0,2.5,5.0,10.0].into_iter().find(|v| v*magnitude >= rough).unwrap()*magnitude;
    let top = step*4.0;
    text(&mut im,&atlas,130,16,if potassium {"K⁺ / µg/m³"} else {"PM₂.₅ / µg/m³"});
    text(&mut im,&atlas,1260,16,day);
    for tick in 0..=4 {
        let y = 490-tick*100;
        line(&mut im,(130,y),(1530,y),grid,0);
        let value = top*tick as f64/4.0;
        let label = if top < 10.0 {format!("{value:.2}")} else {format!("{value:.0}")};
        text(&mut im,&atlas,115-label.len() as i64*22,y as i64-20,&label);
    }
    let point = |hour:usize,v:f64| (130+(hour as f64*1400.0/23.0).round() as i32,490-(v/top*400.0).round() as i32);
    if let Some(threshold) = threshold {
        let y = point(0, threshold).1;
        let warning = Rgba([200, 65, 65, 255]);
        for x in (130..1530).step_by(28) {
            line(&mut im, (x,y), ((x+16).min(1530),y), warning, 1);
        }
        let label = format!("{threshold} µg/m³");
        text(&mut im, &atlas, 1520-label.chars().count() as i64*22, y as i64-43, &label);
    }
    for hour in 0..24 {
        let x = point(hour,0.0).0;
        if hour%2==0 || hour==23 { text(&mut im,&atlas,x as i64-22,508,&format!("{hour:02}")); }
        if let Some(v) = values[hour] {
            let p = point(hour,v);
            if hour > 0 { if let Some(prev) = values[hour-1] {line(&mut im,point(hour-1,prev),p,ink,2);} }
            for dx in -6..=6 { for dy in -6..=6 { if dx*dx+dy*dy<=36 { im.put_pixel((p.0+dx) as u32,(p.1+dy) as u32,ink); }}}
        }
    }
    let mut output=Cursor::new(Vec::new());
    im.write_to(&mut output,image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_day_chart_does_not_change_trigger_hour_narrative() {
        let e = Evidence {
            captured_at: 1794387600000,
            flight_hour: Some("2026-11-11 06:00:00".into()),
            city_hours: [0, 5, 6, 8].into_iter().map(|hour| evidence::CityHour {
                time: format!("2026-11-11 {hour:02}:00:00"), potassium: Some(hour as f64),
                pm25: Some(10.0 + hour as f64), source_url: String::new(), synced_at: String::new(),
            }).collect(),
            ..Default::default()
        };
        assert_eq!(values(&e, "2026-11-11", true)[8], Some(8.0));
        let fields: HashMap<_,_> = e.city_fields().into_iter().collect();
        assert_eq!(fields["CITY_K_END"], "6.00");
        assert_eq!(fields["CITY_HIGH_HOURS"], "2");
        assert_eq!(e.station_day_end(), Some("2026-11-11 17:00:00".into()));
    }
    #[test]
    fn day_filter_preserves_zero_and_gaps_and_independent_metrics() {
        let mut e=Evidence::default();
        for (time,k,pm) in [("2026-11-10 23:00:00",Some(9.0),Some(99.0)),("2026-11-11 00:00:00",Some(0.0),None),("2026-11-11 02:00:00",Some(-1.0),Some(55.0)),("2026-11-12 00:00:00",Some(9.0),Some(99.0))] {
            e.city_hours.push(evidence::CityHour {time:time.into(),potassium:k,pm25:pm,source_url:String::new(),synced_at:String::new()});
        }
        let k=values(&e,"2026-11-11",true); let pm=values(&e,"2026-11-11",false);
        assert_eq!(k[0],Some(0.0)); assert_eq!(k[1],None); assert_eq!(k[2],None);
        assert_eq!(pm[0],None); assert_eq!(pm[2],Some(55.0)); assert_eq!(pm.iter().flatten().count(),1);
        assert_eq!(image_dimensions(&render(&k,"2026-11-11",true,Some(1.0)).unwrap()).unwrap(),(1600,600));
    }
}
