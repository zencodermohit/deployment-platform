variable "project" {
  description = "Name prefix. Also the table name."
  type        = string
  default     = "deployment-platform"
}

variable "region" {
  description = "Primary region."
  type        = string
  default     = "ap-south-1"
}

variable "state_bucket" {
  description = "Bucket holding the data stack's state."
  type        = string
  default     = "deployment-platform-tfstate-220438080921"
}

variable "deletion_protection" {
  description = <<-EOT
    Blocks `terraform destroy` on the main table. Off while the schema is still
    moving; turn on once real deployments are in it.
  EOT
  type        = bool
  default     = false
}

variable "create_test_table" {
  description = "A throwaway table for integration tests, so they never touch real data."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

variable "api_enabled" {
  description = "Set false to take the public endpoint down without destroying anything else."
  type        = bool
  default     = true
}

variable "dev_user_id" {
  description = <<-EOT
    Stand-in caller identity until real sessions arrive in M6. Every request is
    treated as this user. Authorization is still enforced — ownership is checked
    on every project-scoped route — but there is no authentication.
  EOT
  type        = string
  default     = "usr_dev00000000000000000000000000"
}

variable "allow_debug_auth" {
  description = <<-EOT
    Honour an X-Debug-User header, so multi-user authorization can be exercised
    with curl before sessions exist. Leave OFF unless actively demonstrating it.
  EOT
  type        = bool
  default     = false
}

variable "deployment_domain" {
  description = "Custom domain for deployment URLs. Empty means CloudFront path mode."
  type        = string
  default     = ""
}

variable "build_timeout_sec" {
  description = "Build wall-clock limit; also sets each deployment's sweeper deadline."
  type        = number
  default     = 600
}

variable "api_rate_limit" {
  description = "Sustained requests per second across the API."
  type        = number
  default     = 5
}

variable "api_burst_limit" {
  description = "Burst capacity."
  type        = number
  default     = 20
}

variable "cors_allow_origins" {
  description = "Origins permitted to call the API from a browser."
  type        = list(string)
  default     = ["http://localhost:5173"]
}
