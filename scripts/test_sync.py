import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sync", Path(__file__).with_name("sync-from-private.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class PublicationTests(unittest.TestCase):
    def test_path_boundary(self):
        for path in ["/etc/passwd", "../auth.json", "extensions/../auth.json", "CONTEXT/USER.md",
                     "extensions/node_modules/a.js", "extensions//a.ts", "auth.json"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                sync.validate_path(path)
        sync.validate_path("extensions/example/index.ts")

    def test_privacy_boundary(self):
        for text in ["https://private-host.example.ts.net/", "100.90.1.2", "owner@gmail.com",
                     "-----BEGIN PRIVATE KEY-----", "/home/private-name/file", "/Users/private-name/file"]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                sync.check_privacy("test", text)
        sync.check_privacy("test", "https://example.invalid/ /home/user/file /Users/user/file")

    def test_sanitization(self):
        self.assertEqual(sync.sanitize("test", "/home/someone/a /Users/someone/b"),
                         "/home/user/a /Users/user/b")
        code = 'process.platform === "darwin" ? "/Volumes/example/env/bin/python" : join(homedir(), ".local/bin/python3")'
        self.assertEqual(sync.sanitize("extensions/inline-images/index.ts", code),
                         'process.env.PI_IMAGE_VIEWER_PYTHON ?? "python3"')
        fixture = 'const cwd = await mkdtemp("/home/someone/tmp/action-fusion-test-");'
        self.assertIn('mkdtemp(join(tmpdir(), "action-fusion-test-"))',
                      sync.sanitize("extensions/action-fusion/index.test.ts", fixture))

    def test_committed_only_and_failure_before_replacement(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, mirror = root / "source", root / "mirror"
            source.mkdir()
            (mirror / "scripts/overrides").mkdir(parents=True)
            (source / "extensions/example").mkdir(parents=True)
            file = source / "extensions/example/index.ts"
            file.write_text("export const value = 1;\n")
            subprocess.run(["git", "init", "-q", str(source)], check=True)
            subprocess.run(["git", "-C", str(source), "add", "."], check=True)
            subprocess.run(["git", "-C", str(source), "-c", "user.name=Test", "-c",
                            "user.email=test@example.invalid", "commit", "-qm", "fixture"], check=True)
            (mirror / "scripts/public-files.txt").write_text("extensions/example/index.ts\n")
            file.write_text("uncommitted private value\n")
            (source / "extensions/example/unreviewed.ts").write_text("never publish\n")
            with patch.object(sync, "REPO", mirror), patch.dict(os.environ, {"PI_PRIVATE_CONFIG": str(source)}):
                sync.main()
                published = mirror / "extensions/example/index.ts"
                self.assertEqual(published.read_text(), "export const value = 1;\n")
                self.assertFalse((published.parent / "unreviewed.ts").exists())
                override = mirror / "scripts/overrides/extensions/example/index.ts"
                override.parent.mkdir(parents=True)
                override.write_text("public override\n")
                sync.main()
                self.assertEqual(published.read_text(), "public override\n")
                override.write_text("https://private-host.example.ts.net/\n")
                with self.assertRaises(ValueError):
                    sync.main()
                self.assertEqual(published.read_text(), "public override\n")
                override.unlink()
                override.symlink_to(file)
                with self.assertRaises(ValueError):
                    sync.main()
                self.assertEqual(published.read_text(), "public override\n")
                override.unlink()
                link = source / "extensions/example/link.ts"
                link.symlink_to(file.name)
                subprocess.run(["git", "-C", str(source), "add", "extensions/example/link.ts"], check=True)
                subprocess.run(["git", "-C", str(source), "-c", "user.name=Test", "-c",
                                "user.email=test@example.invalid", "commit", "-qm", "link"], check=True)
                (mirror / "scripts/public-files.txt").write_text("extensions/example/index.ts\nextensions/example/link.ts\n")
                with self.assertRaises(ValueError):
                    sync.main()
                self.assertEqual(published.read_text(), "public override\n")


if __name__ == "__main__":
    unittest.main()
