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
