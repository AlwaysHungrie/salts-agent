resource "vercel_project" "frontend" {
  name            = var.frontend_project_name
  framework       = "nextjs"
  root_directory  = "frontend"
  install_command = "pnpm install"

  git_repository = {
    type              = "github"
    repo              = var.github_repo
    production_branch = "main"
  }
}

resource "vercel_project" "landing_page" {
  name            = var.landing_page_project_name
  framework       = "nextjs"
  root_directory  = "landing-page"
  install_command = "pnpm install"

  git_repository = {
    type              = "github"
    repo              = var.github_repo
    production_branch = "main"
  }
}

locals {
  frontend_env = nonsensitive(var.frontend_env)

  # Staging: production's vars with AGENT_URL pointed at the staging Worker.
  staging_env = merge(local.frontend_env["production"], { AGENT_URL = var.staging_agent_url })
}

resource "vercel_project_environment_variables" "frontend" {
  project_id = vercel_project.frontend.id

  variables = concat(
    flatten([
      for target, vars in local.frontend_env : [
        for key, value in vars : {
          key       = key
          value     = value
          target    = [target]
          sensitive = true
        }
      ]
    ]),
    [
      for key, value in local.staging_env : {
        key        = key
        value      = value
        target     = ["preview"]
        git_branch = var.staging_branch
        sensitive  = true
      }
    ],
  )
}

# Renaming a project keeps its old *.vercel.app domain; these add the new ones.
# The old domains stay attached so existing links keep working.
resource "vercel_project_domain" "frontend" {
  project_id = vercel_project.frontend.id
  domain     = "${var.frontend_project_name}.vercel.app"
}

resource "vercel_project_domain" "landing_page" {
  project_id = vercel_project.landing_page.id
  domain     = "${var.landing_page_project_name}.vercel.app"
}

# Our own domain. DNS is on Cloudflare, as DNS-only (grey cloud) records: Vercel issues
# the certificates, which a proxied record would get in the way of.
resource "vercel_project_domain" "landing_page_apex" {
  project_id = vercel_project.landing_page.id
  domain     = var.domain
}

resource "vercel_project_domain" "landing_page_www" {
  project_id           = vercel_project.landing_page.id
  domain               = "www.${var.domain}"
  redirect             = vercel_project_domain.landing_page_apex.domain
  redirect_status_code = 308
}

resource "vercel_project_domain" "frontend_app" {
  project_id = vercel_project.frontend.id
  domain     = "app.${var.domain}"
}

resource "vercel_project_domain" "frontend_staging" {
  project_id = vercel_project.frontend.id
  domain     = "staging.${var.domain}"
  git_branch = var.staging_branch
}
