//! Location Spoofer — standalone desktop app.
//! Copyright (c) 2026 YK3D. All rights reserved. Licensed under the Location Spoofer License (LICENSE).
//!
//! A local HTTP server (axum) serves the UI and its JSON API on 127.0.0.1; a native window
//! (WebView2 on Windows) shows it. With `--no-window` (or without the `gui` feature) the system
//! browser is opened instead.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod device;
mod geo;
mod gmaps_links;
mod gpx;
mod player;
mod profile;
mod routing;
mod server;
mod store;
mod updater;

use std::net::SocketAddr;
use std::sync::Arc;

const DEFAULT_PORT: u16 = 8766;

struct Args {
    port: u16,
    no_window: bool,
    no_update: bool,
    self_test: bool,
    version: bool,
    wait_pid: Option<u32>,
    raw: Vec<String>,
}

fn parse_args() -> Args {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let mut a = Args { port: DEFAULT_PORT, no_window: false, no_update: false, self_test: false, version: false, wait_pid: None, raw: raw.clone() };
    let mut it = raw.iter();
    while let Some(x) = it.next() {
        match x.as_str() {
            "--port" => a.port = it.next().and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_PORT),
            "--no-window" => a.no_window = true,
            "--no-update" => a.no_update = true,
            "--self-test" => a.self_test = true,
            "--version" => a.version = true,
            "--wait-pid" => a.wait_pid = it.next().and_then(|v| v.parse().ok()),
            _ => {}
        }
    }
    a
}

fn wait_for_pid_exit(pid: u32) {
    // The old process frees the port and its file lock when it exits; give it up to 30 s.
    for _ in 0..150 {
        if std::net::TcpListener::bind(("127.0.0.1", DEFAULT_PORT)).is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let _ = pid;
}

fn main() {
    let args = parse_args();
    if args.version {
        println!("{}", updater::current_version());
        return;
    }
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,idevice=warn".into()))
        .init();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");

    if args.self_test {
        std::process::exit(rt.block_on(self_test()));
    }
    if let Some(pid) = args.wait_pid {
        wait_for_pid_exit(pid);
    }

    let update_enabled = cfg!(windows) && !cfg!(feature = "store") && !cfg!(debug_assertions) && !args.no_update;
    let upd = updater::Updater::new(update_enabled);
    if update_enabled {
        match upd.swap_in_staged() {
            Ok(true) => {
                upd.relaunch(args.raw.clone());
                return;
            }
            Ok(false) => {}
            Err(e) => tracing::warn!("update swap failed: {e}"),
        }
    }

    // Single instance: if our app already listens on the port, just open another window on it.
    let existing = format!("http://127.0.0.1:{}/", args.port);
    // A different version (for example an old copy still running in the background) is asked
    // to quit; if it can't, this copy runs on its own port instead of showing the old one.
    let bind = |port: u16| rt.block_on(tokio::net::TcpListener::bind(("127.0.0.1", port)));
    let (url, server_task) = match bind(args.port) {
        Ok(listener) => start_server(&rt, listener, upd),
        Err(_) => match rt.block_on(running_version(&existing)) {
            Some(v) if v == updater::current_version() => (existing, None),
            Some(_) => {
                rt.block_on(ask_to_quit(&existing));
                let mut listener = None;
                for _ in 0..25 {
                    if let Ok(l) = bind(args.port) {
                        listener = Some(l);
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                let listener = listener.unwrap_or_else(|| bind(0).expect("bind"));
                start_server(&rt, listener, upd)
            }
            None => start_server(&rt, bind(0).expect("bind"), upd),
        },
    };
    tracing::info!("Location Spoofer running at {url}");

    #[cfg(feature = "gui")]
    if !args.no_window {
        let restart = server_task.clone();
        gui::run(url, restart, args.raw.clone(), rt);
        return;
    }
    let _ = open::that(&url);
    println!("Location Spoofer is running at {url} — press Ctrl+C to quit.");
    rt.block_on(async {
        match server_task {
            Some(app) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = app.restart.notified() => {
                        app.updater.relaunch(args.raw.clone());
                    }
                }
            }
            None => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    });
}

fn start_server(rt: &tokio::runtime::Runtime, listener: tokio::net::TcpListener, upd: updater::Updater) -> (String, Option<server::App>) {
    let addr: SocketAddr = listener.local_addr().expect("addr");
    let app = server::AppState::new(store::Store::new(None), upd);
    let router = server::router(app.clone());
    let a2 = app.clone();
    rt.spawn(async move {
        if a2.updater.enabled {
            let u = a2.updater.clone();
            std::thread::spawn(move || u.cleanup_old());
            let a3 = a2.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                loop {
                    let channel = server::update_channel(&a3);
                    a3.updater.check(&channel).await;
                    tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
                }
            });
        }
        if let Err(e) = axum::serve(listener, router).await {
            tracing::error!("server stopped: {e}");
        }
    });
    (format!("http://{addr}/"), Some(app))
}

/// The version of the Location Spoofer already listening at `url`, if it is one.
async fn running_version(url: &str) -> Option<String> {
    let r = reqwest::Client::new().get(format!("{url}api/status")).timeout(std::time::Duration::from_secs(2)).send().await.ok()?;
    let v: serde_json::Value = r.json().await.ok()?;
    (v["app"] == "standalone").then(|| v["version"].as_str().unwrap_or("").to_string())
}

async fn ask_to_quit(url: &str) {
    let _ = reqwest::Client::new().post(format!("{url}api/app/quit")).timeout(std::time::Duration::from_secs(2)).send().await;
}

/// Exercise the build end to end without a phone; CI refuses to publish a build that fails.
async fn self_test() -> i32 {
    let mut checks: Vec<(&str, bool)> = Vec::new();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let addr = listener.local_addr().unwrap();
    let tmp = std::env::temp_dir().join(format!("spoofer-selftest-{}", std::process::id()));
    let app = server::AppState::new(store::Store::new(Some(tmp.join("data.json"))), updater::Updater::new(false));
    tokio::spawn(async move { axum::serve(listener, server::router(app)).await.ok() });
    let base = format!("http://{addr}");
    let c = reqwest::Client::new();
    let get = |p: &str| c.get(format!("{base}{p}")).send();
    checks.push(("UI files", matches!(get("/").await, Ok(r) if r.status().is_success()) && matches!(get("/static/app.js").await, Ok(r) if r.status().is_success())));
    checks.push(("status API", matches!(get("/api/status").await, Ok(r) if r.status().is_success())));
    let route = serde_json::json!({"waypoints": [{"lat": 51.5, "lon": -0.12}, {"lat": 51.505, "lon": -0.12}],
        "legs": [{"mode": "straight", "cruise_kmh": 20}], "settings": {"corner_slowdown": true}});
    let built = c.post(format!("{base}/api/route/build")).json(&route).send().await;
    let tid = match built {
        Ok(r) if r.status().is_success() => r.json::<serde_json::Value>().await.ok().and_then(|v| v["id"].as_str().map(String::from)),
        _ => None,
    };
    checks.push(("route build", tid.is_some()));
    let sim = c.post(format!("{base}/api/connect")).json(&serde_json::json!({"driver": "mock"})).send().await;
    checks.push(("simulator connect", matches!(sim, Ok(r) if r.status().is_success())));
    if let Some(t) = &tid {
        let ok = c.post(format!("{base}/api/player/load/{t}")).send().await.map(|r| r.status().is_success()).unwrap_or(false);
        checks.push(("player load", ok));
    }
    checks.push(("sea network", routing::sea_route((49.49, 0.10), (50.9, 1.8)).map(|r| r.len() > 2).unwrap_or(false)));
    checks.push(("Google link parser", gmaps_links::parse("https://www.google.com/maps/@40.7,-74.0,15z").is_ok()));
    let ok = checks.iter().all(|c| c.1);
    println!("Location Spoofer (standalone) {} self-test", updater::current_version());
    for (n, v) in &checks {
        println!("  {} {n}", if *v { "OK  " } else { "FAIL" });
    }
    let _ = std::fs::remove_dir_all(tmp);
    if ok { 0 } else { 1 }
}

#[cfg(feature = "gui")]
mod gui {
    use std::sync::Arc;
    use tao::{
        dpi::LogicalSize,
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoopBuilder},
        window::WindowBuilder,
    };
    use wry::WebViewBuilder;

    enum UserEvent {
        Restart,
        /// The page has painted (or the fallback timer ran out): show the window.
        Show,
    }

    /// Colour of the native window and the webview until the page paints: the Graphite theme's
    /// background, so there is no white flash at start-up.
    const BACKGROUND: (u8, u8, u8, u8) = (0x17, 0x19, 0x1c, 0xff);
    /// Show the window anyway if the page never says it is ready (for example a script error).
    const SHOW_FALLBACK: std::time::Duration = std::time::Duration::from_secs(5);

    fn window_icon() -> Option<tao::window::Icon> {
        let png = include_bytes!("../../assets/icon/icon-64.png");
        let decoder = png::Decoder::new(std::io::Cursor::new(&png[..]));
        let mut reader = decoder.read_info().ok()?;
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).ok()?;
        if info.color_type != png::ColorType::Rgba {
            return None;
        }
        tao::window::Icon::from_rgba(buf[..info.buffer_size()].to_vec(), info.width, info.height).ok()
    }

    /// "My real location" asks WebView2 for this computer's position (with high accuracy). Requests
    /// from the app's own page are allowed here, so the only prompt is Windows' own location
    /// permission (Settings › Privacy & security › Location), which decides whether apps get a
    /// precise fix. Anything else asking for location is refused.
    #[cfg(windows)]
    fn allow_own_geolocation(webview: &wry::WebView, base: &str) {
        use webview2_com::{Microsoft::Web::WebView2::Win32::*, PermissionRequestedEventHandler};
        use wry::WebViewExtWindows;
        let base = base.to_string();
        let handler = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            unsafe { args.PermissionKind(&mut kind)? };
            if kind != COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION {
                return Ok(());
            }
            let mut uri = windows_core::PWSTR::null();
            unsafe { args.Uri(&mut uri)? };
            let uri = webview2_com::take_pwstr(uri);
            let state = if uri.starts_with(&base) { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY };
            unsafe { args.SetState(state) }
        }));
        let mut token = 0i64;
        if let Err(e) = unsafe { webview.webview().add_PermissionRequested(&handler, &mut token) } {
            tracing::warn!("could not set up the location permission handler: {e}");
        }
    }

    pub fn run(url: String, app: Option<crate::server::App>, raw_args: Vec<String>, rt: tokio::runtime::Runtime) {
        let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
        let proxy = event_loop.create_proxy();
        if let Some(app) = app.clone() {
            let proxy = proxy.clone();
            rt.spawn(async move {
                app.restart.notified().await;
                let _ = proxy.send_event(UserEvent::Restart);
            });
        }
        // Hidden until the page has loaded and painted with its theme (the page posts "ready").
        let window = WindowBuilder::new()
            .with_title("Location Spoofer")
            .with_window_icon(window_icon())
            .with_inner_size(LogicalSize::new(1280.0, 820.0))
            .with_min_inner_size(LogicalSize::new(720.0, 520.0))
            .with_visible(false)
            .with_background_color(BACKGROUND)
            .build(&event_loop)
            .expect("window");
        let fallback = proxy.clone();
        std::thread::spawn(move || {
            std::thread::sleep(SHOW_FALLBACK);
            let _ = fallback.send_event(UserEvent::Show);
        });
        let ready = proxy.clone();
        let downloads = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
        let base = url.clone();
        let builder = WebViewBuilder::new()
            .with_url(&url)
            .with_background_color(BACKGROUND)
            .with_ipc_handler(move |req| {
                if req.body() == "ready" {
                    let _ = ready.send_event(UserEvent::Show);
                }
            })
            // Links to the terms, privacy policy, GitHub etc. open in the system browser.
            .with_new_window_req_handler(|u, _features| {
                if u.starts_with("https://") || u.starts_with("http://") {
                    let _ = open::that(&u);
                }
                wry::NewWindowResponse::Deny
            })
            .with_navigation_handler(move |u| {
                if u.starts_with(&base) || u.starts_with("about:") || u.starts_with("data:") || u.starts_with("blob:") {
                    true
                } else {
                    let _ = open::that(&u);
                    false
                }
            })
            .with_download_started_handler(move |_url, path| {
                // Save exported GPX files to the Downloads folder.
                let name = path.file_name().map(|n| n.to_owned()).unwrap_or_else(|| "route.gpx".into());
                *path = downloads.join(name);
                true
            });
        #[cfg(any(windows, target_os = "macos"))]
        let webview = builder.build(&window).expect("webview");
        #[cfg(windows)]
        allow_own_geolocation(&webview, &url);
        #[cfg(not(any(windows, target_os = "macos")))]
        let webview = {
            use tao::platform::unix::WindowExtUnix;
            use wry::WebViewBuilderExtUnix;
            builder.build_gtk(window.default_vbox().expect("gtk vbox")).expect("webview")
        };
        let rt = Arc::new(rt);
        let mut shown = false;
        event_loop.run(move |event, _, control_flow| {
            *control_flow = ControlFlow::Wait;
            let _keep = (&webview, &rt);
            match event {
                Event::UserEvent(UserEvent::Show) => {
                    if !shown {
                        shown = true;
                        window.set_visible(true);
                        window.set_focus();
                    }
                }
                // Exit right away: waiting for background work to wind down could leave an
                // invisible process holding the port.
                Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                    *control_flow = ControlFlow::Exit;
                    std::process::exit(0);
                }
                Event::UserEvent(UserEvent::Restart) => {
                    if let Some(app) = &app {
                        app.updater.relaunch(raw_args.clone());
                    }
                    *control_flow = ControlFlow::Exit;
                    std::process::exit(0);
                }
                _ => {}
            }
        });
    }
}

#[allow(dead_code)]
fn _assert_send(app: server::App) -> Arc<server::AppState> {
    app
}
