output "state_bucket" {
  description = "Bucket every other stack stores its Terraform state in. Copy this into each stack's backend.tf."
  value       = aws_s3_bucket.state.id
}

output "region" {
  description = "Primary region."
  value       = var.region
}

output "account_id" {
  description = "AWS account this was applied to."
  value       = local.account_id
}

output "billing_alerts_topic_arn" {
  description = "SNS topic for billing alarms. Confirm the email subscription from your inbox."
  value       = aws_sns_topic.billing_alerts.arn
}
