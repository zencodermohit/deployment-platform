/**
 * M4 — Network: where the untrusted build plane runs.
 *
 * Public subnets with public IPs, and a security group with ZERO inbound rules.
 * That is not a compromise, it is the deliberate choice in ADR-0007:
 *
 *   - A NAT Gateway costs ~$32/month idle, a third of the credit pool.
 *   - Interface endpoints cost ~$7.20/month each; the four needed cost MORE
 *     than the NAT they would replace, and npm is still unreachable without one.
 *   - A public IP with no inbound rules is not reachable. Nothing can initiate
 *     a connection to it.
 *   - The build subnet has no route to anything internal because there IS
 *     nothing internal: the control plane is entirely serverless and reached
 *     only over authenticated public APIs.
 *
 * Gateway endpoints for S3 and DynamoDB are free and keep artifact traffic off
 * the internet gateway entirely.
 *
 * The textbook private-subnet topology is written below behind
 * `network_mode = "private"`, so it can be stood up, evidenced, and destroyed
 * (docs/06-cost-model.md, Tier B) without living in the monthly bill.
 */

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = local.tags
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  private = var.network_mode == "private"
  # Two AZs: Fargate capacity in one AZ can be unavailable, and a second
  # subnet costs nothing.
  azs = slice(data.aws_availability_zones.available.names, 0, 2)

  tags = {
    project   = var.project
    managedBy = "terraform"
    stack     = "network"
    tier      = local.private ? "B" : "A"
  }
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.project}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project}-igw" }
}

# ---------------------------------------------------------------------------
# Public subnets — where build tasks run in the default topology
# ---------------------------------------------------------------------------

resource "aws_subnet" "public" {
  count = length(local.azs)

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone = local.azs[count.index]

  # The task needs a routable address to reach npm. Inbound is closed by the
  # security group, not by the absence of an address.
  map_public_ip_on_launch = true

  tags = { Name = "${var.project}-public-${local.azs[count.index]}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${var.project}-public" }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ---------------------------------------------------------------------------
# Build security group — the actual boundary
# ---------------------------------------------------------------------------

resource "aws_security_group" "build" {
  name        = "${var.project}-build"
  description = "Build tasks: no inbound, egress to package registries only"
  vpc_id      = aws_vpc.main.id

  # Deliberately NO ingress blocks. Not one. A public IP with no inbound rules
  # cannot be connected to.

  tags = { Name = "${var.project}-build" }
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.build.id
  description       = "npm registry, GitHub, S3, ECR"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "http" {
  security_group_id = aws_security_group.build.id
  description       = "some registries still redirect via http"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

# Honest limitation, recorded here as well as in the threat model: this is
# egress to the whole internet on two ports, not a package-registry allowlist.
# Restricting it needs an egress proxy or AWS Network Firewall (~$300/month).
# The mitigation is that the container holds no credential worth exfiltrating.

# ---------------------------------------------------------------------------
# Gateway endpoints — free, and keep artifact traffic off the IGW
# ---------------------------------------------------------------------------

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]
  tags              = { Name = "${var.project}-s3" }
}

resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]
  tags              = { Name = "${var.project}-dynamodb" }
}

# ---------------------------------------------------------------------------
# Tier B: the private topology, for demonstration then teardown
# ---------------------------------------------------------------------------

resource "aws_subnet" "private" {
  count = local.private ? length(local.azs) : 0

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 8)
  availability_zone = local.azs[count.index]

  tags = { Name = "${var.project}-private-${local.azs[count.index]}" }
}

resource "aws_eip" "nat" {
  count  = local.private ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${var.project}-nat" }
}

# ~$32/month, or $1.07/day. Stand up, capture evidence, destroy.
resource "aws_nat_gateway" "main" {
  count = local.private ? 1 : 0

  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${var.project}-nat" }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "private" {
  count  = local.private ? 1 : 0
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[0].id
  }

  tags = { Name = "${var.project}-private" }
}

resource "aws_route_table_association" "private" {
  count          = local.private ? length(aws_subnet.private) : 0
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[0].id
}

resource "aws_flow_log" "vpc" {
  count = local.private ? 1 : 0

  vpc_id               = aws_vpc.main.id
  traffic_type         = "ALL"
  log_destination_type = "s3"
  log_destination      = var.flow_log_bucket_arn
}
