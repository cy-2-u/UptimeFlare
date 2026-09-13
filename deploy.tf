terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

provider "cloudflare" {
  # read token from $CLOUDFLARE_API_TOKEN
}

variable "CLOUDFLARE_ACCOUNT_ID" {
  # read account id from $TF_VAR_CLOUDFLARE_ACCOUNT_ID
  type = string
}

variable "MONITOR_SCHEDULER_NAMESPACE_ID" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-fA-F]{32}$", var.MONITOR_SCHEDULER_NAMESPACE_ID))
    error_message = "MONITOR_SCHEDULER_NAMESPACE_ID must be the real 32-character hexadecimal Durable Object namespace ID."
  }
}

resource "cloudflare_d1_database" "uptimeflare_d1" {
  account_id            = var.CLOUDFLARE_ACCOUNT_ID
  name                  = "uptimeflare_d1"
  read_replication = {
    mode = "auto"
  }
}

resource "cloudflare_workers_kv_namespace" "uptimeflare_config" {
  account_id = var.CLOUDFLARE_ACCOUNT_ID
  title      = "uptimeflare_config"
}

resource "cloudflare_workers_script" "uptimeflare_worker" {
  account_id          = var.CLOUDFLARE_ACCOUNT_ID
  script_name         = "uptimeflare_worker"
  # Wrangler owns script uploads, bindings and Durable Object migrations.
  # Import is required before apply; Terraform retains the reference for cron.
  lifecycle {
    ignore_changes = all
  }
}

resource "cloudflare_workers_cron_trigger" "uptimeflare_worker_cron" {
  account_id  = var.CLOUDFLARE_ACCOUNT_ID
  script_name = cloudflare_workers_script.uptimeflare_worker.script_name
  schedules = [{
    cron = "*/10 * * * *"
  }]
}

resource "cloudflare_pages_project" "uptimeflare" {
  account_id        = var.CLOUDFLARE_ACCOUNT_ID
  name              = "uptimeflare"
  production_branch = "main"

  deployment_configs = {
    # SMH Cloudflare provider will throw an error without preview config
    preview = {
      fail_open = false
      durable_object_namespaces = {
        MONITOR_SCHEDULER_DO = { namespace_id = var.MONITOR_SCHEDULER_NAMESPACE_ID }
      }
    }
    production = {
      d1_databases = {
        UPTIMEFLARE_D1 = {
          id = cloudflare_d1_database.uptimeflare_d1.id
        }
      }
      kv_namespaces = {
        UPTIMEFLARE_CONFIG = {
          namespace_id = cloudflare_workers_kv_namespace.uptimeflare_config.id
        }
      }
      durable_object_namespaces = {
        MONITOR_SCHEDULER_DO = { namespace_id = var.MONITOR_SCHEDULER_NAMESPACE_ID }
      }
      compatibility_date  = "2025-04-02"
      compatibility_flags = ["nodejs_compat"]
      fail_open           = false
    }
  }

  # SMH it will error without this build_config
  build_config = {
    root_dir = "/"
  }
}
