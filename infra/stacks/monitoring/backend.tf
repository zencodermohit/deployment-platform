terraform {
  backend "s3" {
    bucket       = "deployment-platform-tfstate-220438080921"
    key          = "stacks/monitoring/terraform.tfstate"
    region       = "ap-south-1"
    use_lockfile = true
  }
}
