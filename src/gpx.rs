//! GPX 1.0 / 1.1 reading and writing.

use chrono::{DateTime, Duration, FixedOffset, NaiveDate, SecondsFormat, TimeZone, Utc};
use regex::Regex;
use serde::Serialize;

use crate::profile::TimelinePoint;

#[derive(Clone, Debug, Serialize)]
pub struct GpxPoint {
    pub lat: f64,
    pub lon: f64,
    #[serde(skip)]
    pub time: Option<DateTime<Utc>>,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GpxTrack {
    pub name: String,
    pub kind: String, // track | route | waypoints
    pub points: Vec<GpxPoint>,
}

impl GpxTrack {
    pub fn timed(&self) -> bool {
        self.points.len() > 1 && self.points.iter().all(|p| p.time.is_some())
    }
}

pub fn parse_time(text: &str) -> Option<DateTime<Utc>> {
    let re = Regex::new(
        r"^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,15}))?(Z|[+\-]\d{2}:?(?:\d{2})?)?$",
    )
    .unwrap();
    let c = re.captures(text.trim())?;
    let num = |i: usize| c.get(i).and_then(|m| m.as_str().parse::<u32>().ok());
    let year: i32 = c[1].parse().ok()?;
    let date = NaiveDate::from_ymd_opt(year, num(2)?, num(3)?)?;
    let frac = c.get(7).map(|m| m.as_str()).unwrap_or("0");
    let micros: u32 = format!("{:0<6}", &frac[..frac.len().min(6)]).parse().ok()?;
    let naive = date.and_hms_micro_opt(num(4)?, num(5)?, num(6)?, micros)?;
    let offset = match c.get(8).map(|m| m.as_str()) {
        None | Some("Z") => FixedOffset::east_opt(0)?,
        Some(z) => {
            let digits: String = z[1..].chars().filter(|ch| *ch != ':').collect();
            let h: i32 = digits.get(0..2)?.parse().ok()?;
            let m: i32 = digits.get(2..4).and_then(|x| x.parse().ok()).unwrap_or(0);
            let secs = (h * 3600 + m * 60) * if z.starts_with('-') { -1 } else { 1 };
            FixedOffset::east_opt(secs)?
        }
    };
    Some(offset.from_local_datetime(&naive).single()?.with_timezone(&Utc))
}

fn child_text<'a>(node: roxmltree::Node<'a, 'a>, name: &str) -> Option<&'a str> {
    node.children().find(|c| c.is_element() && c.tag_name().name() == name).and_then(|c| c.text())
}

fn point(node: roxmltree::Node) -> Result<GpxPoint, String> {
    let lat = node.attribute("lat").and_then(|v| v.trim().parse::<f64>().ok());
    let lon = node.attribute("lon").and_then(|v| v.trim().parse::<f64>().ok());
    match (lat, lon) {
        (Some(lat), Some(lon)) => Ok(GpxPoint {
            lat,
            lon,
            time: child_text(node, "time").and_then(parse_time),
            name: child_text(node, "name").map(|s| s.to_string()),
        }),
        _ => Err("GPX point without a valid lat/lon".into()),
    }
}

/// All tracks (segments joined), routes and the waypoint set found in a GPX document.
pub fn parse_gpx(data: &str) -> Result<Vec<GpxTrack>, String> {
    // roxmltree rejects DTDs by default, which blocks entity-expansion ("billion laughs") files.
    let doc = roxmltree::Document::parse(data).map_err(|e| format!("Not a valid GPX/XML file: {e}"))?;
    let root = doc.root_element();
    if root.tag_name().name() != "gpx" {
        return Err("Not a GPX file (root element is not <gpx>)".into());
    }
    let mut out = Vec::new();
    let mut wpts = Vec::new();
    let (mut ntrk, mut nrte) = (0, 0);
    for el in root.children().filter(|c| c.is_element()) {
        match el.tag_name().name() {
            "trk" => {
                ntrk += 1;
                let mut pts = Vec::new();
                for seg in el.children().filter(|c| c.is_element() && c.tag_name().name() == "trkseg") {
                    for p in seg.children().filter(|c| c.is_element() && c.tag_name().name() == "trkpt") {
                        pts.push(point(p)?);
                    }
                }
                if !pts.is_empty() {
                    let name = child_text(el, "name").map(|s| s.to_string()).unwrap_or(format!("Track {ntrk}"));
                    out.push(GpxTrack { name, kind: "track".into(), points: pts });
                }
            }
            "rte" => {
                nrte += 1;
                let pts: Result<Vec<_>, _> = el
                    .children()
                    .filter(|c| c.is_element() && c.tag_name().name() == "rtept")
                    .map(point)
                    .collect();
                let pts = pts?;
                if !pts.is_empty() {
                    let name = child_text(el, "name").map(|s| s.to_string()).unwrap_or(format!("Route {nrte}"));
                    out.push(GpxTrack { name, kind: "route".into(), points: pts });
                }
            }
            "wpt" => wpts.push(point(el)?),
            _ => {}
        }
    }
    if !wpts.is_empty() {
        out.push(GpxTrack { name: "Waypoints".into(), kind: "waypoints".into(), points: wpts });
    }
    if out.is_empty() {
        return Err("The GPX file contains no tracks, routes or waypoints".into());
    }
    Ok(out)
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn fmt_time(t: DateTime<Utc>) -> String {
    if t.timestamp_subsec_millis() == 0 {
        t.to_rfc3339_opts(SecondsFormat::Secs, true)
    } else {
        t.to_rfc3339_opts(SecondsFormat::Millis, true)
    }
}

/// GPX 1.1 track with one timed <trkpt> per sample.
pub fn write_gpx(samples: &[TimelinePoint], name: &str, waypoints: &[(f64, f64, String)]) -> String {
    let start = Utc::now().with_timezone(&Utc);
    let start = Utc.timestamp_opt(start.timestamp(), 0).single().unwrap_or(start);
    let mut s = String::new();
    s.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    s.push_str("<gpx version=\"1.1\" creator=\"Location Spoofer\" xmlns=\"http://www.topografix.com/GPX/1/1\">\n");
    s.push_str(&format!("  <metadata><name>{}</name><time>{}</time></metadata>\n", esc(name), fmt_time(start)));
    for (lat, lon, n) in waypoints {
        s.push_str(&format!("  <wpt lat=\"{lat:.7}\" lon=\"{lon:.7}\"><name>{}</name></wpt>\n", esc(n)));
    }
    s.push_str(&format!("  <trk><name>{}</name><trkseg>\n", esc(name)));
    for p in samples {
        let t = start + Duration::microseconds((p.t * 1e6).round() as i64);
        s.push_str(&format!(
            "    <trkpt lat=\"{:.7}\" lon=\"{:.7}\"><time>{}</time></trkpt>\n",
            p.lat,
            p.lon,
            fmt_time(t)
        ));
    }
    s.push_str("  </trkseg></trk>\n</gpx>\n");
    s
}

pub fn safe_filename(name: &str) -> String {
    let re = Regex::new(r"[^A-Za-z0-9._ -]+").unwrap();
    let base = re.replace_all(name, "_").trim_matches(|c| c == ' ' || c == '.').to_string();
    let base = if base.is_empty() { "route".to_string() } else { base };
    base.chars().take(80).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="manual" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
      <trkpt lat="19.07610" lon="72.87750"><time>2026-10-28T20:00:00Z</time></trkpt>
      <trkpt lat="19.07640" lon="72.87750"><time>2026-10-28T20:00:20Z</time></trkpt>
  </trkseg></trk>
  <rte><name>R</name><rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte>
  <wpt lat="5" lon="6"><name>Home</name></wpt>
</gpx>"#;

    #[test]
    fn parse_all_kinds() {
        let t = parse_gpx(EXAMPLE).unwrap();
        let kinds: Vec<_> = t.iter().map(|x| x.kind.as_str()).collect();
        assert_eq!(kinds, ["track", "route", "waypoints"]);
        assert!(t[0].timed());
        assert_eq!((t[0].points[1].time.unwrap() - t[0].points[0].time.unwrap()).num_seconds(), 20);
        assert_eq!(t[2].points[0].name.as_deref(), Some("Home"));
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse_gpx("<html></html>").is_err());
        assert!(parse_gpx("not xml").is_err());
        let bomb = r#"<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>
            <gpx><wpt lat="1" lon="1"><name>&lol2;</name></wpt></gpx>"#;
        assert!(parse_gpx(bomb).is_err());
    }

    #[test]
    fn times() {
        let t = parse_time("2026-10-28T20:00:00.5+02:00").unwrap();
        assert_eq!(t.to_rfc3339_opts(SecondsFormat::Millis, true), "2026-10-28T18:00:00.500Z");
        assert!(parse_time("garbage").is_none());
    }
}
