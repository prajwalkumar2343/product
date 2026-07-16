variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "container_image" {
  type = string
}

variable "public_api_url" {
  type = string
}

variable "model_base_url" {
  type    = string
  default = "https://api.openai.com/v1"
}

variable "model_name" {
  type = string
}

variable "api_max_instances" {
  type    = number
  default = 20
}

variable "runner_max_instances" {
  type    = number
  default = 10
}

variable "session_hmac_secret_version" {
  type = string
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.session_hmac_secret_version))
    error_message = "Use an immutable numeric Secret Manager version."
  }
}

variable "steel_api_key_version" {
  type = string
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.steel_api_key_version))
    error_message = "Use an immutable numeric Secret Manager version."
  }
}

variable "model_api_key_version" {
  type = string
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.model_api_key_version))
    error_message = "Use an immutable numeric Secret Manager version."
  }
}

variable "turnstile_secret_version" {
  type = string
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.turnstile_secret_version))
    error_message = "Use an immutable numeric Secret Manager version."
  }
}
