resource "google_firestore_database" "default" {
  depends_on = [google_project_service.enabled]

  project                     = var.project_id
  name                        = "(default)"
  location_id                 = var.firestore_location
  type                        = "FIRESTORE_NATIVE"
  delete_protection_state     = "DELETE_PROTECTION_DISABLED"
  deletion_policy             = "DELETE"
  app_engine_integration_mode = "DISABLED"
}
