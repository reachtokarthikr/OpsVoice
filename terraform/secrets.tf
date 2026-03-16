resource "google_secret_manager_secret" "gemini_api_key" {
  depends_on = [google_project_service.enabled]

  secret_id = var.gemini_api_key_secret_name

  replication {
    auto {}
  }

  labels = local.labels
}

resource "google_secret_manager_secret_version" "gemini_api_key" {
  count = var.gemini_api_key == "" ? 0 : 1

  secret      = google_secret_manager_secret.gemini_api_key.id
  secret_data = var.gemini_api_key
}
