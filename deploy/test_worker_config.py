import copy
from pathlib import Path
import tomllib
import unittest

from worker_config import deployment_config


class DeploymentConfigTests(unittest.TestCase):
    def setUp(self):
        self.template = tomllib.loads(
            (Path(__file__).resolve().parent.parent / "worker/wrangler.toml").read_text()
        )
        self.database_id = "12345678-1234-1234-1234-123456789abc"
        self.namespace_id = "123456789abcdef0123456789abcdef0"

    def test_replaces_ids_and_preserves_worker_settings(self):
        original = copy.deepcopy(self.template)
        config = deployment_config(self.template, self.database_id, self.namespace_id)
        self.assertEqual(config["d1_databases"][0]["database_id"], self.database_id)
        self.assertEqual(config["kv_namespaces"][0]["id"], self.namespace_id)
        for field in ("main", "migrations", "durable_objects", "triggers"):
            self.assertEqual(config[field], original[field])
        self.assertTrue(config["observability"]["logs"]["invocation_logs"])
        self.assertEqual(self.template, original)

    def test_rejects_invalid_and_placeholder_ids(self):
        for invalid in (None, "", "invalid", "00000000-0000-0000-0000-000000000000"):
            with self.subTest(database_id=invalid), self.assertRaises(ValueError):
                deployment_config(self.template, invalid, self.namespace_id)
        for invalid in (None, "", "invalid", "0" * 32):
            with self.subTest(namespace_id=invalid), self.assertRaises(ValueError):
                deployment_config(self.template, self.database_id, invalid)

    def test_rejects_missing_and_duplicate_bindings(self):
        for section in ("d1_databases", "kv_namespaces"):
            for count in (0, 2):
                template = copy.deepcopy(self.template)
                template[section] *= count
                with self.subTest(section=section, count=count), self.assertRaises(ValueError):
                    deployment_config(template, self.database_id, self.namespace_id)


if __name__ == "__main__":
    unittest.main()
