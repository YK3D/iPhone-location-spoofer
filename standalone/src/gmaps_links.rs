//! Google Maps links -> coordinates or a list of route stops (same rules as gmaps_links.py).

use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use url::Url;

const SHORT_HOSTS: [&str; 3] = ["maps.app.goo.gl", "goo.gl", "g.co"];

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Stop {
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub name: String,
    pub query: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ParsedLink {
    pub kind: String, // point | route
    pub stops: Vec<Stop>,
    pub mode: Option<String>,
    pub url: String,
}

fn google_host(host: &str) -> bool {
    Regex::new(r"(^|\.)google\.[a-z.]+$|(^|\.)googleusercontent\.com$").unwrap().is_match(host)
}

fn decode(s: &str) -> String {
    percent_encoding::percent_decode_str(&s.replace('+', " ")).decode_utf8_lossy().to_string()
}

fn coord(text: &str) -> Option<(f64, f64)> {
    let re = Regex::new(r"^\s*(?:loc:\s*)?([-+]?\d{1,2}(?:\.\d+)?)\s*,\s*([-+]?\d{1,3}(?:\.\d+)?)\s*$").unwrap();
    let c = re.captures(text)?;
    let (lat, lon): (f64, f64) = (c[1].parse().ok()?, c[2].parse().ok()?);
    ((-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)).then_some((lat, lon))
}

fn stop(text: &str) -> Stop {
    let t = decode(text).trim().to_string();
    match coord(&t) {
        Some((lat, lon)) => Stop { lat: Some(lat), lon: Some(lon), name: format!("{lat:.6}, {lon:.6}"), query: String::new() },
        None => Stop { lat: None, lon: None, name: t.clone(), query: t },
    }
}

pub fn is_google_maps_url(text: &str) -> bool {
    match Url::parse(text.trim()) {
        Ok(u) => {
            let host = u.host_str().unwrap_or("").to_lowercase();
            matches!(u.scheme(), "http" | "https") && (SHORT_HOSTS.contains(&host.as_str()) || google_host(&host))
        }
        Err(_) => false,
    }
}

fn point(stops: Vec<Stop>, mode: Option<String>, url: &str) -> ParsedLink {
    ParsedLink { kind: "point".into(), stops, mode, url: url.into() }
}

pub fn parse(url: &str) -> Result<ParsedLink, String> {
    let url = url.trim();
    let u = Url::parse(url).map_err(|_| "That is not a valid link".to_string())?;
    let host = u.host_str().unwrap_or("").to_lowercase();
    if !google_host(&host) {
        return Err("That is not a Google Maps link".into());
    }
    let qs: HashMap<String, String> = u.query_pairs().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    let path = u.path().to_string();
    let full = decode(url);

    if host.starts_with("consent.") {
        if let Some(c) = qs.get("continue") {
            return parse(c);
        }
    }
    let mut mode = qs.get("travelmode").and_then(|m| match m.to_lowercase().as_str() {
        "driving" | "two-wheeler" | "transit" => Some("car".to_string()),
        "walking" => Some("foot".to_string()),
        "bicycling" => Some("bike".to_string()),
        _ => None,
    });
    if mode.is_none() && path.contains("/dir/") {
        if let Some(c) = Regex::new(r"!3e(\d)").unwrap().captures(&full) {
            mode = match &c[1] {
                "1" => Some("bike".into()),
                "2" => Some("foot".into()),
                _ => Some("car".into()),
            };
        }
    }

    // directions
    if qs.get("api").map(|v| v == "1").unwrap_or(false) && path.trim_end_matches('/').ends_with("/dir") {
        let mut stops = Vec::new();
        if let Some(o) = qs.get("origin").filter(|s| !s.is_empty()) {
            stops.push(stop(o));
        }
        for w in qs.get("waypoints").map(|s| s.as_str()).unwrap_or("").split('|') {
            if !w.trim().is_empty() {
                stops.push(stop(w));
            }
        }
        let dest = qs.get("destination").filter(|s| !s.is_empty()).ok_or("The directions link has no destination")?;
        stops.push(stop(dest));
        return Ok(ParsedLink { kind: "route".into(), stops, mode, url: url.into() });
    }
    if qs.contains_key("saddr") || qs.contains_key("daddr") {
        let mut stops = Vec::new();
        if let Some(s) = qs.get("saddr").filter(|s| !s.is_empty()) {
            stops.push(stop(s));
        }
        let to = Regex::new(r"\s+to:\s*").unwrap();
        for part in to.split(qs.get("daddr").map(|s| s.as_str()).unwrap_or("")) {
            if !part.trim().is_empty() {
                stops.push(stop(part));
            }
        }
        if !stops.is_empty() {
            let kind = if stops.len() > 1 { "route" } else { "point" };
            return Ok(ParsedLink { kind: kind.into(), stops, mode, url: url.into() });
        }
    }
    if let Some(rest) = path.split_once("/dir/").map(|x| x.1) {
        let segs: Vec<&str> = rest
            .split('/')
            .filter(|s| !s.is_empty() && !s.starts_with('@') && !s.starts_with("data=") && *s != "am=t")
            .collect();
        let mut stops: Vec<Stop> = segs.iter().map(|s| stop(s)).collect();
        let pairs: Vec<(f64, f64)> = Regex::new(r"!1d([-+]?\d{1,3}\.\d+)!2d([-+]?\d{1,2}\.\d+)")
            .unwrap()
            .captures_iter(&full)
            .filter_map(|c| Some((c[2].parse().ok()?, c[1].parse().ok()?)))
            .collect();
        let named = stops.iter().filter(|s| s.lat.is_none()).count();
        if named > 0 && pairs.len() == named {
            let mut it = pairs.into_iter();
            for s in stops.iter_mut().filter(|s| s.lat.is_none()) {
                if let Some((lat, lon)) = it.next() {
                    s.lat = Some(lat);
                    s.lon = Some(lon);
                }
            }
        }
        if stops.len() >= 2 {
            return Ok(ParsedLink { kind: "route".into(), stops, mode, url: url.into() });
        }
        if stops.len() == 1 {
            return Ok(point(stops, mode, url));
        }
    }

    // single places
    let pin = Regex::new(r"!3d([-+]?\d{1,2}\.\d+)!4d([-+]?\d{1,3}\.\d+)").unwrap();
    if let Some(c) = pin.captures_iter(&full).last() {
        let (lat, lon): (f64, f64) = (c[1].parse().unwrap(), c[2].parse().unwrap());
        let name = path
            .split_once("/place/")
            .map(|x| decode(x.1.split('/').next().unwrap_or("")))
            .filter(|s| !s.is_empty())
            .unwrap_or(format!("{lat:.6}, {lon:.6}"));
        return Ok(point(vec![Stop { lat: Some(lat), lon: Some(lon), name, query: String::new() }], mode, url));
    }
    for key in ["query", "q", "ll", "center", "destination"] {
        if let Some(v) = qs.get(key).filter(|s| !s.is_empty()) {
            return Ok(point(vec![stop(v)], mode, url));
        }
    }
    let at = Regex::new(r"@([-+]?\d{1,2}\.\d+),([-+]?\d{1,3}\.\d+)").unwrap();
    if let Some(rest) = path.split_once("/search/").map(|x| x.1) {
        let text = rest.split('/').next().unwrap_or("");
        if !text.is_empty() {
            return Ok(point(vec![stop(text)], mode, url));
        }
    }
    if let Some(rest) = path.split_once("/place/").map(|x| x.1) {
        let text = rest.split('/').next().unwrap_or("");
        if let Some(c) = at.captures(&full) {
            let (lat, lon): (f64, f64) = (c[1].parse().unwrap(), c[2].parse().unwrap());
            return Ok(point(vec![Stop { lat: Some(lat), lon: Some(lon), name: decode(text), query: String::new() }], mode, url));
        }
        return Ok(point(vec![stop(text)], mode, url));
    }
    if let Some(c) = at.captures(&full) {
        let (lat, lon): (f64, f64) = (c[1].parse().unwrap(), c[2].parse().unwrap());
        return Ok(point(
            vec![Stop { lat: Some(lat), lon: Some(lon), name: format!("{lat:.6}, {lon:.6}"), query: String::new() }],
            mode,
            url,
        ));
    }
    Err("Could not find a location in that Google Maps link".into())
}

/// Follow a short link's redirects (only to Google hosts) and return the final URL.
pub async fn resolve(url: &str, client: &reqwest::Client) -> Result<String, String> {
    let mut current = url.trim().to_string();
    for _ in 0..6 {
        let host = Url::parse(&current).ok().and_then(|u| u.host_str().map(|h| h.to_lowercase())).unwrap_or_default();
        if !SHORT_HOSTS.contains(&host.as_str()) {
            return Ok(current);
        }
        let r = client
            .get(&current)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
            .send()
            .await
            .map_err(|e| format!("Could not open the short link: {e}"))?;
        if r.status().is_redirection() {
            let loc = r.headers().get("location").and_then(|v| v.to_str().ok()).ok_or("Short link without a target")?;
            let next = Url::parse(&current).and_then(|b| b.join(loc)).map_err(|_| "Bad redirect")?.to_string();
            let nhost = Url::parse(&next).ok().and_then(|u| u.host_str().map(|h| h.to_lowercase())).unwrap_or_default();
            if !SHORT_HOSTS.contains(&nhost.as_str()) && !google_host(&nhost) {
                return Err(format!("The short link points outside Google Maps ({nhost})"));
            }
            current = next;
            continue;
        }
        let status = r.status();
        let body = r.text().await.unwrap_or_default();
        if let Some(m) = Regex::new(r#"https://www\.google\.[a-z.]+/maps[^"'\s<>]+"#).unwrap().find(&body) {
            return Ok(m.as_str().replace("\\u0026", "&").replace("&amp;", "&"));
        }
        return Err(format!("Could not resolve the short link (HTTP {})", status.as_u16()));
    }
    Err("Too many redirects while resolving the short link".into())
}

/// A client that does not follow redirects automatically (so every hop can be checked).
pub fn no_redirect_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("http client")
}

pub async fn parse_any(text: &str, client: &reqwest::Client) -> Result<ParsedLink, String> {
    if !is_google_maps_url(text) {
        return Err("Paste a link from Google Maps (google.com/maps/... or maps.app.goo.gl/...)".into());
    }
    let host = Url::parse(text.trim()).ok().and_then(|u| u.host_str().map(|h| h.to_lowercase())).unwrap_or_default();
    let final_url = if SHORT_HOSTS.contains(&host.as_str()) { resolve(text, client).await? } else { text.trim().to_string() };
    let mut out = parse(&final_url)?;
    out.url = text.trim().to_string();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn points() {
        let cases = [
            ("https://www.google.com/maps/place/Eiffel+Tower/@48.8583701,2.2919064,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x1!8m2!3d48.8583701!4d2.2944813", 48.8583701, 2.2944813),
            ("https://www.google.com/maps/@40.7127753,-74.0059728,15z", 40.7127753, -74.0059728),
            ("https://www.google.com/maps/search/?api=1&query=47.5951518%2C-122.3316393", 47.5951518, -122.3316393),
            ("https://maps.google.com/maps?q=loc:-33.8688,151.2093", -33.8688, 151.2093),
            ("https://www.google.co.uk/maps?ll=51.5072,-0.1276&z=12", 51.5072, -0.1276),
            ("https://www.google.com/maps/search/19.0761,+72.8775", 19.0761, 72.8775),
        ];
        for (u, lat, lon) in cases {
            let p = parse(u).unwrap();
            assert_eq!(p.kind, "point", "{u}");
            assert!((p.stops[0].lat.unwrap() - lat).abs() < 1e-9 && (p.stops[0].lon.unwrap() - lon).abs() < 1e-9, "{u}");
        }
    }

    #[test]
    fn routes() {
        let p = parse("https://www.google.com/maps/dir/?api=1&origin=48.85,2.29&destination=48.86,2.35&waypoints=48.855,2.30%7CLouvre+Museum&travelmode=walking").unwrap();
        assert_eq!(p.kind, "route");
        assert_eq!(p.mode.as_deref(), Some("foot"));
        assert_eq!(p.stops.iter().map(|s| s.lat).collect::<Vec<_>>(), vec![Some(48.85), Some(48.855), None, Some(48.86)]);
        assert_eq!(p.stops[2].query, "Louvre Museum");
        let url = "https://www.google.com/maps/dir/Eiffel+Tower,+Paris/48.8606,2.3376/Arc+de+Triomphe/@48.86,2.31,14z/data=!4m14!4m13!1m5!1m1!1s0x0:0x1!2m2!1d2.2944813!2d48.8583701!1m0!1m5!1m1!1s0x0:0x2!2m2!1d2.2950275!2d48.8737917!3e0";
        let p = parse(url).unwrap();
        assert_eq!(p.mode.as_deref(), Some("car"));
        assert_eq!(p.stops.len(), 3);
        assert_eq!(p.stops[0].lat, Some(48.8583701));
        assert_eq!(p.stops[2].lat, Some(48.8737917));
    }

    #[test]
    fn rejects() {
        assert!(parse("https://example.com/maps/@1,2,3z").is_err());
        assert!(!is_google_maps_url("not a link"));
        let inner = "https://www.google.com/maps/@10.5,20.25,10z";
        let wrapped = format!("https://consent.google.com/m?continue={}", percent_encoding::utf8_percent_encode(inner, percent_encoding::NON_ALPHANUMERIC));
        assert_eq!(parse(&wrapped).unwrap().stops[0].lat, Some(10.5));
    }
}
