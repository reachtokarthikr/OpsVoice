terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  service_name = var.app_name
  labels = {
    app        = var.app_name
    managed_by = "terraform"
    track      = "gemini-live-agent-challenge"
  }
}

resource "google_project_service" "enabled" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "firestore.googleapis.com",
    "logging.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
  ])

  project = var.project_id
  service = each.value
}
