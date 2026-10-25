variable "vercel_team" {
  description = "Vercel team slug or id. null for a personal account."
  type        = string
  default     = null
}

variable "github_repo" {
  type    = string
  default = "AlwaysHungrie/salts-agent"
}

variable "atlas_org_id" {
  type = string
}

variable "domain" {
  type    = string
  default = "devcon.salts.dev"
}

variable "agent_url" {
  type    = string
  default = "https://api.salts.dev"
}

# Fleet Settings → Fleet API key, on the fleet at agent_url.
variable "fleet_api_key" {
  type      = string
  sensitive = true
}

variable "find_humans_mcp_url" {
  type    = string
  default = "https://humans-mcp.salts.dev/mcp"
}

# The find-humans server's SECRET_SIGNING_KEY (/opt/find-humans/.env on its Lightsail box).
variable "find_humans_signing_key" {
  type      = string
  sensitive = true
}
