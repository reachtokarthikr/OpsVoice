"""FastAPI application for the OpsVoice streaming backend."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import secrets
import socket
import time
import uuid
from contextlib import suppress
from pathlib import Path
from typing import Any

from google.auth.exceptions import DefaultCredentialsError

from dotenv import load_dotenv
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from starlette.requests import Request
from starlette.responses import Response

from app.opsvoice_agent import APP_NAME, root_agent
from app.opsvoice_agent.tools import SERVICE_HEALTH, get_incident_snapshot, get_dynamic_health, pop_pending_alerts

load_dotenv()

LOGGER = logging.getLogger("opsvoice")
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# --- Security configuration ---
_SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,64}$")
_ALLOWED_IMAGE_MIMES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
_MAX_TEXT_MESSAGE_BYTES = 64 * 1024          # 64 KB per text WS message
_MAX_BINARY_MESSAGE_BYTES = 256 * 1024       # 256 KB per binary WS message (audio chunk)
_MAX_IMAGE_DATA_BYTES = 2 * 1024 * 1024      # 2 MB decoded image payload
_WS_RATE_LIMIT_PER_SEC = 60                  # max messages per second per connection
_MAX_ACTIVE_SESSIONS = int(os.getenv("OPSVOICE_MAX_SESSIONS", "50"))
_SESSION_TOKEN_TTL = 3600 * 4                # 4 hours

# --- Session token store ---
_session_tokens: dict[str, dict[str, Any]] = {}  # token -> {user_id, session_id, created_at}

# --- Active WebSocket connections for broadcasting ---
_active_websockets: set[WebSocket] = set()


def _generate_session_token(user_id: str, session_id: str) -> str:
    """Create and store a cryptographic session token."""
    token = secrets.token_urlsafe(32)
    _session_tokens[token] = {
        "user_id": user_id,
        "session_id": session_id,
        "created_at": time.time(),
    }
    # Prune expired tokens
    now = time.time()
    expired = [t for t, v in _session_tokens.items() if now - v["created_at"] > _SESSION_TOKEN_TTL]
    for t in expired:
        _session_tokens.pop(t, None)
    return token


def _validate_session_token(token: str | None) -> dict[str, str] | None:
    """Return session info if token is valid and not expired, else None."""
    if not token:
        return None
    info = _session_tokens.get(token)
    if not info:
        return None
    if time.time() - info["created_at"] > _SESSION_TOKEN_TTL:
        _session_tokens.pop(token, None)
        return None
    return info


def _is_safe_id(value: str) -> bool:
    return bool(_SAFE_ID_RE.match(value))


session_service = InMemorySessionService()
runner = Runner(agent=root_agent, app_name=APP_NAME, session_service=session_service)


def _configure_logging() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def _create_run_config(response_modalities: list[str] | None = None) -> RunConfig:
    return RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=response_modalities or ["AUDIO"],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                disabled=True
            )
        ),
        session_resumption=types.SessionResumptionConfig(),
    )


def _friendly_live_error_message(exc: Exception) -> str:
    if isinstance(exc, TimeoutError):
        return (
            "Timed out connecting to the Gemini Live API. Check internet access, DNS/proxy settings, "
            "and that the configured model is reachable from this machine."
        )
    if isinstance(exc, socket.gaierror):
        return "DNS lookup failed while connecting to the Gemini Live API. Check local network and proxy settings."
    if isinstance(exc, DefaultCredentialsError):
        return (
            "Google Cloud credentials are missing for a required backend service. Set GOOGLE_APPLICATION_CREDENTIALS "
            "or disable that integration for local development."
        )
    return "The streaming session ended unexpectedly while connecting to the Gemini Live API."


async def _ensure_session(user_id: str, session_id: str) -> None:
    session = await session_service.get_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
    )
    if not session:
        await session_service.create_session(
            app_name=APP_NAME,
            user_id=user_id,
            session_id=session_id,
        )


def _decode_image_blob(message: dict[str, Any]) -> types.Blob | None:
    """Decode and validate an image blob from a WebSocket message."""
    mime_type = message.get("mimeType", "image/jpeg")
    if mime_type not in _ALLOWED_IMAGE_MIMES:
        LOGGER.warning("Rejected image with disallowed MIME type: %s", mime_type)
        return None

    try:
        image_data = base64.b64decode(message["data"])
    except Exception:
        LOGGER.warning("Failed to decode base64 image data")
        return None

    if len(image_data) > _MAX_IMAGE_DATA_BYTES:
        LOGGER.warning("Rejected image exceeding size limit: %d bytes", len(image_data))
        return None

    return types.Blob(mime_type=mime_type, data=image_data)


def _text_content(message: dict[str, Any]) -> types.Content:
    return types.Content(
        role="user",
        parts=[types.Part(text=message["text"][:4096])],  # cap text length
    )


def _multimodal_text_content(message: dict[str, Any], blob: types.Blob) -> types.Content:
    return types.Content(
        role="user",
        parts=[
            types.Part(text=message["text"][:4096]),
            types.Part(inline_data=blob),
        ],
    )


async def _handle_upstream_message(
    websocket_message: dict[str, Any],
    live_request_queue: LiveRequestQueue,
) -> None:
    # Binary audio data
    raw_bytes = websocket_message.get("bytes")
    if raw_bytes is not None:
        if len(raw_bytes) > _MAX_BINARY_MESSAGE_BYTES:
            LOGGER.warning("Dropped oversized binary message: %d bytes", len(raw_bytes))
            return
        audio_blob = types.Blob(
            mime_type="audio/pcm;rate=16000",
            data=raw_bytes,
        )
        live_request_queue.send_realtime(audio_blob)
        return

    payload = websocket_message.get("text")
    if not payload:
        return

    if len(payload) > _MAX_TEXT_MESSAGE_BYTES:
        LOGGER.warning("Dropped oversized text message: %d bytes", len(payload))
        return

    try:
        message = json.loads(payload)
    except json.JSONDecodeError:
        LOGGER.warning("Ignoring non-JSON websocket payload.")
        return

    message_type = message.get("type")
    if message_type == "text" and message.get("text"):
        live_request_queue.send_content(_text_content(message))
        return
    if message_type == "multimodal_text" and message.get("text") and message.get("data"):
        blob = _decode_image_blob(message)
        if blob is not None:
            live_request_queue.send_content(_multimodal_text_content(message, blob))
        else:
            live_request_queue.send_content(_text_content(message))
        return
    if message_type == "image" and message.get("data"):
        blob = _decode_image_blob(message)
        if blob is not None:
            live_request_queue.send_realtime(blob)
        return
    if message_type == "activity_start":
        if message.get("data"):
            blob = _decode_image_blob(message)
            if blob is not None:
                live_request_queue.send_realtime(blob)
        live_request_queue.send_activity_start()
        return
    if message_type == "activity_end":
        live_request_queue.send_activity_end()
        return

    LOGGER.info("Ignoring unsupported websocket message type: %s", message_type)


async def _alert_broadcast_loop() -> None:
    """Background task that checks for health changes and broadcasts alerts."""
    while True:
        await asyncio.sleep(5)
        try:
            # Trigger health evolution
            get_dynamic_health()
            alerts = pop_pending_alerts()
            if alerts and _active_websockets:
                for alert in alerts:
                    message = json.dumps(alert)
                    dead: list[WebSocket] = []
                    for ws in list(_active_websockets):
                        try:
                            await ws.send_text(message)
                        except Exception:
                            dead.append(ws)
                    for ws in dead:
                        _active_websockets.discard(ws)
        except Exception:
            LOGGER.exception("Alert broadcast loop error")


def create_app() -> FastAPI:
    _configure_logging()
    app = FastAPI(title="OpsVoice", version="0.1.0")

    @app.on_event("startup")
    async def _start_alert_monitor() -> None:
        asyncio.create_task(_alert_broadcast_loop())

    # CORS: require explicit origins — no wildcard fallback
    allowed_origins = os.getenv("OPSVOICE_ALLOWED_ORIGINS", "").split(",")
    allowed_origins = [o.strip() for o in allowed_origins if o.strip()]
    if allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=allowed_origins,
            allow_methods=["GET", "POST"],
            allow_headers=["Authorization"],
        )

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    # --- Helper: extract bearer token from request ---
    def _get_request_token(request: Request) -> str | None:
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:]
        return request.query_params.get("token")

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/architecture.html", include_in_schema=False)
    async def architecture() -> FileResponse:
        return FileResponse(STATIC_DIR / "architecture.html")

    @app.get("/opsvoice-video-slides.html", include_in_schema=False)
    async def video_slides() -> FileResponse:
        return FileResponse(STATIC_DIR / "opsvoice-video-slides.html")

    @app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse({"status": "ok", "app": APP_NAME})

    @app.get("/session")
    async def create_session() -> JSONResponse:
        # Enforce session cap
        if len(_session_tokens) >= _MAX_ACTIVE_SESSIONS:
            return JSONResponse(
                {"error": "Too many active sessions. Try again later."},
                status_code=429,
            )
        user_id = f"user-{uuid.uuid4().hex[:8]}"
        session_id = str(uuid.uuid4())
        token = _generate_session_token(user_id, session_id)
        return JSONResponse({
            "user_id": user_id,
            "session_id": session_id,
            "token": token,
        })

    @app.get("/api/services")
    async def get_services(request: Request) -> JSONResponse:
        """Return current service health data for the dashboard."""
        if not _validate_session_token(_get_request_token(request)):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        return JSONResponse(get_dynamic_health())

    @app.get("/api/incidents")
    async def get_incidents(request: Request) -> JSONResponse:
        """Return the latest incident snapshot for the dashboard."""
        if not _validate_session_token(_get_request_token(request)):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        return JSONResponse(get_incident_snapshot())

    @app.websocket("/ws/{user_id}/{session_id}")
    async def websocket_endpoint(
        websocket: WebSocket,
        user_id: str,
        session_id: str,
        token: str = Query(default=""),
    ) -> None:
        # Validate path parameters
        if not _is_safe_id(user_id) or not _is_safe_id(session_id):
            await websocket.close(code=4400, reason="Invalid user_id or session_id format")
            return

        # Validate session token matches the path
        session_info = _validate_session_token(token)
        if not session_info:
            await websocket.close(code=4401, reason="Invalid or expired session token")
            return
        if session_info["user_id"] != user_id or session_info["session_id"] != session_id:
            await websocket.close(code=4403, reason="Token does not match session")
            return

        await websocket.accept()
        _active_websockets.add(websocket)
        await _ensure_session(user_id=user_id, session_id=session_id)

        live_request_queue = LiveRequestQueue()
        run_config = _create_run_config()

        # Rate limiter state for this connection
        msg_timestamps: list[float] = []

        async def upstream_task() -> None:
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    raise WebSocketDisconnect

                # Per-connection rate limiting
                now = time.time()
                msg_timestamps.append(now)
                # Keep only timestamps from the last second
                while msg_timestamps and msg_timestamps[0] < now - 1.0:
                    msg_timestamps.pop(0)
                if len(msg_timestamps) > _WS_RATE_LIMIT_PER_SEC:
                    LOGGER.warning("Rate limit exceeded for user=%s session=%s", user_id, session_id)
                    await websocket.close(code=4429, reason="Rate limit exceeded")
                    return

                await _handle_upstream_message(message, live_request_queue)

        async def downstream_task() -> None:
            async for event in runner.run_live(
                user_id=user_id,
                session_id=session_id,
                live_request_queue=live_request_queue,
                run_config=run_config,
            ):
                event_json = event.model_dump_json(exclude_none=True, by_alias=True)
                await websocket.send_text(event_json)

        try:
            await asyncio.gather(upstream_task(), downstream_task())
        except WebSocketDisconnect:
            LOGGER.info("WebSocket disconnected for user=%s session=%s", user_id, session_id)
        except Exception as exc:
            LOGGER.exception("WebSocket session failed for user=%s session=%s", user_id, session_id)
            with suppress(Exception):
                await websocket.send_text(
                    json.dumps({
                        "type": "server_error",
                        "message": _friendly_live_error_message(exc),
                    })
                )
        finally:
            _active_websockets.discard(websocket)
            live_request_queue.close()
            # Revoke the session token on disconnect
            _session_tokens.pop(token, None)
            with suppress(Exception):
                await websocket.close()

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    try:
        port = int(os.getenv("PORT", "8080"))
    except ValueError:
        port = 8080

    host = os.getenv("OPSVOICE_HOST", "127.0.0.1")
    reload = os.getenv("OPSVOICE_RELOAD", "false").lower() == "true"
    if reload:
        LOGGER.warning("Running with auto-reload enabled — do not use in production")

    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        reload=reload,
    )
