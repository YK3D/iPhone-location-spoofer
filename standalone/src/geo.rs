//! Spherical geometry helpers (WGS84 approximated by a sphere).

use rand::Rng;

pub const EARTH_RADIUS_M: f64 = 6_371_008.8;

pub type LatLon = (f64, f64);

pub fn haversine_m(a: LatLon, b: LatLon) -> f64 {
    let (lat1, lon1) = (a.0.to_radians(), a.1.to_radians());
    let (lat2, lon2) = (b.0.to_radians(), b.1.to_radians());
    let dlat = lat2 - lat1;
    let dlon = lon2 - lon1;
    let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * h.sqrt().min(1.0).asin()
}

/// Initial bearing from a to b, degrees clockwise from north, in [0, 360).
pub fn bearing_deg(a: LatLon, b: LatLon) -> f64 {
    let (lat1, lon1) = (a.0.to_radians(), a.1.to_radians());
    let (lat2, lon2) = (b.0.to_radians(), b.1.to_radians());
    let dlon = lon2 - lon1;
    let x = dlon.sin() * lat2.cos();
    let y = lat1.cos() * lat2.sin() - lat1.sin() * lat2.cos() * dlon.cos();
    (x.atan2(y).to_degrees() + 360.0) % 360.0
}

pub fn wrap_lon(lon: f64) -> f64 {
    ((lon + 180.0).rem_euclid(360.0)) - 180.0
}

/// Point at fraction f along the great circle from a to b.
pub fn interpolate(a: LatLon, b: LatLon, f: f64) -> LatLon {
    if f <= 0.0 {
        return a;
    }
    if f >= 1.0 {
        return b;
    }
    let d = haversine_m(a, b) / EARTH_RADIUS_M;
    if d < 1e-9 {
        return a;
    }
    let (lat1, lon1) = (a.0.to_radians(), a.1.to_radians());
    let (lat2, lon2) = (b.0.to_radians(), b.1.to_radians());
    let sa = ((1.0 - f) * d).sin() / d.sin();
    let sb = (f * d).sin() / d.sin();
    let x = sa * lat1.cos() * lon1.cos() + sb * lat2.cos() * lon2.cos();
    let y = sa * lat1.cos() * lon1.sin() + sb * lat2.cos() * lon2.sin();
    let z = sa * lat1.sin() + sb * lat2.sin();
    let lat = z.atan2((x * x + y * y).sqrt());
    let lon = y.atan2(x);
    (lat.to_degrees(), wrap_lon(lon.to_degrees()))
}

/// Point reached travelling `distance_m` from `a` on the given initial bearing.
pub fn destination(a: LatLon, bearing: f64, distance_m: f64) -> LatLon {
    let (lat1, lon1) = (a.0.to_radians(), a.1.to_radians());
    let brg = bearing.to_radians();
    let d = distance_m / EARTH_RADIUS_M;
    let lat2 = (lat1.sin() * d.cos() + lat1.cos() * d.sin() * brg.cos()).asin();
    let lon2 = lon1 + (brg.sin() * d.sin() * lat1.cos()).atan2(d.cos() - lat1.sin() * lat2.sin());
    (lat2.to_degrees(), wrap_lon(lon2.to_degrees()))
}

/// Random point with a Gaussian-ish offset (sigma = radius/2) around p.
pub fn jitter(p: LatLon, radius_m: f64, rng: &mut impl Rng) -> LatLon {
    if radius_m <= 0.0 {
        return p;
    }
    // Box-Muller
    let u1: f64 = rng.gen_range(f64::EPSILON..1.0);
    let u2: f64 = rng.gen_range(0.0..1.0);
    let g = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos();
    let dist = (g.abs() * radius_m / 2.0).min(radius_m * 2.0);
    destination(p, rng.gen_range(0.0..360.0), dist)
}

/// Insert great-circle points so no step is longer than `max_step_m`.
pub fn densify(points: &[LatLon], max_step_m: f64) -> Vec<LatLon> {
    let mut out = Vec::with_capacity(points.len());
    if points.is_empty() {
        return out;
    }
    out.push(points[0]);
    for w in points.windows(2) {
        let d = haversine_m(w[0], w[1]);
        let n = ((d / max_step_m).ceil() as usize).max(1);
        for i in 1..=n {
            out.push(interpolate(w[0], w[1], i as f64 / n as f64));
        }
    }
    out
}

pub fn polyline_length(points: &[LatLon]) -> f64 {
    points.windows(2).map(|w| haversine_m(w[0], w[1])).sum()
}

pub fn validate_latlon(lat: f64, lon: f64) -> Result<(), String> {
    if !(lat.is_finite() && lon.is_finite()) {
        return Err("Coordinates must be finite numbers".into());
    }
    if !(-90.0..=90.0).contains(&lat) {
        return Err(format!("Latitude {lat} is outside -90..90"));
    }
    if !(-180.0..=180.0).contains(&lon) {
        return Err(format!("Longitude {lon} is outside -180..180"));
    }
    Ok(())
}

/// Parse "19.0761, 72.8775", "19.0761 72.8775" or DMS like 40°42'46"N 74°00'21"W.
pub fn parse_coordinates(text: &str) -> Result<LatLon, String> {
    let s = text.trim();
    let dms = regex::Regex::new(
        r#"(?i)(\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*["″]\s*)?([NSEW])"#,
    )
    .unwrap();
    let caps: Vec<_> = dms.captures_iter(s).collect();
    let (lat, lon) = if caps.len() == 2 {
        let mut lat = None;
        let mut lon = None;
        for c in caps {
            let deg: f64 = c[1].parse().unwrap_or(0.0);
            let min: f64 = c.get(2).map(|m| m.as_str().parse().unwrap_or(0.0)).unwrap_or(0.0);
            let sec: f64 = c.get(3).map(|m| m.as_str().parse().unwrap_or(0.0)).unwrap_or(0.0);
            let hemi = c[4].to_uppercase();
            let mut v = deg + min / 60.0 + sec / 3600.0;
            if hemi == "S" || hemi == "W" {
                v = -v;
            }
            if hemi == "N" || hemi == "S" {
                lat = Some(v);
            } else {
                lon = Some(v);
            }
        }
        match (lat, lon) {
            (Some(a), Some(b)) => (a, b),
            _ => return Err("DMS coordinates need one N/S and one E/W value".into()),
        }
    } else {
        let num = regex::Regex::new(r"[-+−]?\d+(?:\.\d+)?").unwrap();
        let nums: Vec<f64> = num
            .find_iter(s)
            .filter_map(|m| m.as_str().replace('−', "-").parse().ok())
            .collect();
        if nums.len() != 2 {
            return Err("Enter two numbers: latitude and longitude".into());
        }
        (nums[0], nums[1])
    };
    validate_latlon(lat, lon)?;
    Ok((lat, lon))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let a = (10.0, 20.0);
        let b = destination(a, 45.0, 12345.0);
        assert!((haversine_m(a, b) - 12345.0).abs() < 0.05);
        assert!((bearing_deg(a, b) - 45.0).abs() < 0.01);
        let m = interpolate(a, b, 0.5);
        assert!((haversine_m(a, m) - 12345.0 / 2.0).abs() < 0.05);
    }

    #[test]
    fn coords() {
        assert_eq!(parse_coordinates("19.0761, 72.8775").unwrap(), (19.0761, 72.8775));
        assert_eq!(parse_coordinates("40.7128 -74.0060").unwrap(), (40.7128, -74.006));
        let (lat, lon) = parse_coordinates("40°42'46\"N 74°00'21\"W").unwrap();
        assert!((lat - 40.712778).abs() < 1e-5 && (lon + 74.005833).abs() < 1e-5);
        for bad in ["", "abc", "91, 0", "0, 181", "1 2 3"] {
            assert!(parse_coordinates(bad).is_err(), "{bad}");
        }
    }
}
