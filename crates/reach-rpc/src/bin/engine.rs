//! Reach Engine service entry point.
//!
//! Parses startup configuration (one Gateway origin, Engine identifier,
//! workspace roots, timeout policy), then runs the single-Gateway Runtime with
//! the concrete loopback HTTP heartbeat and WebSocket session adapters.

use reach_rpc::{
    default_registry, EngineConfig, EngineRuntime, LocalHttpHeartbeatTransport,
    LocalWebSocketSessionTransportFactory, SystemClock, WorkspaceFilesystem, ENGINE_VERSION,
};
use std::time::Duration;

fn main() {
    let gateway_url = std::env::args().nth(1);
    if matches!(gateway_url.as_deref(), Some("--version" | "-V")) {
        println!("{ENGINE_VERSION}");
        return;
    }
    let config = match EngineConfig::parse_from_env(gateway_url.as_deref()) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("Reach engine configuration error: {error}");
            std::process::exit(1);
        }
    };

    // Create the default workspace root so the first read/write succeeds out
    // of the box when no explicit root overrides are configured.
    if let Some(root) = config.workspace_roots.get("default") {
        if let Err(error) = std::fs::create_dir_all(root) {
            eprintln!("Reach engine could not create default workspace {root:?}: {error}");
            std::process::exit(1);
        }
    }

    let workspace = WorkspaceFilesystem::new(config.workspace_roots.clone());
    let heartbeat = LocalHttpHeartbeatTransport::new(
        config.gateway.clone(),
        &config.engine_id,
        config.timeouts.connection_timeout,
    );
    let registry = default_registry();
    reach_rpc::process::install_shutdown_handlers();
    let mut runtime = EngineRuntime::new(
        config.clone(),
        workspace,
        registry,
        Box::new(heartbeat),
        Box::new(LocalWebSocketSessionTransportFactory),
        Box::new(SystemClock),
        Box::new(|duration| {
            let deadline = std::time::Instant::now() + duration;
            while std::time::Instant::now() < deadline && !reach_rpc::process::shutdown_requested()
            {
                std::thread::sleep(
                    Duration::from_millis(100)
                        .min(deadline.saturating_duration_since(std::time::Instant::now())),
                );
            }
        }),
    );

    println!(
        "Reach engine v{} ({}) heartbeating {}",
        ENGINE_VERSION, config.engine_id, config.gateway.base_url
    );
    if let Err(error) = runtime.run() {
        eprintln!("Reach engine failed: {error}");
        std::process::exit(1);
    }
}
