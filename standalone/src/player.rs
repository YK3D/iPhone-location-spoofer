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
    pub state: String, // idle | playing | paused | held | finished | joystick | error
    pub t: f64,
    pub direction: f64,
    pub multiplier: f64,
    pub loop_mode: String,
    pub jitter_m: f64,
    pub tick_s: f64,
    /// one-way trips completed (a round trip in back-and-forth mode is two)
    pub laps: u32,
    /// laps to drive in loop / back-and-forth mode; 0 = no limit
    pub lap_limit: u32,
    /// waypoint index while stopped at a "hold until Continue" checkpoint
    pub held_at: Option<usize>,
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
            lap_limit: 0,
            held_at: None,
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
    /// The lap being driven, from 1 (a round trip counts once in back-and-forth mode).
    fn current_lap(&self) -> u32 {
        if self.loop_mode == "pingpong" { self.laps / 2 + 1 } else { self.laps + 1 }
    }
    fn laps_done(&self) -> bool {
        if self.lap_limit == 0 || self.loop_mode == "once" {
            return false;
        }
        self.laps >= if self.loop_mode == "pingpong" { 2 * self.lap_limit } else { self.lap_limit }
    }
    fn hold(&mut self, h: (f64, usize)) {
        self.t = h.0;
        self.held_at = Some(h.1);
        self.state = "held".into();
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
        let holds = s.timeline.as_ref().map(|tl| tl.holds_json()).unwrap_or_default();
        json!({
            "state": s.state, "t": (s.t * 100.0).round() / 100.0, "duration": (dur * 100.0).round() / 100.0,
            "distance_m": (dist * 10.0).round() / 10.0, "total_distance_m": (total * 10.0).round() / 10.0,
            "name": s.name, "multiplier": s.multiplier, "loop": s.loop_mode, "jitter_m": s.jitter_m,
            "tick_s": s.tick_s, "laps": s.laps, "lap": s.current_lap(), "lap_limit": s.lap_limit,
            "held_at": s.held_at, "holds": holds, "direction": s.direction,
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
        s.held_at = None;
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
            // A finished route plays again from the start; leaving a hold on the last checkpoint
            // carries on with the end of the route (next lap or finish) instead.
            if s.state == "finished" || (s.state != "held" && s.t >= dur && s.direction > 0.0) {
                s.t = 0.0;
                s.direction = 1.0;
                s.laps = 0;
            }
            s.held_at = None;
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
        let st = self.st.lock().unwrap().state.clone();
        if st == "paused" || st == "held" {
            self.play().await
        } else {
            Ok(())
        }
    }

    /// Leave a "hold until Continue" checkpoint.
    pub async fn continue_(self: &Arc<Self>) -> Result<(), String> {
        if self.st.lock().unwrap().state == "held" {
            self.play().await
        } else {
            Ok(())
        }
    }

    pub async fn stop(&self) {
        self.cancel().await;
        let mut s = self.st.lock().unwrap();
        if ["playing", "paused", "held", "joystick", "finished"].contains(&s.state.as_str()) {
            s.state = "idle".into();
        }
        s.held_at = None;
        s.joy_moving = false;
    }

    /// Forget the loaded route (e.g. after the user cleared it).
    pub async fn unload(&self) {
        self.stop().await;
        let mut s = self.st.lock().unwrap();
        s.timeline = None;
        s.name.clear();
        s.t = 0.0;
        s.direction = 1.0;
        s.laps = 0;
        s.held_at = None;
        if s.state != "joystick" {
            s.state = "idle".into();
        }
    }

    pub async fn seek(&self, t: f64) -> Result<(), String> {
        let (p, playing) = {
            let mut s = self.st.lock().unwrap();
            let Some(tl) = s.timeline.clone() else { return Ok(()) };
            s.t = t.clamp(0.0, tl.duration());
            let p = tl.at(s.t);
            s.position = Some(Position::new(p.lat, p.lon, p.speed_ms, p.course));
            if s.state == "held" {
                // moving away from a hold releases it
                s.held_at = None;
                s.state = "paused".into();
            }
            (p, s.state == "playing")
        };
        if !playing && self.devices.lock().await.connected() {
            self.send(p.lat, p.lon, p.speed_ms, p.course, false).await?;
        }
        Ok(())
    }

    pub fn set_options(&self, multiplier: Option<f64>, loop_mode: Option<String>, jitter: Option<f64>, tick: Option<f64>, lap_limit: Option<i64>) -> Result<(), String> {
        let mut s = self.st.lock().unwrap();
        if let Some(l) = lap_limit {
            if !(0..=100_000).contains(&l) {
                return Err("Laps must be between 0 (no limit) and 100000".into());
            }
            s.lap_limit = l as u32;
        }
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
            let (p, dir, at_end, loop_mode, dur, tick, held) = {
                let s = self.st.lock().unwrap();
                let tl = s.timeline.clone().unwrap();
                let p = tl.at(s.t);
                let at_end = if s.direction > 0.0 { s.t >= tl.duration() } else { s.t <= 0.0 };
                (p, s.direction, at_end, s.loop_mode.clone(), tl.duration(), s.effective_tick(), s.state == "held")
            };
            let course = if dir > 0.0 { p.course } else { (p.course + 180.0) % 360.0 };
            if let Err(e) = self.send(p.lat, p.lon, p.speed_ms, course, true).await {
                self.fail(e).await;
                return;
            }
            if held {
                return; // the device waits at the checkpoint until Continue
            }
            if at_end {
                let mut s = self.st.lock().unwrap();
                if loop_mode == "once" || dur <= 0.0 {
                    s.state = "finished".into();
                    return;
                }
                s.laps += 1;
                if s.laps_done() {
                    s.state = "finished".into();
                    return;
                }
                if loop_mode == "loop" {
                    s.t = 0.0;
                    let first = s.timeline.as_ref().and_then(|tl| tl.holds.first().copied()).filter(|h| h.0 <= 1e-9);
                    if let Some(h) = first {
                        s.hold(h); // a new lap starts at a hold on the first checkpoint
                        continue;
                    }
                } else {
                    s.direction = -s.direction;
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs_f64(tick)).await;
            let now = Instant::now();
            let mut s = self.st.lock().unwrap();
            let dt = (now - last).as_secs_f64() * s.multiplier;
            last = now;
            let new_t = (s.t + dt * s.direction).clamp(0.0, dur);
            let forward = s.direction > 0.0;
            let hold = s.timeline.as_ref().and_then(|tl| tl.next_hold(s.t, forward));
            match hold {
                // stop exactly on the checkpoint, not past it
                Some(h) if (forward && h.0 <= new_t + 1e-9) || (!forward && h.0 >= new_t - 1e-9) => s.hold(h),
                _ => s.t = new_t,
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::{DeviceManager, DriverKind};
    use crate::profile::{build_timeline, Leg, ProfileSettings, Waypoint};

    const A: (f64, f64) = (51.5, -0.12);

    fn corner(hold_at: Option<usize>) -> (Arc<Timeline>, (f64, f64), (f64, f64)) {
        let b = geo::destination(A, 90.0, 200.0);
        let c = geo::destination(b, 0.0, 200.0);
        let mut w = vec![Waypoint::at(A), Waypoint::at(b), Waypoint::at(c)];
        if let Some(i) = hold_at {
            w[i].hold = true;
        }
        let s = ProfileSettings { default_cruise_kmh: 36.0, accel_ms2: 2.0, decel_ms2: 2.0, ..Default::default() };
        (Arc::new(build_timeline(&w, &[Leg::new(vec![A, b]), Leg::new(vec![b, c])], &s).unwrap()), b, c)
    }

    async fn player() -> (Arc<Player>, Devices) {
        let devices: Devices = Arc::new(AsyncMutex::new(DeviceManager::default()));
        devices.lock().await.connect(DriverKind::Mock, None).await.unwrap();
        (Arc::new(Player::new(devices.clone())), devices)
    }

    async fn wait_for(p: &Player, state: &str) -> bool {
        for _ in 0..400 {
            if p.st.lock().unwrap().state == state {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        false
    }

    #[tokio::test]
    async fn waits_at_a_hold_until_continue() {
        let (tl, b, c) = corner(Some(1));
        let (p, devices) = player().await;
        p.load(tl.clone(), "hold".into()).await;
        p.set_options(Some(100.0), None, None, Some(0.2), None).unwrap();
        p.play().await.unwrap();
        assert!(wait_for(&p, "held").await);
        let st = p.status();
        assert_eq!(st["held_at"], 1);
        assert!((st["t"].as_f64().unwrap() - tl.holds[0].0).abs() < 0.01);
        let here = devices.lock().await.mock.location.unwrap();
        assert!(geo::haversine_m(here, b) < 0.05, "stopped on the checkpoint");
        let sent = devices.lock().await.mock.history.len();
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        assert_eq!(devices.lock().await.mock.history.len(), sent, "nothing moves while held");
        p.continue_().await.unwrap();
        assert!(wait_for(&p, "finished").await);
        assert!(geo::haversine_m(devices.lock().await.mock.location.unwrap(), c) < 0.05);
    }

    #[tokio::test]
    async fn lap_limit_stops_loops() {
        let (tl, _, _) = corner(None);
        let (p, devices) = player().await;
        p.load(tl, "laps".into()).await;
        p.set_options(Some(100.0), Some("loop".into()), None, Some(0.2), Some(2)).unwrap();
        p.play().await.unwrap();
        assert!(wait_for(&p, "finished").await);
        assert_eq!(p.st.lock().unwrap().laps, 2);
        p.set_options(None, Some("pingpong".into()), None, None, Some(1)).unwrap();
        p.play().await.unwrap();
        assert!(wait_for(&p, "finished").await);
        assert_eq!(p.st.lock().unwrap().laps, 2); // there and back
        assert!(geo::haversine_m(devices.lock().await.mock.location.unwrap(), A) < 0.05);
        assert!(p.set_options(None, None, None, None, Some(-1)).is_err());
        assert_eq!(p.status()["lap_limit"], 1);
    }

    #[tokio::test]
    async fn seeking_away_releases_a_hold() {
        let (tl, _, _) = corner(Some(1));
        let (p, _) = player().await;
        p.load(tl, "seek".into()).await;
        p.set_options(Some(100.0), None, None, Some(0.2), None).unwrap();
        p.play().await.unwrap();
        assert!(wait_for(&p, "held").await);
        p.seek(1.0).await.unwrap();
        let s = p.st.lock().unwrap();
        assert_eq!((s.state.as_str(), s.held_at), ("paused", None));
    }
}
