variable "project" {
  type    = string
  default = "deployment-platform"
}

variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "network_mode" {
  description = <<-EOT
    "public"  — build tasks in public subnets, no NAT. $0/month. The default.
    "private" — the textbook topology: private subnets behind a NAT Gateway,
                with VPC flow logs. ~$32/month, so stand it up, capture the
                evidence, and destroy it (docs/06-cost-model.md, Tier B).
  EOT
  type        = string
  default     = "public"

  validation {
    condition     = contains(["public", "private"], var.network_mode)
    error_message = "network_mode must be \"public\" or \"private\"."
  }
}

variable "flow_log_bucket_arn" {
  description = "Destination for VPC flow logs. Only used when network_mode is private."
  type        = string
  default     = ""
}
