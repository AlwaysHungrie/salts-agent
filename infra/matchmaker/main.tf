# --- MongoDB Atlas: one free (M0) cluster ---

resource "mongodbatlas_project" "matchmaker" {
  name   = var.project_name
  org_id = var.atlas_org_id
}

resource "mongodbatlas_advanced_cluster" "matchmaker" {
  project_id   = mongodbatlas_project.matchmaker.id
  name         = "matchmaker"
  cluster_type = "REPLICASET"

  replication_specs = [
    {
      region_configs = [
        {
          electable_specs = {
            instance_size = "M0"
          }
          provider_name         = "TENANT"
          backing_provider_name = "AWS"
          region_name           = var.atlas_region
          priority              = 7
        }
      ]
    }
  ]
}

locals {
  db_name = "devcon-jobs-matchmaker"
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "mongodbatlas_database_user" "app" {
  project_id         = mongodbatlas_project.matchmaker.id
  username           = "matchmaker"
  password           = random_password.db.result
  auth_database_name = "admin"

  roles {
    role_name     = "readWrite"
    database_name = local.db_name
  }

  scopes {
    name = mongodbatlas_advanced_cluster.matchmaker.name
    type = "CLUSTER"
  }
}

# Vercel Functions have no fixed IPs, so the database is open to any address and
# guarded by the user's password alone.
resource "mongodbatlas_project_ip_access_list" "anywhere" {
  project_id = mongodbatlas_project.matchmaker.id
  cidr_block = "0.0.0.0/0"
  comment    = "Vercel Functions (no fixed IPs)"
}

# --- Vercel ---

resource "vercel_project" "matchmaker" {
  name            = var.project_name
  framework       = "nextjs"
  root_directory  = "app-experiments/devcon-jobs-matchmaker"
  install_command = "pnpm install"

  # Exit 0 skips the build: only pushes to var.branch deploy.
  ignore_command = "[ \"$VERCEL_GIT_COMMIT_REF\" != \"${var.branch}\" ]"

  git_repository = {
    type              = "github"
    repo              = var.github_repo
    production_branch = var.branch
  }
}

resource "random_password" "session" {
  length  = 48
  special = false
}

locals {
  mongodb_uri = format(
    "%s/?retryWrites=true&w=majority&appName=matchmaker",
    replace(
      mongodbatlas_advanced_cluster.matchmaker.connection_strings.standard_srv,
      "mongodb+srv://",
      "mongodb+srv://${mongodbatlas_database_user.app.username}:${random_password.db.result}@",
    ),
  )

  app_env = {
    AGENT_URL          = var.agent_url
    AGENT_ID           = var.agent_id
    AGENT_API_KEY      = var.agent_api_key
    MONGODB_URI        = local.mongodb_uri
    MONGODB_DB         = local.db_name
    SESSION_SECRET     = random_password.session.result
    OPENROUTER_API_KEY = var.openrouter_api_key
  }
}

resource "vercel_project_environment_variables" "matchmaker" {
  project_id = vercel_project.matchmaker.id

  variables = [
    for key in keys(local.app_env) : {
      key       = key
      value     = local.app_env[key]
      target    = ["production", "preview"]
      sensitive = true
    }
  ]
}

output "url" {
  value = "https://${var.project_name}.vercel.app"
}
