output "api_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "runner_url" {
  value = google_cloud_run_v2_service.runner.uri
}

output "task_invoker_service_account" {
  value = google_service_account.tasks.email
}

output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "sdk_bucket" {
  value = google_storage_bucket.sdk.name
}
