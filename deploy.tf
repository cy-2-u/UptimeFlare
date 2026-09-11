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

variable "enable_do_migration" {
  type    = bool
  default = false
}

variable "enable_scheduler_migration" {
  type    = bool
  default = false
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
  main_module         = "worker/dist/index.js"
  content_file        = "worker/dist/index.js"
  content_sha256      = filesha256("worker/dist/index.js")
  compatibility_date  = "2025-04-02"
  compatibility_flags = ["nodejs_compat"]

  observability = {
    enabled = true
    logs = {
      enabled         = true
      invocation_logs = true
    }
  }

  migrations = var.enable_do_migration ? {
    old_tag            = null
    new_tag            = "v1"
    new_sqlite_classes = ["RemoteChecker"]
  } : var.enable_scheduler_migration ? {
    old_tag            = "v1"
    new_tag            = "v2"
    new_sqlite_classes = ["MonitorScheduler"]
  } : null

  bindings = [{
    name       = "REMOTE_CHECKER_DO"
    class_name = "RemoteChecker"
    type       = "durable_object_namespace"
    }, {
    name       = "MONITOR_SCHEDULER_DO"
    class_name = "MonitorScheduler"
    type       = "durable_object_namespace"
    }, {
    name = "UPTIMEFLARE_D1"
    type = "d1"
    id   = cloudflare_d1_database.uptimeflare_d1.id
    }, {
    name         = "UPTIMEFLARE_CONFIG"
    type         = "kv_namespace"
    namespace_id = cloudflare_workers_kv_namespace.uptimeflare_config.id
  }]
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
