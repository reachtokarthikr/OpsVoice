# OpsVoice Architecture

> **Interactive diagram**: [opsvoice-942622207688.us-central1.run.app/static/architecture.html](https://opsvoice-942622207688.us-central1.run.app/static/architecture.html)

## Overview

OpsVoice is a real-time streaming SRE copilot built around Gemini Live API capabilities and deployed on Google Cloud. The application uses a custom browser client, a FastAPI WebSocket backend, and a Google ADK agent with six incident management tools.

## Components

### Browser client
- Served from `static/`
- Captures microphone audio in the browser and downsamples to 16 kHz PCM
- Captures camera frames once per second as JPEG
- Opens a WebSocket to the backend and renders transcript plus raw event logs

### Backend
- `app/main.py`
- FastAPI app serving static files, health checks, session creation, and the streaming WebSocket
- Converts browser messages into ADK `LiveRequestQueue` events
- Forwards ADK events back to the browser as JSON

### Agent
- `app/opsvoice_agent/agent.py`
- Gemini native-audio model by default: `gemini-2.5-flash-native-audio-preview-12-2025`
- Tool set:
  - `google_search`
  - `check_service_health`
  - `create_incident`
  - `get_open_incidents`
  - `update_incident_status`
  - `get_runbook`

### State and storage
- Firestore is used when `GOOGLE_CLOUD_PROJECT` and runtime credentials are configured
- Session-state fallback is used locally so the scaffold remains usable without cloud setup

### Infrastructure
- Docker image for Cloud Run
- Terraform scaffold for Artifact Registry, Firestore, Secret Manager, IAM, and Cloud Run

## Data Flow

```text
Browser audio/video/text
  -> FastAPI WebSocket endpoint
  -> ADK LiveRequestQueue
  -> Runner.run_live()
  -> Gemini Live API
  -> Tool execution
  -> ADK events
  -> Browser transcript and audio playback
```

## Design Choices

### Why a custom browser client
The earlier docs mixed FastRTC, Gradio, and vanilla JavaScript. The scaffold now uses a single browser client path so the repository matches the actual implementation and can be deployed as one service.

### Why Firestore is optional in local development
The hackathon submission needs Google Cloud usage, but local development should still work before cloud resources are provisioned. The tool layer therefore falls back to in-session state when Firestore is unavailable.

### Why Google Search is included
Grounding is useful during incident response, especially when the local scaffold does not yet have real runbooks or monitoring integrations for every case.

## Future Work
- **Production monitoring integrations**: Replace the built-in health simulation with real monitoring APIs (Datadog, PagerDuty, Prometheus) so tool outputs reflect live production state.
- **Multi-region deployment**: Add Cloud Run multi-region support with Firestore global distribution for high-availability incident management.
- **Audio playback buffering**: Optimize client-side audio buffering for higher-latency network conditions.
- **Team collaboration**: Add multi-user incident channels so multiple on-call engineers can share the same voice session.
