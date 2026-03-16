variable "project_id" {
  description = "Google Cloud project ID."
  type        = string
}

variable "region" {
  description = "Cloud Run and Artifact Registry region."
  type        = string
  default     = "us-central1"
}

variable "firestore_location" {
  description = "Firestore database location."
  type        = string
  default     = "nam5"
}

variable "app_name" {
  description = "Application name."
  type        = string
  default     = "opsvoice"
}

variable "image" {
  description = "Container image URI for the Cloud Run service."
  type        = string
}

variable "allow_unauthenticated" {
  description = "Expose the Cloud Run service publicly for the hackathon demo."
  type        = bool
  default     = true
}

variable "min_instances" {
  description = "Minimum Cloud Run instances."
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Maximum Cloud Run instances."
  type        = number
  default     = 2
}

variable "timeout_seconds" {
  description = "Request timeout in seconds for long-lived WebSocket sessions."
  type        = number
  default     = 3600
}

variable "gemini_api_key_secret_name" {
  description = "Secret Manager secret name for the Gemini API key."
  type        = string
  default     = "opsvoice-gemini-api-key"
}

variable "gemini_api_key" {
  description = "Optional Gemini API key to seed Secret Manager. Leave empty to create the secret without a version."
  type        = string
  sensitive   = true
  default     = ""
}

variable "opsvoice_model" {
  description = "Model name passed to the application."
  type        = string
  default     = "gemini-2.5-flash-native-audio-preview-12-2025"
}
