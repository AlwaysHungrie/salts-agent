variable "vercel_team" {
  description = "Vercel team slug or id. null for a personal account."
  type        = string
  default     = null
}

variable "github_repo" {
  description = "owner/name of the repo the app deploys from."
  type        = string
  default     = "AlwaysHungrie/salts-agent"
}

# The only branch that deploys the app: pushes here are production deploys, and
# every other branch's builds are skipped.
variable "branch" {
  type    = string
  default = "devcon-matchmaker"
}

variable "project_name" {
  description = "Name of the Vercel project and the Atlas project."
  type        = string
  default     = "devcon8-matchmaker"
}

variable "atlas_org_id" {
  description = "Atlas organization id: Organization Settings in the Atlas UI."
  type        = string
}

# Vercel Functions run in iad1 by default; keep the database next to them.
variable "atlas_region" {
  type    = string
  default = "US_EAST_1"
}

variable "agent_url" {
  type    = string
  default = "https://salt-agent-staging.dhairyashah98.workers.dev"
}

variable "agent_id" {
  type = string
}

variable "agent_api_key" {
  description = "User API key for the agent: salt_user_<agentId>_<secret>."
  type        = string
  sensitive   = true
}

variable "openrouter_api_key" {
  type      = string
  sensitive = true
}
