output "table_name" {
  description = "Set as TABLE_NAME for the API and workers."
  value       = aws_dynamodb_table.platform.name
}

output "table_arn" {
  value = aws_dynamodb_table.platform.arn
}

output "test_table_name" {
  description = "Set as TABLE_NAME when running integration tests."
  value       = var.create_test_table ? aws_dynamodb_table.test[0].name : null
}

output "api_url" {
  description = "Base URL of the control-plane API."
  value       = var.api_enabled ? aws_apigatewayv2_api.main[0].api_endpoint : null
}

output "api_function_name" {
  value = aws_lambda_function.api.function_name
}

output "dev_user_id" {
  description = "The stand-in caller. Every request is this user until M6."
  value       = var.dev_user_id
}

output "test_queue_url" {
  description = "Consumer-less queue for handler tests."
  value       = var.create_test_table ? aws_sqs_queue.test_builds[0].url : null
}
