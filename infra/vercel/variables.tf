variable "vercel_team" {
  description = "Vercel team slug or id. null for a personal account."
  type        = string
  default     = null
}

variable "github_repo" {
  description = "owner/name of the repo both projects deploy from."
  type        = string
  default     = "AlwaysHungrie/salts-agent"
}

variable "frontend_project_name" {
  type    = string
  default = "salts-agent-app"
}

variable "landing_page_project_name" {
  type    = string
  default = "salts-agent-landingpage"
}

# One map of KEY => value per target. Each target gets its own set.
variable "frontend_env" {
  description = "Frontend env vars, keyed by target (production, preview)."
  type        = map(map(string))
  sensitive   = true
}

# Staging = pushes to this branch. It gets production's env vars, with AGENT_URL
# swapped for the staging Worker.
variable "staging_branch" {
  type    = string
  default = "staging"
}

variable "staging_agent_url" {
  type    = string
  default = "https://api-staging.salts.dev"
}

variable "domain" {
  description = "Our domain. Landing page on the apex, web app on app., staging on staging."
  type        = string
  default     = "salts.dev"
}
