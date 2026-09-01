output "vpc_id" {
  value = aws_vpc.main.id
}

output "build_subnet_ids" {
  description = "Subnets build tasks run in. Public unless network_mode is private."
  value       = local.private ? aws_subnet.private[*].id : aws_subnet.public[*].id
}

output "build_security_group_id" {
  description = "Zero inbound rules; egress on 443 and 80 only."
  value       = aws_security_group.build.id
}

output "network_mode" {
  value = var.network_mode
}
