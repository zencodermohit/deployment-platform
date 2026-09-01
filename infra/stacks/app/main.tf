/**
 * M3 — App stack: the deployment state table.
 *
 * One table for every entity. Two indexes, each earning its place:
 *
 *   gsi1  "by id"      — entities are addressed by opaque id from the API but
 *                        stored under their parent so listing is one Query.
 *                        This bridges the two.
 *
 *   gsi2  "in flight"  — SPARSE. gsi2pk is written only while a deployment is
 *                        live and REMOVEd on every terminal transition, so the
 *                        index holds a handful of items rather than the whole
 *                        deployment history. The sweeper's cost is therefore
 *                        proportional to stuck deployments, not to all of them.
 *
 * Layout and access patterns: docs/02-data-model.md, ADR-0008.
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

data "terraform_remote_state" "data" {
  backend = "s3"
  config = {
    bucket = var.state_bucket
    key    = "stacks/data/terraform.tfstate"
    region = var.region
  }
}

locals {
  kms_key_arn = data.terraform_remote_state.data.outputs.kms_key_arn

  tags = {
    project   = var.project
    managedBy = "terraform"
    stack     = "app"
    tier      = "A"
  }
}

resource "aws_dynamodb_table" "platform" {
  name = var.project

  # On-demand, not provisioned. A provisioned table costs ~$14/month sitting
  # idle; on-demand at this volume costs cents. See docs/06-cost-model.md.
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "PK"
  range_key = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }
  attribute {
    name = "gsi2pk"
    type = "S"
  }
  attribute {
    name = "gsi2sk"
    type = "S"
  }

  # Lookup by opaque id: GET /deployments/{id} without knowing its project.
  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  # The sparse in-flight index the sweeper reads. Only the attributes the
  # sweeper actually needs are projected — a full projection would duplicate
  # every live deployment record for no benefit.
  global_secondary_index {
    name            = "gsi2"
    hash_key        = "gsi2pk"
    range_key       = "gsi2sk"
    projection_type = "INCLUDE"
    non_key_attributes = [
      "deploymentId",
      "projectId",
      "createdAt",
      "deadlineAt",
      "status",
      "taskArn",
    ]
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = local.kms_key_arn
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = var.deletion_protection

  lifecycle {
    # Adding an index is an online operation; removing one silently breaks
    # every query that used it. Make that a deliberate, visible change.
    ignore_changes = []
  }
}

# A separate table for tests, so an integration run can never touch real
# deployments. Same schema, no PITR, no deletion protection, destroyed freely.
resource "aws_dynamodb_table" "test" {
  count = var.create_test_table ? 1 : 0

  name         = "${var.project}-test"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }
  attribute {
    name = "gsi2pk"
    type = "S"
  }
  attribute {
    name = "gsi2sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "gsi2"
    hash_key        = "gsi2pk"
    range_key       = "gsi2sk"
    projection_type = "INCLUDE"
    non_key_attributes = [
      "deploymentId",
      "projectId",
      "createdAt",
      "deadlineAt",
      "status",
      "taskArn",
    ]
  }

  # Test rows clean themselves up, so a failed run leaves no residue.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}
