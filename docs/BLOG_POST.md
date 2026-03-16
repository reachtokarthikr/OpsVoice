# How I Built OpsVoice for the Gemini Live Agent Challenge

*I created this piece of content for the purposes of entering the Gemini Live Agent Challenge hackathon.* #GeminiLiveAgentChallenge

---

## The problem

On-call incident response is one of the worst moments to rely on a text-only assistant. When a P1 fires at 3 AM, you're juggling terminals, dashboards, Slack, and PagerDuty -- the last thing you want is to type detailed queries into a chatbot.

Engineers need their hands free. They need an assistant that can hear them, see their screens, and take action -- not another text box.

OpsVoice is an attempt to build something closer to an SRE copilot: voice-first, vision-aware, proactive, and grounded in real tool calls.

## What I built

OpsVoice is a real-time, voice-first SRE command center. Engineers speak naturally to a Gemini-powered agent that can:

- **Check service health** across 6 microservices with live metrics
- **Create and manage incidents** with full lifecycle tracking (OPEN -> INVESTIGATING -> MITIGATED -> RESOLVED)
- **Retrieve runbooks** for guided remediation
- **Analyze screenshots** of monitoring dashboards and error logs
- **Proactively alert** when services degrade -- before you even ask
- **Handle interruptions** naturally -- speak while the agent is talking and it pivots immediately

The agent has a distinct personality: it speaks like a senior SRE -- concise, action-oriented, and always citing which tool provided the data. It never fabricates metrics.

## Architecture

The architecture is intentionally simple enough to deploy on Cloud Run as a single service:

```
Browser (Voice / Text / Camera)
    | WebSocket (bidirectional)
FastAPI Backend (Google Cloud Run)
    | Google ADK Runner.run_live() + LiveRequestQueue
Gemini 2.5 Flash Native Audio (Live API)
    | Tool Calls
    +-- check_service_health
    +-- create_incident / get_open_incidents / update_incident_status
    +-- get_runbook
    +-- google_search (grounding)
    | Persistence
Google Cloud Firestore
```

**Interactive architecture diagram**: [View live](https://opsvoice-942622207688.us-central1.run.app/static/architecture.html)

### Technology stack
- **Gemini 2.5 Flash Native Audio** for bidirectional audio streaming with sub-second latency
- **Google ADK** for live agent orchestration and tool execution
- **FastAPI** WebSocket backend on **Cloud Run** (3600s timeout, 0-2 auto-scaling)
- **Firestore** for persistent incident storage across sessions
- **Secret Manager** for secure API key management
- **Terraform** + PowerShell script for fully automated infrastructure provisioning

## Key implementation details

### Adaptive Voice Activity Detection
Browser microphone audio is captured via AudioWorklet, downsampled to 16 kHz PCM, and sent over WebSocket. Voice Activity Detection uses noise floor estimation with an adaptive threshold multiplier (2.5x), which works across different microphones and environments. Fixed thresholds fail in noisy rooms -- adaptive ones adjust automatically.

### Barge-in (natural interruption)
When the user speaks while the agent is talking, the frontend immediately flushes the audio playback queue and sends an `activity_start` signal so Gemini knows to stop generating and listen. This is critical for the Live Agents category -- the interaction must feel like a real conversation, not a turn-based chatbot.

### Proactive alerts
The backend runs a background health simulation that evolves service metrics over time. When a service transitions to "degraded" or "critical", an alert is broadcast to all connected clients via WebSocket, and the agent announces it by voice. This demonstrates proactive agent behavior -- pushing information instead of waiting for queries.

### Hallucination prevention
The agent's system prompt includes strict grounding rules: only state facts verifiable from tool outputs or Google Search. If unsure, search first. Never fabricate metrics. The `google_search` tool provides real-time grounding for unfamiliar errors and CVEs.

### Vision
Camera frames are sampled once per second as JPEG and sent to Gemini for analysis through the same WebSocket connection. Users can also drag-and-drop screenshots of Grafana dashboards or terminal output for multimodal troubleshooting.

### Firestore with fallback
Incidents are persisted to Firestore when cloud credentials are available. Locally, the tool layer falls back to in-session state so development works without cloud setup.

## Automated deployment

Everything is Infrastructure-as-Code:
- **Terraform** provisions Cloud Run, Firestore, Secret Manager, Artifact Registry, and IAM
- **deploy-gcp.ps1** performs one-click build, push, deploy, and health check
- Templates (`.env.example`, `terraform.tfvars.example`) included for easy reproduction

## Lessons learned

1. **Gemini's native audio is remarkable.** It genuinely feels like talking to a colleague, not a bot. The sub-second latency makes the conversation flow naturally.

2. **Google ADK simplifies streaming agents dramatically.** `Runner.run_live()` with `LiveRequestQueue` handles the complexity of bidirectional streaming with tool calling. Building this from scratch would have been significantly harder.

3. **VAD is make-or-break for voice UX.** Bad Voice Activity Detection makes the whole experience feel broken. Adaptive thresholds that estimate noise floor beat fixed thresholds every time.

4. **Proactive behavior changes everything.** When the agent pushes alerts instead of waiting for queries, it feels qualitatively different -- less like a tool and more like a teammate watching your back.

5. **Streaming UX is unforgiving.** Every millisecond of latency matters. Chat UX hides latency behind "typing..." indicators, but voice UX exposes every delay.

## Try it yourself

- **Live app**: [opsvoice-942622207688.us-central1.run.app](https://opsvoice-942622207688.us-central1.run.app/)
- **Source code**: [github.com/reachtokarthikr/OpsVoice](https://github.com/reachtokarthikr/OpsVoice)
- **Interactive architecture**: [Architecture Diagram](https://opsvoice-942622207688.us-central1.run.app/static/architecture.html)
- **Demo video**: [Watch on YouTube](https://youtu.be/lmyWZWknFn0)
- **Blog post**: [Read on Medium](https://medium.com/@reachtokarthikr/how-i-built-opsvoice-for-the-gemini-live-agent-challenge-f118cacb23a8)
