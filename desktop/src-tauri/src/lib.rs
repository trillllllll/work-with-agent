use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{AppHandle, LogicalSize, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::DialogExt;

const DESKTOP_PORT: u16 = 47316;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct ServerProcess(Mutex<Option<Child>>);

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_min_size(Some(LogicalSize::new(578.0, 640.0)));
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { .. } = event {
                        handle.exit(0);
                    }
                });
            }
            let handle = app.handle().clone();
            thread::spawn(move || {
                if let Err(message) = launch(&handle) {
                    show_message(&handle, message);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("启动 Work With Agent 失败")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_server(app);
            }
        });
}

fn launch(app: &AppHandle) -> Result<(), String> {
    if let Some(message) = port_busy_message(probe_port(DESKTOP_PORT), DESKTOP_PORT) {
        return Err(message);
    }
    let (node, server, client) = bundled_paths(app)?;
    let data = data_dir()?;
    for directory in ["knowledge-blobs", "runner", "workspace", "logs", "bin"] {
        fs::create_dir_all(data.join(directory)).map_err(|error| format!("无法创建数据目录：{error}"))?;
    }
    #[cfg(unix)]
    write_mcp_launcher(&data, &node, &server.join("dist/mcp/index.js"))?;
    let log = data.join("logs/server.log");
    let mut command = Command::new(&node);
    command
        .arg(server.join("dist/index.js"))
        .current_dir(&server)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("WWA_PACKAGED", "1")
        .env("PORT", DESKTOP_PORT.to_string())
        .env("CLIENT_ORIGIN", format!("http://127.0.0.1:{DESKTOP_PORT}"))
        .env("WWA_DATA_DIR", &data)
        .env("DATABASE_URL", format!("file:{}", data.join("agent-studio.db").display()))
        .env("KNOWLEDGE_STORAGE_ROOT", data.join("knowledge-blobs"))
        .env("WWA_RUNNER_DIR", data.join("runner"))
        .env("AGENT_WORKSPACE_ROOT", data.join("workspace"))
        .env("WWA_STATIC_DIR", &client)
        .env_remove("NODE_OPTIONS");
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|error| format!("无法启动本机服务：{error}"))?;
    let stdout = child.stdout.take().ok_or("无法读取服务输出")?;
    let stderr = child.stderr.take().ok_or("无法读取服务错误输出")?;
    app.state::<ServerProcess>().0.lock().expect("server lock").replace(child);
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
            Some(status) => format!("本机服务已退出（{status}）。{detail}"),
            None => format!("本机服务没有在 60 秒内完成启动。{detail}"),
        }
    })?;
    println!("{line}");
    let url = line.trim().trim_start_matches("Open workspace: ").trim().to_string();
    open_workspace(app, url);
    Ok(())
}

fn bundled_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let root = app.path().resource_dir().map_err(|error| error.to_string())?;
    let node = existing(&root, &["node.exe", "resources/node.exe", "node", "resources/node"]).ok_or_else(|| format!("安装包里没有 Node。查找目录：{}", root.display()))?;
    let server_entry = existing(&root, &["server/dist/index.js", "resources/server/dist/index.js"]).ok_or_else(|| format!("安装包里没有服务。查找目录：{}", root.display()))?;
    let client_entry = existing(&root, &["client/index.html", "resources/client/index.html"]).ok_or_else(|| format!("安装包里没有界面。查找目录：{}", root.display()))?;
    let server = server_entry.parent().and_then(Path::parent).ok_or("无法定位服务目录")?.to_path_buf();
    let client = client_entry.parent().ok_or("无法定位界面目录")?.to_path_buf();
    Ok((node, server, client))
}

fn existing(root: &Path, relatives: &[&str]) -> Option<PathBuf> {
    relatives.iter().map(|relative| root.join(relative)).find(|path| path.exists())
}

fn data_dir() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("WWA_DATA_DIR") {
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }

    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("APPDATA"))
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or("找不到用户数据目录")?;
        return Ok(PathBuf::from(base).join("work-with-agent"));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").map_err(|_| "找不到用户主目录")?;
        return Ok(PathBuf::from(home).join("Library/Application Support/work-with-agent"));
    }
}

#[cfg(unix)]
fn write_mcp_launcher(data: &Path, node: &Path, entry: &Path) -> Result<(), String> {
    let script = data.join("bin/wwa-mcp");
    let body = format!("#!/bin/bash\nexec {} {} \"$@\"\n", shell_quote(node), shell_quote(entry));
    fs::write(&script, body).map_err(|error| format!("无法写入 MCP 启动脚本：{error}"))?;
    let mut permissions = fs::metadata(&script).map_err(|error| error.to_string())?.permissions();
    use std::os::unix::fs::PermissionsExt;
    permissions.set_mode(0o755);
    fs::set_permissions(&script, permissions).map_err(|error| format!("无法标记 MCP 启动脚本为可执行：{error}"))?;
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
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let text = serde_json::to_string(&message).unwrap_or_else(|_| "\"启动失败\"".to_string());
            let _ = window.eval(&format!("const status = document.getElementById('status'); if (status) status.textContent = {text};"));
        }
        handle.dialog().message(&message).title("Work With Agent").blocking_show();
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
    match user {
        PortUser::Free => None,
        PortUser::Wwa => Some(format!(
            "端口 {port} 已被本机另一个 Work With Agent 服务占用。请先退出已打开的 Work With Agent；若找不到已打开的窗口，可能是上次异常退出残留的服务，重启电脑后再试。"
        )),
        PortUser::Foreign => Some(format!(
            "端口 {port} 被其他程序占用，Work With Agent 无法启动。请找到占用该端口的程序并关闭后重试。"
        )),
    }
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
    fn a_free_port_has_no_busy_message() {
        assert!(port_busy_message(PortUser::Free, DESKTOP_PORT).is_none());
    }

    #[test]
    fn another_instance_message_names_the_service() {
        let message = port_busy_message(PortUser::Wwa, DESKTOP_PORT).expect("busy message");
        assert!(message.contains("另一个 Work With Agent"));
        assert!(message.contains("残留的服务"));
        assert!(message.contains("47316"));
    }

    #[test]
    fn a_foreign_occupant_is_called_out() {
        let message = port_busy_message(PortUser::Foreign, DESKTOP_PORT).expect("busy message");
        assert!(message.contains("其他程序"));
        assert!(!message.contains("另一个 Work With Agent"));
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
}
