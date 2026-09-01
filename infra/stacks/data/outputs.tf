output "artifacts_bucket" {
  description = "Bucket holding built deployments."
  value       = aws_s3_bucket.artifacts.id
}

output "artifacts_bucket_arn" {
  value = aws_s3_bucket.artifacts.arn
}

output "artifacts_bucket_regional_domain_name" {
  description = "CloudFront origin domain for the artifacts bucket."
  value       = aws_s3_bucket.artifacts.bucket_regional_domain_name
}

output "sources_bucket" {
  description = "Bucket holding short-lived source archives."
  value       = aws_s3_bucket.sources.id
}

output "sources_bucket_arn" {
  value = aws_s3_bucket.sources.arn
}

output "kms_key_arn" {
  description = "Customer-managed key for sources and (from M3) deployment state."
  value       = aws_kms_key.main.arn
}
