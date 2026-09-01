variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "deployment-platform"
}

variable "region" {
  description = "Primary region. Note that ACM for CloudFront is always us-east-1."
  type        = string
  default     = "ap-south-1"
}

variable "state_bucket" {
  description = "Bucket holding the data stack's state, from the bootstrap output."
  type        = string
  default     = "deployment-platform-tfstate-220438080921"
}

variable "domain_name" {
  description = <<-EOT
    Apex domain, e.g. "example.com". Leave empty to run on the CloudFront
    default domain using path mode (/d/<deploymentId>/...), which needs no DNS
    and no certificate. Setting it adds the ACM certificate, the wildcard
    alias, and Route53 records. The zone must already exist in this account.
  EOT
  type        = string
  default     = ""
}

variable "price_class" {
  description = <<-EOT
    PriceClass_100 is cheapest (North America + Europe only). PriceClass_200
    adds India and most of Asia — worth it when the audience is there, and
    irrelevant to the bill at this traffic level given the 1 TB free tier.
  EOT
  type        = string
  default     = "PriceClass_200"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be PriceClass_100, PriceClass_200 or PriceClass_All."
  }
}
