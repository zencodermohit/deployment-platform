variable "project" {
  type    = string
  default = "deployment-platform"
}

variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "state_bucket" {
  type    = string
  default = "deployment-platform-tfstate-220438080921"
}

variable "image_tag" {
  description = "Builder image tag to run. Bump to roll out a new builder."
  type        = string
  default     = "latest"
}

variable "task_cpu" {
  description = "Fargate CPU units. 1024 = 1 vCPU."
  type        = number
  default     = 1024
}

variable "task_memory" {
  description = "Fargate memory in MB."
  type        = number
  default     = 2048
}

variable "build_timeout_sec" {
  description = "Build wall clock. Enforced twice: an in-container watchdog and an external stop."
  type        = number
  default     = 600
}

variable "max_archive_bytes" {
  description = "Compressed repository cap, checked before any task is started."
  type        = number
  default     = 104857600
}

variable "max_concurrent_builds" {
  description = <<-EOT
    Hard ceiling on simultaneous builds, enforced by the SQS event source. This
    is the primary bound on how fast a malicious repository could spend money
    (threat T8) — not a performance tuning knob.
  EOT
  type        = number
  default     = 2

  validation {
    condition     = var.max_concurrent_builds >= 2 && var.max_concurrent_builds <= 20
    error_message = "max_concurrent_builds must be between 2 and 20."
  }
}
