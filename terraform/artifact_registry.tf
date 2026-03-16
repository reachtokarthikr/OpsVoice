resource "google_artifact_registry_repository" "opsvoice" {
  depends_on = [google_project_service.enabled]

  location      = var.region
  repository_id = var.app_name
  description   = "Docker images for OpsVoice"
  format        = "DOCKER"
  labels        = local.labels
}
