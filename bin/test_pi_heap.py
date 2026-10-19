#!/usr/bin/env python3
"""The Pi wrapper sets an 8 GiB old-space limit without changing the login shell."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class HeapPolicyTest(unittest.TestCase):
    def test_pi_wrapper_preserves_options_and_is_effective(self):
        wrapper = Path(__file__).with_name("pi")
        with tempfile.TemporaryDirectory(dir=Path.home() / "tmp") as directory:
            probe = Path(directory) / "heap-probe"
            probe.write_text("#!/usr/bin/env node\nconsole.log(JSON.stringify({options:process.env.NODE_OPTIONS, heap:require('node:v8').getHeapStatistics().heap_size_limit,args:process.argv.slice(2)}));\n")
            probe.chmod(0o700)
            for options in ("", "--trace-warnings --max-old-space-size=2048", "--max-old-space-size=8192"):
                env = {**os.environ, "NODE_OPTIONS": options, "PI_REAL_BIN": str(probe)}
                result = subprocess.run([str(wrapper), "--session", "fixture"], env=env, check=True, capture_output=True, text=True)
                data = json.loads(result.stdout)
                self.assertEqual(data["args"], ["--session", "fixture"])
                self.assertTrue(data["options"].endswith("--max-old-space-size=8192"))
                self.assertGreaterEqual(data["heap"], 8192 * 1024**2)
                self.assertLess(data["heap"], 8400 * 1024**2)
                self.assertEqual(env["NODE_OPTIONS"], options)


if __name__ == "__main__":
    unittest.main()
