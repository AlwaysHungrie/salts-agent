terraform {
  required_version = ">= 1.6"

  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "~> 3.0"
    }
    mongodbatlas = {
      source  = "mongodb/mongodbatlas"
      version = "~> 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Token from VERCEL_API_TOKEN in the environment.
provider "vercel" {
  team = var.vercel_team
}

# Service account from MONGODB_ATLAS_CLIENT_ID and MONGODB_ATLAS_CLIENT_SECRET in the environment.
provider "mongodbatlas" {}
