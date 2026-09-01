# The bucket referenced here is created BY this stack. On a first apply in a new
# account this file must not exist yet — apply with local state, then add it back
# and run `terraform init -migrate-state`.
terraform {
  backend "s3" {
    bucket       = "deployment-platform-tfstate-220438080921"
    key          = "bootstrap/terraform.tfstate"
    region       = "ap-south-1"
    use_lockfile = true
  }
}
