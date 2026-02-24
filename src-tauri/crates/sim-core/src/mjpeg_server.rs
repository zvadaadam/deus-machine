use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch};

pub struct MjpegServer {
    port: u16,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

impl MjpegServer {
    pub async fn start(frame_rx: watch::Receiver<Bytes>) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Failed to bind MJPEG server: {}", e))?;

        let port = listener
            .local_addr()
            .map_err(|e| format!("Failed to get local addr: {}", e))?
            .port();

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let app = Router::new().route(
            "/stream.mjpeg",
            get({
                let rx = frame_rx;
                move || handle_mjpeg_stream(rx.clone())
            }),
        );

        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await
                .ok();
        });

        log::info!(
            "MJPEG server started on http://127.0.0.1:{}/stream.mjpeg",
            port
        );

        Ok(Self {
            port,
            shutdown_tx: Some(shutdown_tx),
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/stream.mjpeg", self.port)
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
            log::info!("MJPEG server stopped");
        }
    }
}

impl Drop for MjpegServer {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn handle_mjpeg_stream(mut frame_rx: watch::Receiver<Bytes>) -> impl IntoResponse {
    let stream = async_stream::stream! {
        let boundary = "NextFrame";

        loop {
            // Wait for the next frame change — watch::changed() NEVER misses updates.
            // Even if multiple frames arrive while we're busy sending, we'll always
            // see the latest one (skipping intermediate frames, which is what we want).
            if frame_rx.changed().await.is_err() {
                // Sender dropped — stream ended
                break;
            }

            // Borrow the latest frame (O(1) — just reads the watch value)
            let frame_data = frame_rx.borrow_and_update().clone();

            if frame_data.is_empty() {
                continue;
            }

            // Yield MJPEG multipart frame as separate chunks (zero-copy for JPEG body).
            // The JPEG body is already a Bytes (Arc-backed), so clone is O(1).
            let header = format!(
                "--{boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
                frame_data.len()
            );
            yield Ok::<Bytes, std::io::Error>(Bytes::from(header));
            yield Ok::<Bytes, std::io::Error>(frame_data);
            yield Ok::<Bytes, std::io::Error>(Bytes::from_static(b"\r\n"));
        }
    };

    let body = axum::body::Body::from_stream(stream);

    (
        [
            (
                axum::http::header::CONTENT_TYPE,
                "multipart/x-mixed-replace;boundary=NextFrame",
            ),
            (
                axum::http::header::CACHE_CONTROL,
                "no-cache, no-store, must-revalidate",
            ),
            (axum::http::header::CONNECTION, "keep-alive"),
        ],
        body,
    )
}
