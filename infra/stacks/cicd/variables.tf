variable "project" {
  type    = string
  default = "deployment-platform"
}

variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "github_repository" {
  description = <<-EOT
    "owner/repo" of the GitHub repository allowed to assume the CI roles.

    Empty creates nothing — there is no repository yet. Set it once the project
    is pushed, and the trust policy pins these roles to that repository alone.
    Leaving it as a wildcard would let ANY repository on GitHub assume them.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.github_repository == "" || can(regex("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "github_repository must be \"owner/repo\"."
  }
}
