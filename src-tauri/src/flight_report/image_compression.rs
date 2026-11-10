//! Compress only DOCX display copies, never archived evidence. No resizing,
//! smoothing, or chroma subsampling. Failed/unsafe/unhelpful conversions retain
//! the exact input. Quality is bounded rather than reduced to meet a size target.
use image::{ImageDecoder, ImageReader, RgbImage};
// Keep libjpeg linked in release/LTO builds: the C helper calls it directly.
use mozjpeg_sys as _;
use std::io::Cursor;

pub(super) fn compress(bytes: Vec<u8>, ext: &'static str) -> (Vec<u8>, &'static str) {
    // Every attempt starts from the archived original, never a previous encode.
    let candidate = candidate(&bytes, ext == "jpeg");
    let fallback = if ext == "jpeg" {
        lossless_jpeg(&bytes).unwrap_or(bytes)
    } else {
        bytes
    };
    match candidate.filter(|encoded| encoded.len() < fallback.len()) {
        Some(encoded) => (encoded, "jpeg"),
        None => (fallback, ext),
    }
}

unsafe extern "C" {
    fn report_jpeg_optimize(
        input: *const u8,
        length: std::os::raw::c_ulong,
        output_length: *mut std::os::raw::c_ulong,
    ) -> *mut u8;
    fn report_jpeg_free(buffer: *mut u8);
}

fn lossless_jpeg(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 64 * 1024 {
        return None;
    }
    let (width, height) = super::image_dimensions(bytes).ok()?;
    if width * height > 40_000_000 {
        return None;
    }
    let length = bytes.len().try_into().ok()?;
    let mut output_length = 0;
    // The C wrapper catches JPEG errors locally and returns an owned allocation
    // (or null), released by the same C runtime that allocated it on Windows.
    let encoded = unsafe {
        let ptr = report_jpeg_optimize(bytes.as_ptr(), length, &mut output_length);
        if ptr.is_null() {
            return None;
        }
        let output = if output_length as u64 >= bytes.len() as u64 * 98 / 100 {
            None
        } else {
            Some(std::slice::from_raw_parts(ptr, output_length as usize).to_vec())
        };
        report_jpeg_free(ptr);
        output?
    };
    // Verify full-resolution equality, not a thumbnail similarity score.
    let original = image::load_from_memory(bytes).ok()?;
    let check = image::load_from_memory(&encoded).ok()?;
    (original == check).then_some(encoded)
}

fn candidate(bytes: &[u8], photograph: bool) -> Option<Vec<u8>> {
    if bytes.len() < 64 * 1024 {
        return None;
    }
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > 40_000_000 {
        return None;
    }
    // Avoid silently losing rotation or precision. Unusual/high-bit-depth
    // images remain original; ordinary opaque FlightHub captures are RGB/RGBA8.
    let icc = decoder.icc_profile().ok()?;
    if decoder.orientation().ok()? != image::metadata::Orientation::NoTransforms
        || !matches!(
            decoder.color_type(),
            image::ColorType::L8
                | image::ColorType::La8
                | image::ColorType::Rgb8
                | image::ColorType::Rgba8
        )
        || decoder.original_color_type() == image::ExtendedColorType::Cmyk8
    {
        return None;
    }
    let decoded = image::DynamicImage::from_decoder(decoder).ok()?;
    if decoded.color().has_alpha() && decoded.to_rgba8().pixels().any(|p| p[3] != 255) {
        return None;
    }
    let rgb = decoded.into_rgb8();
    let qualities: &[f32] = if photograph {
        &[76.0, 80.0, 85.0, 90.0, 95.0, 98.0]
    } else {
        &[88.0, 90.0, 95.0, 98.0]
    };
    for &quality in qualities {
        let mut encoder = jpegli::Compress::new(jpegli::ColorSpace::JCS_RGB);
        encoder.set_size(rgb.width() as usize, rgb.height() as usize);
        encoder.set_quality(quality);
        encoder.set_chroma_sampling_pixel_sizes((1, 1), (1, 1));
        encoder.set_smoothing_factor(0);
        encoder.set_optimize_coding(true);
        encoder.set_progressive_mode();
        let mut writer = encoder.start_compress(Vec::new()).ok()?;
        // Preserve color profiles, including FlightHub's Display P3 captures.
        // JPEG ICC chunks use one-based sequence numbers (ICC.1 specification).
        if let Some(profile) = &icc {
            let chunks = profile.chunks(65_519);
            let count = u8::try_from(chunks.len()).ok()?;
            for (i, chunk) in chunks.enumerate() {
                let mut marker = b"ICC_PROFILE\0".to_vec();
                marker.extend_from_slice(&[(i + 1) as u8, count]);
                marker.extend_from_slice(chunk);
                writer.write_marker(jpegli::Marker::APP(2), &marker);
            }
        }
        writer.write_scanlines(rgb.as_raw()).ok()?;
        let encoded = writer.finish().ok()?;
        // Require a useful saving; a higher quality retry will not help size.
        if encoded.len() >= bytes.len() * 95 / 100 {
            return None;
        }
        let check = image::load_from_memory(&encoded).ok()?.into_rgb8();
        let accepted = quality_ok(&rgb, &check, photograph);
        #[cfg(test)]
        if std::env::var_os("TAIZHOU_COMPRESSION_SOURCE").is_some() {
            eprintln!(
                "quality {quality}: {} -> {}, quality accepted: {accepted}",
                bytes.len(),
                encoded.len()
            );
        }
        if accepted {
            return Some(encoded);
        }
    }
    None
}

// Full-resolution RGB error and 8x8 luma SSIM; do not downsample metrics.
// SSIM protects local structure while allowing small errors on sharp edges.
// These are quality guards, not a claim of perceptual losslessness.
fn quality_ok(original: &RgbImage, encoded: &RgbImage, photograph: bool) -> bool {
    if original.dimensions() != encoded.dimensions() || original.is_empty() {
        return false;
    }
    let mut total_error = 0f64;
    let mut total_ssim = 0f64;
    let mut blocks = 0usize;
    let (max_mse, min_mean_ssim, min_local_ssim) = if photograph {
        (10.5, 0.98, 0.85) // ~37.9 dB RGB PSNR; tested at original resolution
    } else {
        (14.0, 0.99, 0.90) // ~36.7 dB; retain stronger structural guard for labels
    };
    for y in (0..original.height()).step_by(8) {
        for x in (0..original.width()).step_by(8) {
            let (mut sa, mut sb, mut saa, mut sbb, mut sab, mut error, mut n) =
                (0f64, 0f64, 0f64, 0f64, 0f64, 0f64, 0f64);
            for row in y..(y + 8).min(original.height()) {
                for col in x..(x + 8).min(original.width()) {
                    let a = original.get_pixel(col, row).0.map(f64::from);
                    let b = encoded.get_pixel(col, row).0.map(f64::from);
                    for c in 0..3 {
                        error += (a[c] - b[c]).powi(2);
                    }
                    let la = 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2];
                    let lb = 0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2];
                    sa += la;
                    sb += lb;
                    saa += la * la;
                    sbb += lb * lb;
                    sab += la * lb;
                    n += 1.0;
                }
            }
            if error / (n * 3.0) > 256.0 {
                return false;
            }
            let (ma, mb) = (sa / n, sb / n);
            let va = (saa / n - ma * ma).max(0.0);
            let vb = (sbb / n - mb * mb).max(0.0);
            let cov = sab / n - ma * mb;
            let ssim = ((2.0 * ma * mb + 6.5025) * (2.0 * cov + 58.5225))
                / ((ma * ma + mb * mb + 6.5025) * (va + vb + 58.5225));
            if ssim < min_local_ssim {
                return false;
            }
            total_ssim += ssim;
            total_error += error;
            blocks += 1;
        }
    }
    total_error / original.as_raw().len() as f64 <= max_mse
        && total_ssim / blocks as f64 >= min_mean_ssim
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_guard_rejects_local_damage_and_dimension_changes() {
        let original = RgbImage::from_pixel(256, 256, image::Rgb([100; 3]));
        let mut damaged = original.clone();
        for y in 0..16 {
            for x in 0..16 {
                damaged.put_pixel(x, y, image::Rgb([120; 3]));
            }
        }
        assert!(!quality_ok(&original, &damaged, true));
        assert!(!quality_ok(&original, &RgbImage::new(128, 128), true));
        assert!(quality_ok(&original, &original, true));
    }

    #[test]
    fn quality_guard_rejects_blurred_small_details_and_keeps_odd_edges() {
        let mut original = RgbImage::from_pixel(257, 259, image::Rgb([128; 3]));
        for y in 0..8 {
            for x in 0..8 {
                original.put_pixel(
                    x,
                    y,
                    image::Rgb([if (x + y) % 2 == 0 { 100 } else { 156 }; 3]),
                );
            }
        }
        let blurred = RgbImage::from_pixel(257, 259, image::Rgb([128; 3]));
        assert!(!quality_ok(&original, &blurred, true));
        assert!(!quality_ok(&original, &blurred, false));
        assert!(quality_ok(&original, &original, false));
        let mut edge = original.clone();
        edge.put_pixel(256, 258, image::Rgb([255, 0, 0]));
        assert!(!quality_ok(&original, &edge, false));
    }

    #[test]
    fn compresses_opaque_png_without_resizing_and_keeps_transparency() {
        let rgb = RgbImage::from_fn(512, 512, |x, y| {
            image::Rgb([(x / 2) as u8, (y / 2) as u8, ((x + y) / 4) as u8])
        });
        let mut input = Vec::new();
        // Uncompressed PNG ensures this tests the conversion, not a size fallback.
        let mut encoder = png::Encoder::new(&mut input, 512, 512);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_compression(png::Compression::NoCompression);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(rgb.as_raw())
            .unwrap();
        let (output, ext) = compress(input.clone(), "png");
        assert_eq!(ext, "jpeg");
        assert!(output.len() < input.len() / 2);
        assert!(quality_ok(
            &rgb,
            &image::load_from_memory(&output).unwrap().into_rgb8(),
            false
        ));
        let mut alpha = Vec::new();
        let mut encoder = png::Encoder::new(&mut alpha, 512, 512);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_compression(png::Compression::NoCompression);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&vec![100; 512 * 512 * 4])
            .unwrap();
        assert_eq!(compress(alpha.clone(), "png"), (alpha, "png"));
        assert_eq!(
            compress(vec![0; 100_000], "jpeg"),
            (vec![0; 100_000], "jpeg")
        );
    }

    #[test]
    fn preserves_icc_profile_and_compresses_high_quality_jpeg() {
        let rgb = RgbImage::from_fn(512, 512, |x, y| {
            image::Rgb([(x / 2) as u8, (y / 2) as u8, ((x + y) / 4) as u8])
        });
        let profile = vec![42; 70_000]; // Exercise multi-marker ICC sequence numbers.
        let mut info = png::Info::with_size(512, 512);
        info.color_type = png::ColorType::Rgb;
        info.icc_profile = Some(std::borrow::Cow::Borrowed(&profile));
        let mut input = Vec::new();
        let mut encoder = png::Encoder::with_info(&mut input, info).unwrap();
        encoder.set_compression(png::Compression::NoCompression);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(rgb.as_raw())
            .unwrap();
        let (encoded, ext) = compress(input, "png");
        assert_eq!(ext, "jpeg");
        let mut decoder = ImageReader::new(Cursor::new(&encoded))
            .with_guessed_format()
            .unwrap()
            .into_decoder()
            .unwrap();
        assert_eq!(decoder.icc_profile().unwrap().unwrap(), profile);

        let mut encoder = mozjpeg::Compress::new(mozjpeg::ColorSpace::JCS_RGB);
        encoder.set_size(512, 512);
        encoder.set_quality(100.0);
        encoder.set_chroma_sampling_pixel_sizes((1, 1), (1, 1));
        let mut writer = encoder.start_compress(Vec::new()).unwrap();
        writer.write_scanlines(rgb.as_raw()).unwrap();
        let input = writer.finish().unwrap();
        // Real camera JPEGs can contain large auxiliary metadata. Ensure the
        // minimum input threshold is met without changing decoded pixels.
        let mut padded = input[..2].to_vec();
        padded.extend_from_slice(&[0xff, 0xfe, 0xff, 0xff]);
        padded.extend(vec![0; 65_533]);
        padded.extend_from_slice(&input[2..]);
        let encoded = lossless_jpeg(&padded).unwrap();
        assert!(encoded.len() < padded.len());
        assert_eq!(
            image::load_from_memory(&input).unwrap(),
            image::load_from_memory(&encoded).unwrap()
        );
        let truncated = &padded[..padded.len() - 200];
        assert!(lossless_jpeg(truncated).is_none());
    }

    #[test]
    #[ignore = "requires explicit archived source; writes QA copies only"]
    fn compares_archived_photos() {
        let source = std::env::var("TAIZHOU_COMPRESSION_SOURCE").unwrap();
        let output = std::path::PathBuf::from(std::env::var("TAIZHOU_COMPRESSION_OUTPUT").unwrap());
        std::fs::create_dir_all(&output).unwrap();
        let data: crate::flight_report::Collected =
            serde_json::from_slice(&std::fs::read(source).unwrap()).unwrap();
        let groups = crate::flight_report::high_temperature_groups(&data).unwrap();
        let docx = crate::flight_report::build_docx(
            &data,
            &[
                crate::flight_report::tests::PNG.into(),
                crate::flight_report::tests::PNG.into(),
            ],
            chrono::Utc::now().timestamp_millis(),
        )
        .unwrap();
        std::fs::write(output.join("compressed-report.docx"), &docx).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(&docx)).unwrap();
        let mut photos: Vec<_> = data.photos.iter().collect();
        photos.sort_by_key(|p| crate::flight_report::photo_time(&p.name).unwrap());
        let mut before = 0;
        let mut after = 0;
        for (i, p) in photos.iter().enumerate() {
            let (input, ext) = p.decode_display_image().unwrap();
            before += input.len();
            if !groups.iter().any(|g| g.contains(&p.name)) {
                continue;
            }
            let dimensions = crate::flight_report::image_dimensions(&input).unwrap();
            std::fs::write(output.join(format!("{i}-before.{ext}")), &input).unwrap();
            let prefix = format!("word/media/flight-{}.", i + 1000);
            let name = zip
                .file_names()
                .find(|n| n.starts_with(&prefix))
                .unwrap()
                .to_owned();
            let mut result = Vec::new();
            std::io::Read::read_to_end(&mut zip.by_name(&name).unwrap(), &mut result).unwrap();
            let output_ext = name.rsplit('.').next().unwrap();
            assert_eq!(
                crate::flight_report::image_dimensions(&result).unwrap(),
                dimensions
            );
            if ext == "jpeg" {
                assert!(quality_ok(
                    &image::load_from_memory(&input).unwrap().into_rgb8(),
                    &image::load_from_memory(&result).unwrap().into_rgb8(),
                    true
                ));
            }
            std::fs::write(output.join(format!("{i}-after.{output_ext}")), &result).unwrap();
            println!(
                "photo {i}: {} -> {} bytes, {:?}",
                input.len(),
                result.len(),
                dimensions
            );
            after += result.len();
        }
        println!("DOCX photo media total: {before} -> {after} bytes");
        println!("DOCX: {} bytes", docx.len());
    }
}
