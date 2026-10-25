# Project created in the Atlas UI and imported (terraform import mongodbatlas_project.humans <id>).
resource "mongodbatlas_project" "humans" {
  name   = "devcon-humans"
  org_id = var.atlas_org_id
}

resource "mongodbatlas_advanced_cluster" "humans" {
  project_id   = mongodbatlas_project.humans.id
  name         = "humans"
  cluster_type = "REPLICASET"

  replication_specs = [{
    region_configs = [{
      provider_name         = "TENANT"
      backing_provider_name = "AWS"
      region_name           = "US_EAST_1"
      priority              = 7
      electable_specs = {
        instance_size = "M0"
      }
    }]
  }]
}

# Vercel functions have no fixed egress IPs.
resource "mongodbatlas_project_ip_access_list" "anywhere" {
  project_id = mongodbatlas_project.humans.id
  cidr_block = "0.0.0.0/0"
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "random_password" "session" {
  length  = 48
  special = false
}

locals {
  db_name = "devcon-humans"
  srv     = trimprefix(mongodbatlas_advanced_cluster.humans.connection_strings.standard_srv, "mongodb+srv://")
}

resource "mongodbatlas_database_user" "app" {
  project_id         = mongodbatlas_project.humans.id
  username           = "humans"
  password           = random_password.db.result
  auth_database_name = "admin"

  roles {
    role_name     = "readWrite"
    database_name = local.db_name
  }

  scopes {
    name = mongodbatlas_advanced_cluster.humans.name
    type = "CLUSTER"
  }
}

resource "vercel_project" "humans" {
  name            = "devcon-humans"
  framework       = "nextjs"
  root_directory  = "app-experiments/devcon-humans/frontend"
  install_command = "pnpm install"

  git_repository = {
    type              = "github"
    repo              = var.github_repo
    production_branch = "main"
  }
}

resource "vercel_project_environment_variables" "humans" {
  project_id = vercel_project.humans.id

  variables = [
    for key, value in {
      AGENT_URL               = var.agent_url
      FLEET_API_KEY           = var.fleet_api_key
      FIND_HUMANS_MCP_URL     = var.find_humans_mcp_url
      FIND_HUMANS_SIGNING_KEY = var.find_humans_signing_key
      MONGODB_URI             = "mongodb+srv://${mongodbatlas_database_user.app.username}:${random_password.db.result}@${local.srv}/?retryWrites=true&w=majority&appName=devcon-humans"
      MONGODB_DB              = local.db_name
      SESSION_SECRET          = random_password.session.result
      SITE_URL                = "https://${var.domain}"
      } : {
      key       = key
      value     = value
      target    = ["production", "preview"]
      sensitive = true
    }
  ]
}

# DNS is on Cloudflare: a DNS-only (grey cloud) CNAME to cname.vercel-dns.com.
resource "vercel_project_domain" "humans" {
  project_id = vercel_project.humans.id
  domain     = var.domain
}
