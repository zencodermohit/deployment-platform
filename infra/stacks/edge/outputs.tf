output "distribution_id" {
  description = "Needed for cache invalidations, though immutable prefixes mean you should never need one."
  value       = aws_cloudfront_distribution.main.id
}

output "distribution_domain_name" {
  description = "The *.cloudfront.net domain. Deployments are reachable at https://<this>/d/<deploymentId>/"
  value       = aws_cloudfront_distribution.main.domain_name
}

output "key_value_store_arn" {
  description = "Routing table the edge function reads."
  value       = aws_cloudfront_key_value_store.routes.arn
}

output "key_value_store_id" {
  description = "Pass to `aws cloudfront-keyvaluestore put-key --kvs-arn`."
  value       = aws_cloudfront_key_value_store.routes.id
}

output "custom_domain_enabled" {
  value = local.use_custom_domain
}

output "certificate_arn" {
  description = "ACM certificate, when a custom domain is configured."
  value       = local.use_custom_domain ? aws_acm_certificate.main[0].arn : null
}
