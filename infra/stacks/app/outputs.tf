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
