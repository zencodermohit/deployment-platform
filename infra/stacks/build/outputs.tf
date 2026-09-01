output "queue_url" {
  value = aws_sqs_queue.builds.url
}

output "queue_arn" {
  value = aws_sqs_queue.builds.arn
}

output "dlq_url" {
  value = aws_sqs_queue.dlq.url
}

output "ecr_repository_url" {
  description = "docker push here, then bump image_tag."
  value       = aws_ecr_repository.builder.repository_url
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "task_definition" {
  value = aws_ecs_task_definition.builder.family
}

output "build_log_group" {
  value = aws_cloudwatch_log_group.builds.name
}
