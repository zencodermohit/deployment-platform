variable "project" {
  description = "Name prefix for every resource. Also forms the state bucket name."
  type        = string
  default     = "deployment-platform"
}

variable "region" {
  description = "Primary region. Everything except ACM-for-CloudFront lives here."
  type        = string
  default     = "ap-south-1"
}

variable "alert_email" {
  description = "Where budget and anomaly alerts are sent. No default on purpose — set it in terraform.tfvars."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be a valid email address."
  }
}

variable "monthly_budget_usd" {
  description = "Monthly spend the alert percentages are measured against."
  type        = number
  default     = 25

  validation {
    condition     = var.monthly_budget_usd > 0 && var.monthly_budget_usd <= 500
    error_message = "monthly_budget_usd must be between 1 and 500 — this is a portfolio project."
  }
}

variable "budget_alert_percentages" {
  description = "Percentages of the monthly budget that trigger an actual-spend alert."
  type        = list(number)
  default     = [50, 80, 100]
}

variable "billing_alarm_usd" {
  description = "Absolute estimated-charges figure that trips the CloudWatch alarm."
  type        = number
  default     = 20
}

variable "anomaly_monitor_arn" {
  description = <<-EOT
    ARN of an existing dimensional cost-anomaly monitor to attach alerts to.
    AWS allows only one per account and auto-creates a "Default-Services-Monitor"
    in most accounts, so creating a second one fails. Leave empty only in an
    account that genuinely has none.

      aws ce get-anomaly-monitors --query 'AnomalyMonitors[].MonitorArn'
  EOT
  type        = string
  default     = ""
}

variable "anomaly_threshold_usd" {
  description = "Minimum anomaly impact worth an email. Below this it is noise."
  type        = number
  default     = 5
}
