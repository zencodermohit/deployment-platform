variable "project" {
  type    = string
  default = "deployment-platform"
}

variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "alert_email" {
  description = "Where operational alarms go. Empty creates the topic without a subscriber."
  type        = string
  default     = ""
}
