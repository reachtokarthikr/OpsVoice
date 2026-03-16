# OpsVoice API Reference

## HTTP Endpoints

### `GET /`
Serves the browser client from `static/index.html`.

### `GET /health`
Returns a small health payload.

Example response:

```json
{
  "status": "ok",
  "app": "opsvoice",
  "model": "gemini-2.5-flash-native-audio-preview-12-2025",
  "google_api_key_configured": true,
  "project_id": "my-project"
}
```

### `GET /session`
Creates a local session payload for the browser client.

Example response:

```json
{
  "user_id": "local-user",
  "session_id": "f7d0a15f-7817-4d16-995d-1c3d4474d399"
}
```

## WebSocket Endpoint

### `WS /ws/{user_id}/{session_id}`
Bi-directional streaming endpoint for audio, image, and text events.

### Browser -> server messages

Binary frames:
- Raw `audio/pcm;rate=16000`

JSON text frames:

```json
{ "type": "text", "text": "Check payment-api health" }
```

```json
{ "type": "image", "mimeType": "image/jpeg", "data": "<base64>" }
```

```json
{ "type": "activity_start" }
```

```json
{ "type": "activity_end" }
```

### Server -> browser messages
The server forwards ADK event payloads as JSON. Useful fields in the current browser client:
- `content.parts[].text`
- `content.parts[].inlineData`
- `actions.inputAudioTranscription.text`
- `actions.outputAudioTranscription.text`

## Tool Summary

### `check_service_health(service)`
Returns a scaffold service health snapshot.

### `create_incident(title, service, severity, description)`
Creates an incident in Firestore when configured, otherwise in session state.

### `get_open_incidents(service=None, severity=None)`
Returns open incidents from the current session state.

### `update_incident_status(incident_id, status, resolution_notes="")`
Updates incident status.

### `get_runbook(service, issue)`
Returns a scaffold runbook when one exists.

### `google_search(query)`
Built-in ADK grounding tool. Keep source attribution in the final UI and demo.
