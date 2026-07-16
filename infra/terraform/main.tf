locals {
  services = toset([
    "artifactregistry.googleapis.com",
    "cloudtasks.googleapis.com",
    "cloudscheduler.googleapis.com",
    "firestore.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "iamcredentials.googleapis.com"
  ])
}

resource "google_project_service" "required" {
  for_each           = local.services
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "api" {
  account_id   = "product-demo-api"
  display_name = "Product demo API"
}
resource "google_service_account" "runner" {
  account_id   = "product-demo-runner"
  display_name = "Product demo runner"
}
resource "google_service_account" "tasks" {
  account_id   = "product-demo-tasks"
  display_name = "Product demo task invoker"
}

resource "google_project_iam_member" "api_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.api.email}"
}
resource "google_project_iam_member" "runner_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runner.email}"
}
resource "google_project_iam_member" "api_tasks" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.api.email}"
}
resource "google_service_account_iam_member" "api_can_mint_task_token" {
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret" "secret" {
  for_each  = toset(["session-hmac-secret", "steel-api-key", "model-api-key", "turnstile-secret"])
  secret_id = each.key
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_iam_member" "api_secret" {
  for_each  = toset(["session-hmac-secret", "turnstile-secret"])
  secret_id = google_secret_manager_secret.secret[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}
resource "google_secret_manager_secret_iam_member" "runner_secret" {
  for_each  = toset(["session-hmac-secret", "steel-api-key", "model-api-key"])
  secret_id = google_secret_manager_secret.secret[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runner.email}"
}

resource "google_firestore_database" "database" {
  project                     = var.project_id
  name                        = "product-demo"
  location_id                 = var.region
  type                        = "FIRESTORE_NATIVE"
  delete_protection_state     = "DELETE_PROTECTION_ENABLED"
  deletion_policy             = "ABANDON"
  app_engine_integration_mode = "DISABLED"
  depends_on                  = [google_project_service.required]
}

resource "google_firestore_index" "expired_sessions" {
  database   = google_firestore_database.database.name
  collection = "sessions"
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "expiresAt"
    order      = "ASCENDING"
  }
  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
}

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "product-demo"
  format        = "DOCKER"
  depends_on    = [google_project_service.required]
}

resource "google_storage_bucket" "sdk" {
  name                        = "${var.project_id}-product-demo-sdk"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "inherited"
  force_destroy               = false
  versioning {
    enabled = true
  }
  cors {
    origin          = ["*"]
    method          = ["GET", "HEAD"]
    response_header = ["Content-Type", "ETag"]
    max_age_seconds = 3600
  }
  depends_on = [google_project_service.required]
}

resource "google_storage_bucket_iam_member" "public_sdk" {
  bucket = google_storage_bucket.sdk.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

resource "google_cloud_tasks_queue" "sessions" {
  name     = "demo-sessions"
  location = var.region
  rate_limits {
    max_concurrent_dispatches = var.runner_max_instances
    max_dispatches_per_second = 10
  }
  retry_config {
    max_attempts  = 5
    min_backoff   = "2s"
    max_backoff   = "60s"
    max_doublings = 5
  }
  depends_on = [google_project_service.required]
}

resource "google_cloud_run_v2_service" "runner" {
  name                = "product-demo-runner"
  location            = var.region
  deletion_protection = true
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  template {
    service_account                  = google_service_account.runner.email
    timeout                          = "1200s"
    max_instance_request_concurrency = 1
    scaling {
      min_instance_count = 0
      max_instance_count = var.runner_max_instances
    }
    containers {
      image   = var.container_image
      command = ["node", "packages/server/dist/runner.js"]
      resources {
        limits            = { cpu = "1", memory = "1Gi" }
        cpu_idle          = false
        startup_cpu_boost = true
      }
      env {
        name  = "SERVICE_ROLE"
        value = "runner"
      }
      env {
        name  = "PUBLIC_API_URL"
        value = var.public_api_url
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "GCP_REGION"
        value = var.region
      }
      env {
        name  = "FIRESTORE_DATABASE"
        value = google_firestore_database.database.name
      }
      env {
        name  = "TASK_QUEUE"
        value = google_cloud_tasks_queue.sessions.name
      }
      env {
        name  = "RUNNER_URL"
        value = "https://placeholder.invalid"
      }
      env {
        name  = "MODEL_BASE_URL"
        value = var.model_base_url
      }
      env {
        name  = "MODEL_NAME"
        value = var.model_name
      }
      env {
        name = "SESSION_HMAC_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["session-hmac-secret"].secret_id
            version = var.session_hmac_secret_version
          }
        }
      }
      env {
        name = "STEEL_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["steel-api-key"].secret_id
            version = var.steel_api_key_version
          }
        }
      }
      env {
        name = "MODEL_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["model-api-key"].secret_id
            version = var.model_api_key_version
          }
        }
      }
      startup_probe {
        http_get { path = "/healthz" }
        initial_delay_seconds = 1
        period_seconds        = 2
        failure_threshold     = 15
      }
    }
  }
  depends_on = [google_project_service.required, google_secret_manager_secret_iam_member.runner_secret]
}

resource "google_cloud_run_v2_service_iam_member" "tasks_invoke_runner" {
  name     = google_cloud_run_v2_service.runner.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.tasks.email}"
}

resource "google_cloud_scheduler_job" "session_sweeper" {
  name      = "product-demo-session-sweeper"
  region    = var.region
  schedule  = "* * * * *"
  time_zone = "Etc/UTC"
  retry_config {
    retry_count          = 3
    min_backoff_duration = "5s"
    max_backoff_duration = "60s"
  }
  http_target {
    uri         = "${google_cloud_run_v2_service.runner.uri}/internal/sweep"
    http_method = "POST"
    headers     = { "X-CloudScheduler" = "true", "Content-Type" = "application/json" }
    oidc_token {
      service_account_email = google_service_account.tasks.email
      audience              = google_cloud_run_v2_service.runner.uri
    }
  }
  depends_on = [google_cloud_run_v2_service_iam_member.tasks_invoke_runner]
}

resource "google_cloud_run_v2_service" "api" {
  name                = "product-demo-api"
  location            = var.region
  deletion_protection = true
  ingress             = "INGRESS_TRAFFIC_ALL"
  template {
    service_account                  = google_service_account.api.email
    timeout                          = "60s"
    max_instance_request_concurrency = 80
    scaling {
      min_instance_count = 0
      max_instance_count = var.api_max_instances
    }
    containers {
      image = var.container_image
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      env {
        name  = "SERVICE_ROLE"
        value = "api"
      }
      env {
        name  = "PUBLIC_API_URL"
        value = var.public_api_url
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "GCP_REGION"
        value = var.region
      }
      env {
        name  = "FIRESTORE_DATABASE"
        value = google_firestore_database.database.name
      }
      env {
        name  = "TASK_QUEUE"
        value = google_cloud_tasks_queue.sessions.name
      }
      env {
        name  = "RUNNER_URL"
        value = google_cloud_run_v2_service.runner.uri
      }
      env {
        name  = "TASK_INVOKER_SERVICE_ACCOUNT"
        value = google_service_account.tasks.email
      }
      env {
        name  = "STEEL_API_KEY"
        value = "unused-by-api"
      }
      env {
        name  = "MODEL_API_KEY"
        value = "unused-by-api"
      }
      env {
        name  = "MODEL_NAME"
        value = var.model_name
      }
      env {
        name = "SESSION_HMAC_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["session-hmac-secret"].secret_id
            version = var.session_hmac_secret_version
          }
        }
      }
      env {
        name = "TURNSTILE_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["turnstile-secret"].secret_id
            version = var.turnstile_secret_version
          }
        }
      }
      startup_probe {
        http_get { path = "/healthz" }
        initial_delay_seconds = 1
        period_seconds        = 2
        failure_threshold     = 15
      }
    }
  }
  depends_on = [google_project_service.required, google_secret_manager_secret_iam_member.api_secret]
}

resource "google_cloud_run_v2_service_iam_member" "public_api" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
