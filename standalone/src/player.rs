//! Plays a timeline (or the joystick) onto the connected device. Mirrors player.py.

use crate::device::DeviceManager;
use crate::geo;
use crate::profile::Timeline;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

pub type Devices = Arc<AsyncMutex<DeviceManager>>;

#[derive(Clone, Debug)]
pub struct Position {
    pub lat: f64,
    pub lon: f64,
    pub speed_ms: f64,
    pub course: f64,
    pub sent_at: f64,
}

fn now_s() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

impl Position {
    fn new(lat: f64, lon: f64, speed_ms: f64, course: f64) -> Self {
        Self { lat, lon, speed_ms, course, sent_at: now_s() }
    }
    fn json(&self) -> Value {
        json!({"lat": self.lat, "lon": self.lon, "speed_kmh": (self.speed_ms * 3.6 * 100.0).round() / 100.0,
               "course": (self.course * 10.0).round() / 10.0, "sent_at": self.sent_at})
    }
}

pub struct PState {
    pub timeline: Option<Arc<Timeline>>,
    pub name: String,
    pub state: String, // idle | playing | paused | finished | joystick | error
    pub t: f64,
    pub direction: f64,
    pub multiplier: f64,
    pub loop_mode: String,
    pub jitter_m: f64,
    pub tick_s: f64,
    pub laps: u32,
    pub position: Option<Position>,
    pub error: Option<String>,
    pub joy_bearing: f64,
    pub joy_speed_kmh: f64,
    pub joy_moving: bool,
}

impl Default for PState {
    fn default() -> Self {
        Self {
            timeline: None,
            name: String::new(),
            state: "idle".into(),
            t: 0.0,
            direction: 1.0,
            multiplier: 1.0,
            loop_mode: "once".into(),
            jitter_m: 0.0,
            tick_s: 1.0,
            laps: 0,
            position: None,
            error: None,
            joy_bearing: 0.0,
            joy_speed_kmh: 5.0,
            joy_moving: false,
        }
    }
}

impl PState {
    fn effective_tick(&self) -> f64 {
        if self.multiplier > 1.0 { (self.tick_s / self.multiplier).max(0.25) } else { self.tick_s }
    }
}

pub struct Player {
    pub st: Arc<Mutex<PState>>,
    task: AsyncMutex<Option<JoinHandle<()>>>,
    devices: Devices,
}

impl Player {
    pub fn new(devices: Devices) -> Self {
        Self { st: Arc::new(Mutex::new(PState::default())), task: AsyncMutex::new(None), devices }
    }

    pub fn status(&self) -> Value {
        let s = self.st.lock().unwrap();
        let (dur, dist, total) = match &s.timeline {
            Some(tl) => (tl.duration(), tl.at(s.t).distance_m, tl.distance()),
            None => (0.0, 0.0, 0.0),
        };
        json!({
            "state": s.state, "t": (s.t * 100.0).round() / 100.0, "duration": (dur * 100.0).round() / 100.0,
            "distance_m": (dist * 10.0).round() / 10.0, "total_distance_m": (total * 10.0).round() / 10.0,
            "name": s.name, "multiplier": s.multiplier, "loop": s.loop_mode, "jitter_m": s.jitter_m,
            "tick_s": s.tick_s, "laps": s.laps, "direction": s.direction,
            "position": s.position.as_ref().map(|p| p.json()), "error": s.error,
            "joystick": {"bearing": s.joy_bearing, "speed_kmh": s.joy_speed_kmh, "moving": s.joy_moving},
        })
    }

    async fn cancel(&self) {
        if let Some(t) = self.task.lock().await.take() {
            t.abort();
            let _ = t.await;
        }
    }

    async fn require_connected(&self) -> Result<(), String> {
        if self.devices.lock().await.connected() {
            Ok(())
        } else {
            Err("No device connected. Connect your iPhone (or the Simulator) first.".into())
        }
    }

    async fn send(&self, lat: f64, lon: f64, speed: f64, course: f64, jitter: bool) -> Result<(), String> {
        let (lat, lon) = {
            let j = self.st.lock().unwrap().jitter_m;
            if jitter && j > 0.0 { geo::jitter((lat, lon), j, &mut rand::thread_rng()) } else { (lat, lon) }
        };
        self.devices.lock().await.set_location(lat, lon).await?;
        self.st.lock().unwrap().position = Some(Position::new(lat, lon, speed, course));
        Ok(())
    }

    pub async fn load(&self, tl: Arc<Timeline>, name: String) {
        self.stop().await;
        let mut s = self.st.lock().unwrap();
        s.timeline = Some(tl);
        s.name = name;
        s.t = 0.0;
        s.direction = 1.0;
        s.laps = 0;
        s.state = "idle".into();
    }

    pub async fn play(self: &Arc<Self>) -> Result<(), String> {
        {
            let s = self.st.lock().unwrap();
            if s.timeline.is_none() {
                return Err("Build or import a route first".into());
            }
        }
        self.require_connected().await?;
        self.cancel().await;
        {
            let mut s = self.st.lock().unwrap();
            let dur = s.timeline.as_ref().unwrap().duration();
            if s.state == "finished" || (s.t >= dur && s.direction > 0.0) {
                s.t = 0.0;
                s.direction = 1.0;
            }
            s.error = None;
            s.state = "playing".into();
        }
        let me = self.clone();
        *self.task.lock().await = Some(tokio::spawn(async move { me.run_timeline().await }));
        Ok(())
    }

    pub async fn pause(&self) {
        if self.st.lock().unwrap().state != "playing" {
            return;
        }
        self.cancel().await;
        self.st.lock().unwrap().state = "paused".into();
    }

    pub async fn resume(self: &Arc<Self>) -> Result<(), String> {
        if self.st.lock().unwrap().state == "paused" {
            self.play().await
        } else {
            Ok(())
        }
    }

    pub async fn stop(&self) {
        self.cancel().await;
        let mut s = self.st.lock().unwrap();
        if ["playing", "paused", "joystick", "finished"].contains(&s.state.as_str()) {
            s.state = "idle".into();
        }
        s.joy_moving = false;
    }

    pub async fn seek(&self, t: f64) -> Result<(), String> {
        let (p, playing) = {
            let mut s = self.st.lock().unwrap();
            let Some(tl) = s.timeline.clone() else { return Ok(()) };
            s.t = t.clamp(0.0, tl.duration());
            let p = tl.at(s.t);
            s.position = Some(Position::new(p.lat, p.lon, p.speed_ms, p.course));
            (p, s.state == "playing")
        };
        if !playing && self.devices.lock().await.connected() {
            self.send(p.lat, p.lon, p.speed_ms, p.course, false).await?;
        }
        Ok(())
    }

    pub fn set_options(&self, multiplier: Option<f64>, loop_mode: Option<String>, jitter: Option<f64>, tick: Option<f64>) -> Result<(), String> {
        let mut s = self.st.lock().unwrap();
        if let Some(m) = multiplier {
            if !(0.05..=100.0).contains(&m) {
                return Err("Speed multiplier must be between 0.05 and 100".into());
            }
            s.multiplier = m;
        }
        if let Some(l) = loop_mode {
            if !["once", "loop", "pingpong"].contains(&l.as_str()) {
                return Err("loop must be once, loop or pingpong".into());
            }
            s.loop_mode = l;
        }
        if let Some(j) = jitter {
            if !(0.0..=100.0).contains(&j) {
                return Err("Jitter must be between 0 and 100 m".into());
            }
            s.jitter_m = j;
        }
        if let Some(t) = tick {
            if !(0.2..=10.0).contains(&t) {
                return Err("Update interval must be between 0.2 and 10 s".into());
            }
            s.tick_s = t;
        }
        Ok(())
    }

    pub async fn teleport(&self, lat: f64, lon: f64) -> Result<Value, String> {
        geo::validate_latlon(lat, lon)?;
        self.require_connected().await?;
        let prev = self.st.lock().unwrap().position.clone();
        self.stop().await;
        self.send(lat, lon, 0.0, 0.0, false).await?;
        let mut out = json!({"lat": lat, "lon": lon});
        if let Some(p) = prev {
            out["jump_m"] = json!((geo::haversine_m((p.lat, p.lon), (lat, lon)) * 10.0).round() / 10.0);
            out["seconds_since_last"] = json!(((now_s() - p.sent_at) * 10.0).round() / 10.0);
        }
        Ok(out)
    }

    pub async fn clear(&self) -> Result<(), String> {
        self.stop().await;
        self.require_connected().await?;
        self.devices.lock().await.clear_location().await?;
        self.st.lock().unwrap().position = None;
        Ok(())
    }

    pub async fn joystick(self: &Arc<Self>, moving: bool, bearing: Option<f64>, speed_kmh: Option<f64>) -> Result<(), String> {
        self.require_connected().await?;
        {
            let mut s = self.st.lock().unwrap();
            if s.position.is_none() {
                return Err("Set a starting location first (click the map and press Teleport)".into());
            }
            if let Some(b) = bearing {
                s.joy_bearing = b.rem_euclid(360.0);
            }
            if let Some(v) = speed_kmh {
                if !(v > 0.0 && v <= 1000.0) {
                    return Err("Joystick speed must be between 0 and 1000 km/h".into());
                }
                s.joy_speed_kmh = v;
            }
            s.joy_moving = moving;
            if s.state == "joystick" {
                return Ok(());
            }
        }
        self.cancel().await;
        self.st.lock().unwrap().state = "joystick".into();
        let me = self.clone();
        *self.task.lock().await = Some(tokio::spawn(async move { me.run_joystick().await }));
        Ok(())
    }

    async fn fail(&self, e: String) {
        let mut s = self.st.lock().unwrap();
        s.error = Some(e);
        s.state = "error".into();
    }

    async fn run_timeline(self: Arc<Self>) {
        let mut last = Instant::now();
        loop {
            let (p, dir, at_end, loop_mode, dur, tick) = {
                let s = self.st.lock().unwrap();
                let tl = s.timeline.clone().unwrap();
                let p = tl.at(s.t);
                let at_end = if s.direction > 0.0 { s.t >= tl.duration() } else { s.t <= 0.0 };
                (p, s.direction, at_end, s.loop_mode.clone(), tl.duration(), s.effective_tick())
            };
            let course = if dir > 0.0 { p.course } else { (p.course + 180.0) % 360.0 };
            if let Err(e) = self.send(p.lat, p.lon, p.speed_ms, course, true).await {
                self.fail(e).await;
                return;
            }
            if at_end {
                let mut s = self.st.lock().unwrap();
                if loop_mode == "once" || dur <= 0.0 {
                    s.state = "finished".into();
                    return;
                }
                s.laps += 1;
                if loop_mode == "loop" {
                    s.t = 0.0;
                } else {
                    s.direction = -s.direction;
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs_f64(tick)).await;
            let now = Instant::now();
            let mut s = self.st.lock().unwrap();
            let dt = (now - last).as_secs_f64() * s.multiplier;
            last = now;
            s.t = (s.t + dt * s.direction).clamp(0.0, dur);
        }
    }

    async fn run_joystick(self: Arc<Self>) {
        let mut last = Instant::now();
        loop {
            let tick = self.st.lock().unwrap().tick_s.min(0.5);
            tokio::time::sleep(std::time::Duration::from_secs_f64(tick)).await;
            let now = Instant::now();
            let dt = (now - last).as_secs_f64();
            last = now;
            let next = {
                let s = self.st.lock().unwrap();
                let Some(pos) = s.position.clone() else { continue };
                if s.joy_moving {
                    let (lat, lon) = geo::destination((pos.lat, pos.lon), s.joy_bearing, s.joy_speed_kmh / 3.6 * dt);
                    Some((lat, lon, s.joy_speed_kmh / 3.6, s.joy_bearing))
                } else if now_s() - pos.sent_at > 5.0 {
                    Some((pos.lat, pos.lon, 0.0, s.joy_bearing))
                } else {
                    None
                }
            };
            if let Some((lat, lon, v, b)) = next {
                if let Err(e) = self.send(lat, lon, v, b, false).await {
                    self.fail(e).await;
                    return;
                }
            }
        }
    }
}
