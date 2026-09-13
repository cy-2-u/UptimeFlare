"""Generate a Wrangler deployment config using provisioned resource IDs."""

import json
import os
from pathlib import Path
import re
import tomllib


def deployment_config(template, database_id, namespace_id):
    if not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", database_id or ""):
        raise ValueError("D1_ID must be a valid database UUID")
    if not re.fullmatch(r"[0-9a-fA-F]{32}", namespace_id or ""):
        raise ValueError("KV_CONFIG_ID must be a valid namespace ID")
    if int(database_id.replace("-", ""), 16) == 0 or int(namespace_id, 16) == 0:
        raise ValueError("Deployment resource IDs must not be placeholders")

    config = json.loads(json.dumps(template))
    for section, name, field, value in (
        ("d1_databases", "UPTIMEFLARE_D1", "database_id", database_id),
        ("kv_namespaces", "UPTIMEFLARE_CONFIG", "id", namespace_id),
    ):
        bindings = [binding for binding in config.get(section, []) if binding["binding"] == name]
        if len(bindings) != 1:
            raise ValueError(f"Expected exactly one {name} binding")
        bindings[0][field] = value
    config["observability"] = {"enabled": True, "logs": {"enabled": True, "invocation_logs": True}}
    return config


if __name__ == "__main__":
    worker_dir = Path(__file__).resolve().parent.parent / "worker"
    template = tomllib.loads((worker_dir / "wrangler.toml").read_text())
    config = deployment_config(template, os.environ.get("D1_ID"), os.environ.get("KV_CONFIG_ID"))
    (worker_dir / "wrangler.deploy.json").write_text(json.dumps(config, indent=2) + "\n")
