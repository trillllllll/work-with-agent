#[macro_use]
mod i18n;

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalSize, Manager, RunEvent, Url, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_window_state::StateFlags;

const DESKTOP_PORT: u16 = 47316;
static DATA_PREPARED: Mutex<bool> = Mutex::new(false);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct ServerProcess(Mutex<Option<Child>>);
/// The local executor (dovun-node) this app runs in the background once the user paired it.
struct NodeProcess(Mutex<Option<Child>>);
/// Cleared on exit or unpair so the watcher does not restart the executor.
static NODE_WANTED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherConfig {
    mode: String,
    #[serde(default)]
    remote_url: String,
}

impl LauncherConfig {
    fn local() -> Self {
        Self { mode: "local".to_string(), remote_url: String::new() }
    }
}

/// Set once the remote workspace page signals it loaded a Dovun client.
static LAUNCH_CONFIRMED: AtomicBool = AtomicBool::new(false);
/// The bundled splash page URL, captured before the window navigates anywhere else.
static SPLASH_URL: OnceLock<Url> = OnceLock::new();

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            // The workspace client redirects to these sentinel paths to talk to the shell
            // from either origin; both navigations are cancelled and handled here.
            tauri::plugin::Builder::<tauri::Wry, ()>::new("dovun-navigation")
                .on_navigation(|webview, url| {
                    let path = url.path().trim_end_matches('/');
                    if path == "/dovun-launcher-done" {
                        LAUNCH_CONFIRMED.store(true, Ordering::SeqCst);
                        return false;
                    }
                    if path == "/dovun-launcher" {
                        open_launcher(webview.app_handle());
                        return false;
                    }
                    // Sentinels used by the workspace (local or remote origin); none of them reaches a server.
                    if path == "/dovun-notify" {
                        let title = query_value(url, "title").unwrap_or_default();
                        let body = query_value(url, "body").unwrap_or_default();
                        notify(webview.app_handle(), &title, &body);
                        return false;
                    }
                    if path == "/dovun-node-status" {
                        let script = desktop_event_script(&node_status_detail(webview.app_handle()));
                        let _ = webview.eval(script);
                        return false;
                    }
                    if path == "/dovun-node-pair" {
                        let server = query_value(url, "server").unwrap_or_default();
                        let token = query_value(url, "token").unwrap_or_default();
                        let node = query_value(url, "node").unwrap_or_default();
                        pair_node(webview.app_handle(), server, token, node);
                        return false;
                    }
                    if path == "/dovun-node-unpair" {
                        let node = query_value(url, "node").unwrap_or_default();
                        unpair_node(webview.app_handle(), node);
                        return false;
                    }
                    true
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ServerProcess(Mutex::new(None)))
        .manage(NodeProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![launcher_config_get, launcher_config_set, launcher_retry, desktop_notify])
        .setup(|app| {
            // No WebView exists yet: restore storage before its first origin is opened.
            if let Err(message) = prepare_browser_profile(app.handle()) {
                let handle = app.handle().clone();
                app.dialog().message(&message).title("Dovun · Restore local state").show(move |_| handle.exit(1));
                return Ok(());
            }
            // Its exit hook writes state even without windows; register only after restoration.
            app.handle().plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::DECORATIONS | StateFlags::FULLSCREEN)
                    .build(),
            )?;
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?.build()?;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_min_size(Some(LogicalSize::new(578.0, 640.0)));
                let _ = window.show();
                let _ = SPLASH_URL.set(window.url().unwrap_or_else(|_| "index.html".parse().expect("splash url")));
                let window_for_close = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_for_close.hide();
                    }
                });
            }
            let handle = app.handle().clone();
            thread::spawn(move || {
                if let Err(message) = launch(&handle) {
                    show_message(&handle, message);
                    return;
                }
                // Independent of the workspace mode: a paired executor always comes up with the app.
                start_node_agent(&handle);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| panic!("{}: {error}", tr!("启动 Dovun 失败", "Failed to start Dovun")))
        .run(|app, event| match event {
            RunEvent::Exit => {
                stop_node_agent(app);
                stop_server(app);
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}

fn launch(app: &AppHandle) -> Result<(), String> {
    prepare_data(app)?;
    let data = data_dir()?;
    match read_launcher_config(&data) {
        // First run without a choice yet: the splash page shows the mode picker on its own.
        None => Ok(()),
        Some(config) if config.mode == "remote" && !config.remote_url.is_empty() => launch_remote(app, &config.remote_url),
        _ => launch_local(app, &data),
    }
}

fn launch_local(app: &AppHandle, data: &Path) -> Result<(), String> {
    if let Some(message) = port_busy_message(probe_port(DESKTOP_PORT), DESKTOP_PORT) {
        return Err(message);
    }
    let (node, server, client) = bundled_paths(app)?;
    for directory in ["knowledge-blobs", "runner", "workspace", "logs", "bin"] {
        fs::create_dir_all(data.join(directory)).map_err(|error| tr!("无法创建数据目录：{error}", "Could not create the data folder: {error}"))?;
    }
    let log = data.join("logs/server.log");
    let mut command = Command::new(&node);
    command
        .arg(server.join("dist/index.js"))
        .current_dir(&server)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("DOVUN_PACKAGED", "1")
        .env("PORT", DESKTOP_PORT.to_string())
        .env("CLIENT_ORIGIN", format!("http://127.0.0.1:{DESKTOP_PORT}"))
        .env("DOVUN_DATA_DIR", data)
        .env("DATABASE_URL", format!("file:{}", database_file(data)?.display()))
        .env("KNOWLEDGE_STORAGE_ROOT", data.join("knowledge-blobs"))
        .env("DOVUN_RUNNER_DIR", data.join("runner"))
        .env("AGENT_WORKSPACE_ROOT", data.join("workspace"))
        .env("DOVUN_STATIC_DIR", &client)
        .env_remove("NODE_OPTIONS");
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|error| tr!("无法启动本机服务：{error}", "Could not start the local service: {error}"))?;
    let stdout = child.stdout.take().ok_or_else(|| tr!("无法读取服务输出", "Could not read the service output"))?;
    let stderr = child.stderr.take().ok_or_else(|| tr!("无法读取服务错误输出", "Could not read the service error output"))?;
    app.state::<ServerProcess>().0.lock().expect("server lock").replace(child);
    watch_restart_codes(app);
    let recent = Arc::new(Mutex::new(String::new()));
    let logged = recent.clone();
    let error_log = log.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            *logged.lock().expect("stderr lock") = line.clone();
            append_log(&error_log, &line);
        }
    });
    let (sender, receiver) = mpsc::channel();
    let output_log = log.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if line.contains("Open workspace:") {
                let _ = sender.send(line);
            } else {
                append_log(&output_log, &line);
            }
        }
    });
    let line = receiver.recv_timeout(Duration::from_secs(60)).map_err(|_| {
        let detail = recent.lock().expect("stderr lock").clone();
        let status = app.state::<ServerProcess>().0.lock().expect("server lock").as_mut().and_then(|child| child.try_wait().ok().flatten());
        match status {
            Some(status) => tr!("本机服务已退出（{status}）。{detail}", "The local service exited ({status}). {detail}"),
            None => tr!("本机服务没有在 60 秒内完成启动。{detail}", "The local service did not finish starting within 60 seconds. {detail}"),
        }
    })?;
    println!("{line}");
    let url = line.trim().trim_start_matches("Open workspace: ").trim().to_string();
    open_workspace(app, url);
    Ok(())
}

fn launch_remote(app: &AppHandle, remote_url: &str) -> Result<(), String> {
    let url = remote_url.trim_end_matches('/');
    probe_remote(url)?;
    LAUNCH_CONFIRMED.store(false, Ordering::SeqCst);
    open_workspace(app, format!("{url}/?launcher=1"));
    // The remote page confirms itself by redirecting to /dovun-launcher-done, which
    // on_navigation cancels. If nothing confirms in time, the address probably is
    // not a Dovun server.
    let handle = app.clone();
    let address = url.to_string();
    thread::spawn(move || {
        for _ in 0..30 {
            if LAUNCH_CONFIRMED.load(Ordering::SeqCst) { return; }
            thread::sleep(Duration::from_secs(1));
        }
        if LAUNCH_CONFIRMED.load(Ordering::SeqCst) { return; }
        show_launch_error(&handle, tr!("{address} 没有在 30 秒内打开 Dovun 工作区。请核对这是否为正确的服务器地址。", "{address} did not open a Dovun workspace within 30 seconds. Check that this is the right server address."));
    });
    Ok(())
}

/// Checks the remote workspace is reachable at the TCP level before navigating.
fn probe_remote(remote_url: &str) -> Result<(), String> {
    let parsed = remote_url.parse::<Url>().map_err(|_| tr!("远程服务器地址无效：{remote_url}", "Invalid remote server address: {remote_url}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(tr!("远程服务器地址必须以 http:// 或 https:// 开头：{remote_url}", "The remote server address must start with http:// or https://: {remote_url}"));
    }
    let port = parsed.port_or_known_default().ok_or_else(|| tr!("无法确定远程服务器端口", "Could not determine the remote server port"))?;
    let address = format!("{}:{}", parsed.host_str().ok_or_else(|| tr!("远程服务器地址缺少主机名", "The remote server address has no host name"))?, port);
    let socket = address.to_socket_addrs().map_err(|error| tr!("无法解析远程服务器地址 {address}：{error}", "Could not resolve the remote server address {address}: {error}"))?
        .next().ok_or_else(|| tr!("无法解析远程服务器地址 {address}", "Could not resolve the remote server address {address}"))?;
    TcpStream::connect_timeout(&socket, Duration::from_secs(8)).map_err(|error| tr!("无法连接远程服务器 {address}：{error}", "Could not connect to the remote server {address}: {error}"))?;
    Ok(())
}

fn launcher_config_path(data: &Path) -> PathBuf {
    data.join("launcher.json")
}

fn read_launcher_config(data: &Path) -> Option<LauncherConfig> {
    let text = fs::read_to_string(launcher_config_path(data)).ok()?;
    let config: LauncherConfig = serde_json::from_str(&text).ok()?;
    (config.mode == "local" || config.mode == "remote").then_some(config)
}

fn write_launcher_config(data: &Path, config: &LauncherConfig) -> Result<(), String> {
    fs::create_dir_all(data).map_err(|error| tr!("无法创建数据目录：{error}", "Could not create the data folder: {error}"))?;
    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(launcher_config_path(data), text).map_err(|error| tr!("无法保存启动配置：{error}", "Could not save the launcher settings: {error}"))
}

#[tauri::command]
fn launcher_config_get(app: AppHandle) -> Result<Option<LauncherConfig>, String> {
    prepare_data(&app)?;
    Ok(read_launcher_config(&data_dir()?))
}

#[tauri::command]
fn launcher_config_set(app: AppHandle, mode: String, remote_url: String) -> Result<(), String> {
    prepare_data(&app)?;
    if mode != "local" && mode != "remote" { return Err(tr!("未知启动模式", "Unknown launch mode")); }
    let remote_url = remote_url.trim().trim_end_matches('/').to_string();
    if mode == "remote" { probe_remote(&remote_url)?; }
    let config = if mode == "remote" { LauncherConfig { mode, remote_url } } else { LauncherConfig::local() };
    write_launcher_config(&data_dir()?, &config)
}

#[tauri::command]
fn launcher_retry(app: AppHandle) -> Result<(), String> {
    stop_server(&app);
    let handle = app.clone();
    thread::spawn(move || {
        if let Err(message) = launch(&handle) {
            show_message(&handle, message);
            return;
        }
        start_node_agent(&handle);
    });
    Ok(())
}

/// Returns the window to the bundled splash page with the mode picker open.
fn open_launcher(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let mut target = SPLASH_URL.get().cloned().unwrap_or_else(|| "index.html".parse().expect("splash url"));
    target.set_query(Some("switch=1"));
    let _ = window.navigate(target);
    let _ = window.show();
}

/// A snapshot import restarts the server with exit code 75; bring it straight
/// back up so the workspace reconnects without an app restart.
fn watch_restart_codes(app: &AppHandle) {
    let handle = app.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(500));
        let Some(state) = handle.try_state::<ServerProcess>() else { return };
        let status = {
            let mut guard = state.0.lock().expect("server lock");
            match guard.as_mut() {
                Some(child) => child.try_wait().ok().flatten(),
                None => return,
            }
        };
        let Some(status) = status else { continue };
        if status.code() != Some(75) { return; }
        handle.state::<ServerProcess>().0.lock().expect("server lock").take();
        match data_dir() {
            Ok(data) => {
                if let Err(message) = launch_local(&handle, &data) {
                    show_message(&handle, message);
                }
            }
            Err(message) => show_message(&handle, message),
        }
        return;
    });
}

fn obsolete_data_override(current: Option<std::ffi::OsString>, legacy: Option<std::ffi::OsString>) -> Result<(), String> {
    if current.filter(|value| !value.is_empty()).is_none() && legacy.is_some_and(|value| !value.is_empty()) {
        return Err("Old WWA_DATA_DIR configuration detected. Stop the old workspace, back up or migrate that custom folder, and set DOVUN_DATA_DIR before starting. No empty workspace was created.".into());
    }
    Ok(())
}

fn prepare_browser_profile(app: &AppHandle) -> Result<(), String> {
    obsolete_data_override(std::env::var_os("DOVUN_DATA_DIR"), std::env::var_os("WWA_DATA_DIR"))?;
    let (node, server, _) = bundled_paths(app)?;
    let mut command = Command::new(node);
    command.arg(server.join("dist/profile-migrate.js")).arg(std::process::id().to_string());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    Ok(())
}

fn bundled_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let root = app.path().resource_dir().map_err(|error| error.to_string())?;
    let node = existing(&root, &["node.exe", "resources/node.exe", "node", "resources/node"]).ok_or_else(|| tr!("安装包里没有 Node。查找目录：{}", "Node is missing from the installation. Searched: {}", root.display()))?;
    let server_entry = existing(&root, &["server/dist/index.js", "resources/server/dist/index.js"]).ok_or_else(|| tr!("安装包里没有服务。查找目录：{}", "The service is missing from the installation. Searched: {}", root.display()))?;
    let client_entry = existing(&root, &["client/index.html", "resources/client/index.html"]).ok_or_else(|| tr!("安装包里没有界面。查找目录：{}", "The interface is missing from the installation. Searched: {}", root.display()))?;
    let server = server_entry.parent().and_then(Path::parent).ok_or_else(|| tr!("无法定位服务目录", "Could not locate the service folder"))?.to_path_buf();
    let client = client_entry.parent().ok_or_else(|| tr!("无法定位界面目录", "Could not locate the interface folder"))?.to_path_buf();
    Ok((node, server, client))
}

fn existing(root: &Path, relatives: &[&str]) -> Option<PathBuf> {
    relatives.iter().map(|relative| root.join(relative)).find(|path| path.exists())
}

fn data_dir() -> Result<PathBuf, String> {
    if let Some(value) = data_override() {
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }

    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("APPDATA"))
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or_else(|| tr!("找不到用户数据目录", "Could not find the user data folder"))?;
        return Ok(PathBuf::from(base).join("dovun"));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").map_err(|_| tr!("找不到用户主目录", "Could not find the home folder"))?;
        return Ok(PathBuf::from(home).join("Library/Application Support/dovun"));
    }
}

fn environment(suffix: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(format!("DOVUN_{suffix}"))
}
fn database_file(data: &Path) -> Result<PathBuf, String> {
    let current = data.join("dovun.db"); let old = data.join("agent-studio.db");
    if current.exists() && old.exists() { return Err("Both database names exist. Choose the source after backing up both files.".into()); }
    if old.exists() { return Err("Old database found. Run the offline data migration before starting the workspace.".into()); }
    Ok(current)
}
fn prepare_data(app: &AppHandle) -> Result<(), String> {
    prepare_once(&DATA_PREPARED, || {
        prepare_data_and_launchers(app)
    })
}

fn prepare_data_and_launchers(app: &AppHandle) -> Result<(), String> {
    migrate_default_data(app)?;
    #[cfg(unix)]
    {
        let data = data_dir()?;
        let (node, server, _) = bundled_paths(app)?;
        write_mcp_launcher(&data, &node, &server.join("dist/mcp/index.js"))?;
    }
    Ok(())
}

fn migrate_default_data(app: &AppHandle) -> Result<(), String> {
    if data_override().is_some() { return Ok(()); }
    let target = data_dir()?;
    let source = target.parent().ok_or("Cannot locate data parent")?.join("work-with-agent");
    if !source.exists() { return Ok(()); }
    if let Some(message) = port_busy_message(probe_port(DESKTOP_PORT), DESKTOP_PORT) { return Err(message); }
    let (node, server, _) = bundled_paths(app)?;
    let mut command = Command::new(node);
    command.arg(server.join("dist/desktop-migrate.js")).arg(source).arg(target);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    Ok(())
}

fn prepare_once(state: &Mutex<bool>, action: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let mut ready = state.lock().map_err(|_| "Data preparation was interrupted")?;
    if *ready { return Ok(()); }
    action()?;
    *ready = true;
    Ok(())
}

fn data_override() -> Option<std::ffi::OsString> { environment("DATA_DIR").filter(|value| !value.is_empty()) }

#[cfg(unix)]
fn write_mcp_launcher(data: &Path, node: &Path, entry: &Path) -> Result<(), String> {
    fs::create_dir_all(data.join("bin")).map_err(|error| error.to_string())?;
    let script = data.join("bin/dovun-mcp");
    let body = format!("#!/bin/bash\nexec {} {} \"$@\"\n", shell_quote(node), shell_quote(entry));
    fs::write(&script, &body).map_err(|error| tr!("无法写入 MCP 启动脚本：{error}", "Could not write the MCP launcher script: {error}"))?;
    let mut permissions = fs::metadata(&script).map_err(|error| error.to_string())?.permissions();
    use std::os::unix::fs::PermissionsExt;
    permissions.set_mode(0o755);
    fs::set_permissions(&script, permissions).map_err(|error| error.to_string())?;
    // The old source and verified backups remain intact; retire only this managed target alias.
    let legacy = data.join("bin/wwa-mcp");
    if legacy.exists() { fs::remove_file(legacy).map_err(|error| error.to_string())?; }
    Ok(())
}

#[cfg(unix)]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

fn open_workspace(app: &AppHandle, url: String) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.set_min_size(Some(LogicalSize::new(578.0, 640.0)));
            let Ok(parsed) = url.parse::<tauri::Url>() else { return };
            let _ = window.navigate(parsed);
        }
    });
}

fn show_message(app: &AppHandle, message: String) {
    show_launch_error(app, message.clone());
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let text = serde_json::to_string(&message).unwrap_or_else(|_| format!("{:?}", tr!("启动失败", "Launch failed")));
            let _ = window.eval(&format!("const status = document.getElementById('status'); if (status) status.textContent = {text};"));
        }
        handle.dialog().message(&message).title("Dovun").blocking_show();
    });
}

/// Renders the error with recovery buttons when the splash page is on screen.
fn show_launch_error(app: &AppHandle, message: String) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let text = serde_json::to_string(&message).unwrap_or_else(|_| format!("{:?}", tr!("启动失败", "Launch failed")));
            let _ = window.eval(&format!("window.dovunLaunchError && window.dovunLaunchError({text});"));
        }
    });
}

fn stop_server(app: &AppHandle) {
    let Some(state) = app.try_state::<ServerProcess>() else { return };
    let Some(mut child) = state.0.lock().expect("server lock").take() else { return };
    drop(child.stdin.take());
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if started.elapsed() > Duration::from_secs(2) => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => return,
        }
    }
}

enum PortUser {
    Free,
    Wwa,
    Foreign,
}

/// Distinguish our own loopback server from an unrelated program so the busy message can point at the right fix.
fn probe_port(port: u16) -> PortUser {
    let address = format!("127.0.0.1:{port}");
    let Ok(mut stream) = TcpStream::connect_timeout(&address.parse().expect("loopback address"), Duration::from_millis(300)) else {
        return PortUser::Free;
    };
    // The session route answers without a login and its JSON only comes from this server.
    let request = format!("GET /api/v1/auth/session HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(request.as_bytes()).is_err() {
        return PortUser::Foreign;
    }
    let mut response = String::new();
    let mut buffer = [0_u8; 2048];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                response.push_str(&String::from_utf8_lossy(&buffer[..size]));
                if response.contains("\"authenticated\"") {
                    return PortUser::Wwa;
                }
                if response.len() >= 64 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    PortUser::Foreign
}

fn port_busy_message(user: PortUser, port: u16) -> Option<String> {
    port_busy_message_in(i18n::lang(), user, port)
}

fn port_busy_message_in(lang: i18n::Lang, user: PortUser, port: u16) -> Option<String> {
    match user {
        PortUser::Free => None,
        PortUser::Wwa => Some(tr!(lang;
            "端口 {port} 已被本机另一个 Dovun 服务占用。请先退出已打开的 Dovun；若找不到已打开的窗口，可能是上次异常退出残留的服务，重启电脑后再试。",
            "Port {port} is already used by another Dovun service on this computer. Quit the open Dovun first; if you cannot find its window, a service may be left over from a crash, so restart the computer and try again."
        )),
        PortUser::Foreign => Some(tr!(lang;
            "端口 {port} 被其他程序占用，Dovun 无法启动。请找到占用该端口的程序并关闭后重试。",
            "Port {port} is used by another program, so Dovun cannot start. Close the program using this port and try again."
        )),
    }
}

#[tauri::command]
fn desktop_notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    notify(&app, &title, &body);
    Ok(())
}

fn query_value(url: &Url, key: &str) -> Option<String> {
    url.query_pairs().find(|(name, _)| name == key).map(|(_, value)| value.into_owned())
}

fn clip(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// System notification for things that need the user (a round waits for acceptance, or paused).
fn notify(app: &AppHandle, title: &str, body: &str) {
    let title = clip(title.trim(), 120);
    if title.is_empty() { return; }
    let _ = app.notification().builder().title(title).body(clip(body.trim(), 400)).show();
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeAgentConfig {
    server: String,
    token: String,
    roots: Vec<String>,
    max_concurrent: u8,
}

fn node_dir(data: &Path) -> PathBuf {
    data.join("node")
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeState {
    node_id: String,
    server: String,
    #[serde(default)]
    updated_at: String,
}

fn state_path(data: &Path) -> PathBuf {
    node_dir(data).join("state.json")
}

fn read_node_config(data: &Path) -> Result<NodeAgentConfig, String> {
    let text = fs::read_to_string(node_dir(data).join("config.json")).map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

fn read_node_state(data: &Path) -> Option<NodeState> {
    let text = fs::read_to_string(state_path(data)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_node_state(data: &Path, node_id: &str, server: &str) -> Result<(), String> {
    let dir = node_dir(data);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建执行端目录：{error}"))?;
    let state = NodeState { node_id: node_id.to_string(), server: server.trim_end_matches('/').to_string(), updated_at: iso_now() };
    let path = state_path(data);
    let text = serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?;
    fs::write(&path, text).map_err(|error| format!("无法保存执行端状态：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Days since the Unix epoch, using Howard Hinnant's civil_from_days.
fn iso_from_unix(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let hour = tod / 3_600;
    let minute = (tod % 3_600) / 60;
    let second = tod % 60;
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn iso_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or(0);
    iso_from_unix(secs)
}

/// Serialize `detail` and embed it as a JavaScript value. serde_json keeps quotes inside strings, and U+2028/U+2029 cannot break the script.
fn desktop_event_script(detail: &serde_json::Value) -> String {
    let json = serde_json::to_string(detail).unwrap_or_else(|_| "{}".to_string());
    let json = json.replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029");
    format!("window.dispatchEvent(new CustomEvent('dovun-desktop', {{detail: {json}}}))")
}

fn emit_desktop(app: &AppHandle, detail: &serde_json::Value) {
    let script = desktop_event_script(detail);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        // WebviewWindow::eval forwards to the webview. `get_webview` is behind Tauri's unstable feature.
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.eval(script);
        }
    });
}

fn node_process_running(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<NodeProcess>() else { return false };
    let mut guard = state.0.lock().expect("node lock");
    match guard.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    }
}

fn node_status_detail(app: &AppHandle) -> serde_json::Value {
    let data = data_dir().ok();
    let configured = data.as_ref().is_some_and(|dir| node_dir(dir).join("config.json").exists());
    let state = data.as_ref().and_then(|dir| read_node_state(dir));
    let log_path = data.as_ref().map(|dir| dir.join("logs/node.log").display().to_string());
    serde_json::json!({
        "type": "node-status",
        "nodeId": state.as_ref().map(|item| item.node_id.clone()),
        "server": state.as_ref().map(|item| item.server.clone()),
        "running": node_process_running(app),
        "configured": configured,
        "logPath": log_path,
    })
}

fn pair_detail(ok: bool, message: &str) -> serde_json::Value {
    serde_json::json!({ "type": "node-pair", "ok": ok, "message": message })
}

fn unpair_detail(ok: bool, stopped: bool, config_removed: bool, cancelled: usize, message: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "node-unpair",
        "ok": ok,
        "stopped": stopped,
        "configRemoved": config_removed,
        "cancelled": cancelled,
        "message": message,
    })
}

/// Unpair may touch this machine only when `node` equals the id in state.json.
fn unpair_targets_local(node: &str, state_node_id: Option<&str>) -> bool {
    matches!(state_node_id, Some(current) if !node.is_empty() && current == node)
}

/// Exit 2 is a bad configuration and exit 3 means the computer was revoked.
fn should_restart(code: Option<i32>) -> bool {
    !matches!(code, Some(2) | Some(3))
}

fn receipt_ended(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else { return false };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
    value.get("state").and_then(|item| item.as_str()) == Some("ended")
}

/// Write `cancel.request` for every run whose receipt.json is missing or not ended.
fn write_cancel_requests(runs_dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(runs_dir) else { return 0 };
    let mut count = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        if receipt_ended(&path.join("receipt.json")) { continue; }
        let body = serde_json::json!({ "requestedAt": iso_now() }).to_string();
        if fs::write(path.join("cancel.request"), body).is_ok() { count += 1; }
    }
    count
}

fn take_node_child(app: &AppHandle) -> Option<Child> {
    let state = app.try_state::<NodeProcess>()?;
    let child = state.0.lock().expect("node lock").take();
    child
}

#[cfg(unix)]
fn terminate_child(child: &Child) {
    let pid = child.id();
    if pid == 0 { return; }
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM); }
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> bool {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if started.elapsed() >= timeout => return false,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => return false,
        }
    }
}

/// Unix asks the executor to shut down (it cancels CLI children). Windows, and a timed-out Unix process, are killed.
fn stop_child_for_unpair(mut child: Child) -> bool {
    #[cfg(unix)]
    {
        terminate_child(&child);
        if wait_for_exit(&mut child, Duration::from_secs(8)) { return true; }
    }
    match child.kill() {
        Ok(()) => child.wait().is_ok(),
        Err(_) => matches!(child.try_wait(), Ok(Some(_))),
    }
}

/// Only http(s) servers and base64url tokens; the folder picker is the user's confirmation of what the executor may touch.
fn validate_pairing(server: &str, token: &str) -> Result<String, String> {
    let server = server.trim().trim_end_matches('/').to_string();
    let parsed = server.parse::<Url>().map_err(|_| "服务器地址无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("服务器地址必须以 http:// 或 https:// 开头".to_string());
    }
    if token.len() < 20 || token.len() > 200 || !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("执行端令牌格式无效".to_string());
    }
    Ok(server)
}

fn write_node_config(data: &Path, config: &NodeAgentConfig) -> Result<(), String> {
    let dir = node_dir(data);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建执行端目录：{error}"))?;
    let path = dir.join("config.json");
    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(&path, text).map_err(|error| format!("无法保存执行端配置：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn pair_node(app: &AppHandle, server: String, token: String, node: String) {
    let server = match validate_pairing(&server, &token) {
        Ok(server) => server,
        Err(message) => {
            show_launch_error(app, message.clone());
            notify(app, "本机执行端未启动", &message);
            emit_desktop(app, &pair_detail(false, &message));
            return;
        }
    };
    let handle = app.clone();
    app.dialog().file().set_title("选择允许本机执行端访问的代码目录").pick_folder(move |folder| {
        let Some(folder) = folder.and_then(|item| item.into_path().ok()) else {
            emit_desktop(&handle, &pair_detail(false, &tr!("未选择允许目录", "No allowed folder was selected")));
            return;
        };
        // state.json is written before the process starts, so the page can recognize this computer before the first heartbeat.
        let result = data_dir().and_then(|data| {
            if !node.is_empty() { write_node_state(&data, &node, &server)?; }
            write_node_config(&data, &NodeAgentConfig { server: server.clone(), token: token.clone(), roots: vec![folder.display().to_string()], max_concurrent: 2 })?;
            Ok(())
        });
        match result {
            Ok(()) => {
                stop_node_agent(&handle);
                start_node_agent(&handle);
                notify(&handle, "本机执行端已启动", &format!("允许目录：{}", folder.display()));
                emit_desktop(&handle, &pair_detail(true, &tr!("本机执行端已启动", "The local executor has started")));
            }
            Err(message) => {
                notify(&handle, "本机执行端未启动", &message);
                emit_desktop(&handle, &pair_detail(false, &message));
            }
        }
    });
}

fn unpair_node(app: &AppHandle, node: String) {
    let handle = app.clone();
    thread::spawn(move || {
        let detail = perform_unpair(&handle, &node);
        emit_desktop(&handle, &detail);
    });
}

fn perform_unpair(app: &AppHandle, node: &str) -> serde_json::Value {
    let data = data_dir().ok();
    let state = data.as_ref().and_then(|dir| read_node_state(dir));
    if !unpair_targets_local(node, state.as_ref().map(|item| item.node_id.as_str())) {
        return unpair_detail(false, false, false, 0, &tr!("电脑标识与这台电脑不一致，未改动本机", "The computer id does not match this computer, so nothing was changed"));
    }
    NODE_WANTED.store(false, Ordering::SeqCst);
    let stopped = match take_node_child(app) {
        Some(child) => stop_child_for_unpair(child),
        None => true,
    };
    let cancelled = data.as_ref().map(|dir| write_cancel_requests(&node_dir(dir).join("runner/runs"))).unwrap_or(0);
    let config_removed = if let Some(dir) = &data {
        let config = node_dir(dir).join("config.json");
        let _ = fs::remove_file(&config);
        let _ = fs::remove_file(state_path(dir));
        !config.exists()
    } else {
        false
    };
    let message = if !stopped {
        tr!("本机进程未确认停止", "The local process was not confirmed stopped")
    } else if !config_removed {
        tr!("执行端已停止，但配置文件未能删除", "The executor stopped, but the configuration file could not be deleted")
    } else {
        tr!("已停止本机执行端并移除配置", "The local executor was stopped and its configuration was removed")
    };
    unpair_detail(true, stopped, config_removed, cancelled, &message)
}

/// Starts the paired executor (if any) with the bundled Node and keeps it running; restarts after crashes.
fn start_node_agent(app: &AppHandle) {
    let Ok(data) = data_dir() else { return };
    let dir = node_dir(&data);
    if !dir.join("config.json").exists() { return; }
    let Ok((node, server, _client)) = bundled_paths(app) else { return };
    let entry = server.join("dist/node-agent/index.js");
    if !entry.exists() { return; }
    let _ = fs::create_dir_all(data.join("logs"));
    if NODE_WANTED.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() { return; }
    if !spawn_node_agent(app, &node, &entry, &dir, &data.join("logs/node.log")) { NODE_WANTED.store(false, Ordering::SeqCst); return; }
    let handle = app.clone();
    thread::spawn(move || {
        let mut failures: u32 = 0;
        loop {
            thread::sleep(Duration::from_secs(2));
            if !NODE_WANTED.load(Ordering::SeqCst) { return; }
            let Some(state) = handle.try_state::<NodeProcess>() else { return };
            let status = {
                let mut guard = state.0.lock().expect("node lock");
                match guard.as_mut() {
                    Some(child) => child.try_wait().ok().flatten(),
                    None => return,
                }
            };
            let Some(status) = status else { failures = 0; continue };
            state.0.lock().expect("node lock").take();
            let code = status.code();
            if code == Some(3) {
                notify(&handle, &tr!("这台电脑已在 Dovun 中被吊销", "This computer was revoked in Dovun"), &tr!("执行端已退出，不会自动重启。", "The executor has exited and will not restart."));
            }
            if !should_restart(code) || !NODE_WANTED.load(Ordering::SeqCst) { return; }
            failures += 1;
            thread::sleep(Duration::from_secs(u64::from(5 * failures.min(12))));
            if !NODE_WANTED.load(Ordering::SeqCst) { return; }
            if !spawn_node_agent(&handle, &node, &entry, &dir, &data.join("logs/node.log")) { return; }
        }
    });
}

fn spawn_node_agent(app: &AppHandle, node: &Path, entry: &Path, dir: &Path, log: &Path) -> bool {
    let state = app.state::<NodeProcess>();
    let mut guard = state.0.lock().expect("node lock");
    if let Some(child) = guard.as_mut() {
        if matches!(child.try_wait(), Ok(None)) { return true; }
    }
    let mut command = Command::new(node);
    command
        .arg(entry)
        .arg("--data")
        .arg(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("DOVUN_NODE_LOGIN_PATH", "1")
        .env("DOVUN_NODE_MANAGED", "desktop")
        .env("DOVUN_NODE_LOG", log)
        .env("DOVUN_NODE_VERSION", app.package_info().version.to_string())
        .env_remove("NODE_OPTIONS");
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let Ok(mut child) = command.spawn() else {
        append_log(log, "无法启动本机执行端");
        return false;
    };
    for stream in [child.stdout.take().map(|value| Box::new(value) as Box<dyn Read + Send>), child.stderr.take().map(|value| Box::new(value) as Box<dyn Read + Send>)].into_iter().flatten() {
        let path = log.to_path_buf();
        thread::spawn(move || {
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { break };
                append_log(&path, &line);
            }
        });
    }
    guard.replace(child);
    true
}

fn stop_node_agent(app: &AppHandle) {
    NODE_WANTED.store(false, Ordering::SeqCst);
    let Some(state) = app.try_state::<NodeProcess>() else { return };
    let Some(mut child) = state.0.lock().expect("node lock").take() else { return };
    // Jobs survive restarts: the executor journals them locally and re-reports, so a plain kill is safe.
    let _ = child.kill();
    let _ = child.wait();
}

fn append_log(path: &Path, line: &str) {
    if line.contains("owner-token") { return; }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_preparation_retries_and_only_success_is_cached() {
        let state = Mutex::new(false);
        assert!(prepare_once(&state, || Err("old service still running".into())).is_err());
        assert!(!*state.lock().unwrap());
        assert!(prepare_once(&state, || Ok(())).is_ok());
        assert!(prepare_once(&state, || panic!("successful migration must not repeat")).is_ok());
    }

    #[test]
    fn empty_data_overrides_use_the_same_default_migration_path() {
        let old_new = std::env::var_os("DOVUN_DATA_DIR"); let old_legacy = std::env::var_os("WWA_DATA_DIR");
        std::env::set_var("DOVUN_DATA_DIR", ""); std::env::set_var("WWA_DATA_DIR", "");
        assert!(data_override().is_none()); assert!(data_dir().unwrap().ends_with("dovun"));
        std::env::remove_var("DOVUN_DATA_DIR"); assert!(data_override().is_none());
        if let Some(value) = old_new { std::env::set_var("DOVUN_DATA_DIR", value); } else { std::env::remove_var("DOVUN_DATA_DIR"); }
        if let Some(value) = old_legacy { std::env::set_var("WWA_DATA_DIR", value); } else { std::env::remove_var("WWA_DATA_DIR"); }
    }

    #[test]
    fn obsolete_custom_data_stops_before_window_or_workspace_creation() {
        assert!(obsolete_data_override(None, Some("/custom/original".into())).unwrap_err().contains("No empty workspace"));
        assert!(obsolete_data_override(Some("".into()), Some("/custom/original".into())).is_err());
        assert!(obsolete_data_override(Some("/custom/original".into()), Some("/custom/original".into())).is_ok());
    }

    #[test]
    fn a_free_port_has_no_busy_message() {
        assert!(port_busy_message(PortUser::Free, DESKTOP_PORT).is_none());
    }

    #[test]
    fn another_instance_message_names_the_service() {
        let message = port_busy_message_in(i18n::Lang::Zh, PortUser::Wwa, DESKTOP_PORT).expect("busy message");
        assert!(message.contains("另一个 Dovun"));
        assert!(message.contains("残留的服务"));
        assert!(message.contains("47316"));
    }

    #[test]
    fn a_foreign_occupant_is_called_out() {
        let message = port_busy_message_in(i18n::Lang::Zh, PortUser::Foreign, DESKTOP_PORT).expect("busy message");
        assert!(message.contains("其他程序"));
        assert!(!message.contains("另一个 Dovun"));
    }

    #[test]
    fn busy_messages_follow_english_system_language() {
        let other = port_busy_message_in(i18n::Lang::En, PortUser::Wwa, DESKTOP_PORT).expect("busy message");
        assert!(other.contains("another Dovun service") && other.contains("47316"));
        let foreign = port_busy_message_in(i18n::Lang::En, PortUser::Foreign, DESKTOP_PORT).expect("busy message");
        assert!(foreign.contains("another program"));
    }

    #[test]
    fn probe_recognizes_a_wwa_responder() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("address").port();
        let responder = thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut request = [0_u8; 512];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"data\":{\"authenticated\":false},\"error\":null}");
        });
        assert!(matches!(probe_port(port), PortUser::Wwa));
        responder.join().expect("responder");
    }

    #[test]
    fn probe_reports_a_foreign_responder() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("address").port();
        let responder = thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut request = [0_u8; 512];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nhello");
        });
        assert!(matches!(probe_port(port), PortUser::Foreign));
        responder.join().expect("responder");
    }

    #[test]
    fn pairing_accepts_only_http_servers_and_base64url_tokens() {
        let token = "abcdefghijklmnopqrstuvwxyz_-0123456789";
        assert_eq!(validate_pairing("https://wwa.example.com/", token).expect("valid"), "https://wwa.example.com");
        assert!(validate_pairing("file:///etc", token).is_err());
        assert!(validate_pairing("javascript:alert(1)", token).is_err());
        assert!(validate_pairing("https://wwa.example.com", "short").is_err());
        assert!(validate_pairing("https://wwa.example.com", "bad token with spaces and more chars").is_err());
    }

    #[test]
    fn node_config_is_written_for_the_bundled_executor() {
        let directory = std::env::temp_dir().join(format!("wwa-node-config-{}", std::process::id()));
        write_node_config(&directory, &NodeAgentConfig { server: "https://wwa.example.com".to_string(), token: "t".repeat(32), roots: vec!["/code".to_string()], max_concurrent: 2 }).expect("write");
        let text = fs::read_to_string(node_dir(&directory).join("config.json")).expect("read");
        let value: serde_json::Value = serde_json::from_str(&text).expect("json");
        assert_eq!(value["roots"][0], "/code");
        assert_eq!(value["maxConcurrent"], 2);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn launcher_config_round_trip() {
        let directory = std::env::temp_dir().join(format!("wwa-launcher-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("create temp dir");
        assert!(read_launcher_config(&directory).is_none());
        write_launcher_config(&directory, &LauncherConfig { mode: "remote".to_string(), remote_url: "https://wwa.example.com".to_string() }).expect("write");
        let config = read_launcher_config(&directory).expect("read back");
        assert_eq!(config.mode, "remote");
        assert_eq!(config.remote_url, "https://wwa.example.com");
        write_launcher_config(&directory, &LauncherConfig::local()).expect("write");
        assert_eq!(read_launcher_config(&directory).expect("read back").mode, "local");
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn unknown_modes_are_ignored() {
        let directory = std::env::temp_dir().join(format!("wwa-launcher-invalid-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("create temp dir");
        fs::write(launcher_config_path(&directory), r#"{"mode":"weird","remoteUrl":"x"}"#).expect("write");
        assert!(read_launcher_config(&directory).is_none());
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn remote_probe_rejects_bad_urls() {
        assert!(probe_remote("not a url").is_err());
        assert!(probe_remote("ftp://example.com").is_err());
    }

    #[test]
    fn old_config_without_node_id_reads_and_state_round_trips() {
        let directory = std::env::temp_dir().join(format!("wwa-node-state-{}-{}", std::process::id(), iso_now().replace(':', "-")));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(node_dir(&directory)).expect("dir");
        fs::write(node_dir(&directory).join("config.json"), r#"{"server":"https://wwa.example.com","token":"abcdefghijklmnopqrstuvwxyz012345","roots":["/code"],"maxConcurrent":2,"revokedAt":"2026-10-21T00:00:00Z"}"#).expect("write");
        let config = read_node_config(&directory).expect("old config has no nodeId");
        assert_eq!(config.server, "https://wwa.example.com");
        assert_eq!(config.roots, vec!["/code".to_string()]);
        assert_eq!(config.max_concurrent, 2);
        assert!(read_node_state(&directory).is_none());
        write_node_state(&directory, "node-7", "https://wwa.example.com/").expect("state");
        let state = read_node_state(&directory).expect("state");
        assert_eq!(state.node_id, "node-7");
        assert_eq!(state.server, "https://wwa.example.com");
        assert!(!state.updated_at.is_empty());
        let config_text = fs::read_to_string(node_dir(&directory).join("config.json")).expect("config");
        assert!(!config_text.contains("nodeId"));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn restart_skips_configuration_errors_and_revocation() {
        assert!(!should_restart(Some(2)));
        assert!(!should_restart(Some(3)));
        assert!(should_restart(Some(0)));
        assert!(should_restart(Some(1)));
        assert!(should_restart(None));
    }

    #[test]
    fn cancel_requests_skip_ended_receipts() {
        let directory = std::env::temp_dir().join(format!("wwa-cancel-{}-{}", std::process::id(), iso_from_unix(1_700_000_000).replace(':', "-")));
        let _ = fs::remove_dir_all(&directory);
        let ended = directory.join("run-ended");
        let open = directory.join("run-open");
        let missing = directory.join("run-missing");
        fs::create_dir_all(&ended).expect("ended");
        fs::create_dir_all(&open).expect("open");
        fs::create_dir_all(&missing).expect("missing");
        fs::write(ended.join("receipt.json"), r#"{"state":"ended","exitCode":0}"#).expect("receipt");
        fs::write(open.join("receipt.json"), r#"{"state":"running"}"#).expect("receipt");
        fs::write(directory.join("notes.txt"), "not a run").expect("file");
        assert_eq!(write_cancel_requests(&directory), 2);
        assert!(!ended.join("cancel.request").exists());
        for run in [&open, &missing] {
            let text = fs::read_to_string(run.join("cancel.request")).expect("cancel");
            let value: serde_json::Value = serde_json::from_str(&text).expect("json");
            let at = value["requestedAt"].as_str().expect("timestamp");
            assert!(at.contains('T') && at.ends_with('Z'));
        }
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn unpair_requires_the_stored_node_id() {
        assert!(!unpair_targets_local("node-a", None));
        assert!(!unpair_targets_local("node-a", Some("node-b")));
        assert!(!unpair_targets_local("", Some("node-a")));
        assert!(unpair_targets_local("node-a", Some("node-a")));
    }

    #[test]
    fn iso_from_unix_formats_known_instants() {
        assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_unix(1_700_000_000), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn desktop_events_embed_serialized_json() {
        let detail = serde_json::json!({
            "type": "node-status",
            "nodeId": "n'1",
            "server": "https://wwa.example.com",
            "running": true,
            "configured": false,
            "logPath": "</script>",
            "note": "line\u{2028}break",
        });
        let script = desktop_event_script(&detail);
        assert!(script.contains("new CustomEvent('dovun-desktop'"));
        assert!(script.ends_with("}))"));
        assert!(!script.contains('\u{2028}'));
        let json = serde_json::to_string(&detail).unwrap().replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029");
        assert!(script.contains(&json));
        assert!(!script.contains("'); alert"));
    }
}
