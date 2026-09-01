output "plan_role_arn" {
  description = "Set as the AWS_PLAN_ROLE_ARN repository secret."
  value       = local.enabled ? aws_iam_role.plan[0].arn : null
}

output "deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN repository secret."
  value       = local.enabled ? aws_iam_role.deploy[0].arn : null
}
