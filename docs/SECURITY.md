# OpsVoice — Security Practices

> Security controls and best practices for the OpsVoice deployment.

---

## 1. Secret Management

### 1.1 API Key Storage

All sensitive credentials are stored in **Google Cloud Secret Manager** — never in source code, environment files, or Docker images.

```bash
# Store the Gemini API key
echo -n "YOUR_KEY" | gcloud secrets create gemini-api-key --data-file=-

# Cloud Run mounts it as an environment variable at runtime
--set-secrets="GOOGLE_API_KEY=gemini-api-key:latest"
```

### 1.2 What is Never Committed

| File/Pattern | Contains | Protected By |
|-------------|----------|-------------|
| `.env` | Local API keys | `.gitignore` |
| `terraform.tfvars` | Project ID, API keys | `.gitignore` |
| `*.tfstate` | Infrastructure state with secrets | `.gitignore` |
| `serviceaccount.json` | GCP credentials | `.gitignore` |

### 1.3 Environment Variable Hygiene

```bash
# .env.example — committed (template only, no real values)
GOOGLE_API_KEY=your-gemini-api-key-here
GOOGLE_CLOUD_PROJECT=your-project-id

# .env — NEVER committed (contains real values)
GOOGLE_API_KEY=AIzaSy...actual-key
```

---

## 2. Identity & Access Management (IAM)

### 2.1 Service Account (Least Privilege)

OpsVoice uses a dedicated service account (`opsvoice-sa`) with **only the roles it needs**:

| Role | Purpose | Scope |
|------|---------|-------|
| `roles/datastore.user` | Read/write Firestore incidents | Project-level |
| `roles/logging.logWriter` | Write structured logs | Project-level |
| `roles/secretmanager.secretAccessor` | Read `gemini-api-key` secret | Secret-level |

**Not granted** (by design):
- `roles/owner` or `roles/editor` — too broad
- `roles/datastore.owner` — doesn't need to create/delete databases
- `roles/run.admin` — only the deployment pipeline needs this

### 2.2 Terraform IAM Definitions

```hcl
# Dedicated service account
resource "google_service_account" "run_sa" {
  account_id   = "opsvoice-sa"
  display_name = "OpsVoice Cloud Run Service Account"
}

# Only Firestore read/write
resource "google_project_iam_member" "firestore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.run_sa.email}"
}

# Only log writing
resource "google_project_iam_member" "log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.run_sa.email}"
}

# Only access to the specific secret
resource "google_secret_manager_secret_iam_member" "run_access" {
  secret_id = google_secret_manager_secret.gemini_api_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run_sa.email}"
}
```

---

## 3. Container Security

### 3.1 Non-Root Execution

The Dockerfile creates and runs as a non-root user:

```dockerfile
RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser
# ... copy files ...
USER appuser
```

### 3.2 Minimal Base Image

Using `python:3.13-slim` — minimal attack surface compared to full images.

### 3.3 Multi-Stage Build

Build dependencies (gcc, libffi-dev) are only in the builder stage. The production image contains only runtime dependencies.

### 3.4 No Secrets in Image

Docker images contain zero secrets. All sensitive data is injected at runtime via Cloud Run secret mounts.

---

## 4. Network Security

### 4.1 CORS Configuration

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("ALLOWED_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**Production recommendation**: Set `ALLOWED_ORIGINS` to your specific domain instead of `*`.

### 4.2 HTTPS

Cloud Run provides HTTPS termination automatically — all traffic between the browser and Cloud Run is encrypted via TLS 1.3.

### 4.3 WebSocket Security

WebSocket connections use `wss://` (encrypted) when deployed on Cloud Run. The connection is authenticated by Cloud Run's IAM (`allUsers` for public access in hackathon context).

---

## 5. Data Security

### 5.1 Data at Rest

- Firestore data is encrypted at rest by Google Cloud by default (AES-256)
- Secret Manager secrets are encrypted with Google-managed keys

### 5.2 Data in Transit

- Browser ↔ Cloud Run: TLS 1.3 (HTTPS/WSS)
- Cloud Run ↔ Gemini API: TLS (Google internal network)
- Cloud Run ↔ Firestore: TLS (Google internal network)

### 5.3 Data Retention

- Firestore incidents: Persisted until explicitly deleted
- Session data: In-memory only (lost on container restart)
- Audio/video: Not stored — streamed and discarded
- Logs: Retained per Cloud Logging default (30 days)

### 5.4 No PII Storage

OpsVoice does not store personally identifiable information. Incident records contain service names and technical descriptions only. Audio streams are processed in real-time and never persisted.

---

## 6. Input Validation

### 6.1 Tool Input Validation

All tool functions validate inputs before processing:

```python
def create_incident(title: str, service: str, severity: str, description: str, ...):
    """Severity must be one of P1, P2, P3, P4."""
    # ADK handles type validation via function signatures
    # Additional validation for enum values
    if severity not in ("P1", "P2", "P3", "P4"):
        return {"error": "Invalid severity. Must be P1, P2, P3, or P4."}
```

### 6.2 Image Validation

```python
def validate_image(image_data):
    if not image_data:
        return None, "Camera feed not available"
    if len(image_data) < 1000:  # Too small/dark
        return None, "Image too dark or small — adjust camera"
    return image_data, None
```

---

## 7. Grounding & Hallucination Prevention

### 7.1 System Prompt Rules

```
RULES:
- Only state facts you can verify from tool outputs or Google Search
- If unsure, say "I'm not sure about that — let me search"
- Never fabricate metrics — if tools don't return data, say so
- Always cite your source when giving specific information
```

### 7.2 Google Search Grounding

The `google_search` tool is included in the agent's tool list. When the agent encounters unfamiliar error messages or needs documentation, it searches Google and uses real sources — preventing hallucination of commands or configuration details.

---

## 8. Security Checklist

- [x] API keys in Secret Manager (not in code)
- [x] `.env` and `terraform.tfvars` in `.gitignore`
- [x] Dedicated service account with least-privilege IAM
- [x] Non-root Docker container user
- [x] Multi-stage Docker build (no build tools in prod)
- [x] HTTPS enforced via Cloud Run
- [x] CORS configured (restrict in production)
- [x] No PII stored in Firestore
- [x] Audio/video not persisted
- [x] Input validation on all tool functions
- [x] Grounding via Google Search to prevent hallucination
- [x] Structured logging (no secrets in logs)
