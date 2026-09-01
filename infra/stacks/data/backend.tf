terraform {
  backend "s3" {
    bucket = "deployment-platform-tfstate-220438080921"
    key    = "stacks/data/terraform.tfstate"
    region = "ap-south-1"

    # Terraform 1.10+ locks natively against S3. No DynamoDB table needed.
    use_lockfile = true
  }
}
