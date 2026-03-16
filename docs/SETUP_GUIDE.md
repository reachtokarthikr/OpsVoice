# OpsVoice Setup Guide

> **Live deployment**: [opsvoice-942622207688.us-central1.run.app](https://opsvoice-942622207688.us-central1.run.app/)

## Goal

Use this guide to move from a clean clone to a locally running application, then to a Cloud Run deployment.

## 1. Local prerequisites
- Python 3.11+
- Google Cloud project with billing enabled
- Gemini API key from AI Studio
- Docker
- Terraform 1.6+
- `gcloud` CLI

## 2. Environment setup

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Edit `.env` with your project ID and API key.

## 3. Local run

```bash
python -m app.frontend
```

Open `http://127.0.0.1:7860`.

Local smoke checks:
- `GET /health` returns `status: ok`
- The browser UI connects and obtains a session
- Text prompts return streamed ADK events
- Microphone and camera permissions work in the browser

## 4. Docker run

```bash
docker build -t opsvoice:latest .
docker run --rm -p 8080:8080 --env-file .env opsvoice:latest
```

## 5. Terraform deployment

### 5.1 Prepare variables

```bash
copy terraform\terraform.tfvars.example terraform\terraform.tfvars
```

Update at least:
- `project_id`
- `image`
- `gemini_api_key` if you want Terraform to seed Secret Manager

### 5.2 Build and push the image

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud auth configure-docker us-central1-docker.pkg.dev

docker build -t us-central1-docker.pkg.dev/YOUR_PROJECT_ID/opsvoice/opsvoice:latest .
docker push us-central1-docker.pkg.dev/YOUR_PROJECT_ID/opsvoice/opsvoice:latest
```

### 5.3 Apply Terraform

```bash
cd terraform
terraform init
terraform plan
terraform apply
```

## 6. Verify deployment
- Open https://opsvoice-942622207688.us-central1.run.app/ and test voice interaction
- Verify WebSocket connection works over WSS
- Confirm Firestore writes succeed in the deployed environment
- Check the interactive architecture diagram at `/static/architecture.html`
