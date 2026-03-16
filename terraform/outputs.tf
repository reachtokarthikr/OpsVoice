output "service_url" {
  description = "Cloud Run service URL."
  value       = google_cloud_run_v2_service.opsvoice.uri
}

output "service_account_email" {
  description = "Runtime service account."
  value       = google_service_account.opsvoice.email
}

output "artifact_registry_repository" {
  description = "Artifact Registry repository path."
  value       = google_artifact_registry_repository.opsvoice.repository_id
}
