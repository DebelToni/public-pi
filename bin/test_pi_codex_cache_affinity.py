#!/Volumes/example/v/py/bin/python
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("pi-patch-codex-cache-affinity")


def responses(account_scoped):
    account_argument = "accountId, " if account_scoped else ""
    acquire_account = "accountId, " if account_scoped else ""
    return f'''export function stream(options, model, context, accountId, apiKey) {{
            const cacheSessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
            const codexSessionId = clampOpenAIPromptCacheKey(cacheSessionId);
            let body = buildRequestBody(model, context, options, codexSessionId, grammarToolInputProperties);
            const websocketRequestId = codexSessionId || uuidv7();
            const sseHeaders = buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, codexSessionId);
            const websocketHeaders = buildWebSocketHeaders(model.headers, options?.headers, accountId, apiKey, websocketRequestId);
            const websocketDisabledForSession = transport !== "sse" && isWebSocketSseFallbackActive(cacheSessionId);
            if (websocketDisabledForSession) {{
                recordWebSocketSseFallback(cacheSessionId);
            }}
            processWebSocketStream(url, body, websocketHeaders, output, stream, model, () => {{
            }}, httpTimeoutMs, websocketConnectTimeoutMs, cacheSessionId, {account_argument}grammarToolInputProperties, options);
                        recordWebSocketFailure(cacheSessionId, error);
                        if (websocketStarted) {{
                            throw error;
                        }}
                        recordWebSocketSseFallback(cacheSessionId);
}}
function buildRequestBody() {{
    return {{
        prompt_cache_key: cacheSessionId,
    }};
}}
async function processWebSocketStream(url, body, headers, output, stream, model, onStart, idleTimeoutMs, websocketConnectTimeoutMs, cacheSessionId, {account_argument}grammarToolInputProperties, options) {{
    const {{ socket, entry, reused, release }} = await acquireWebSocket(url, headers, cacheSessionId, {acquire_account}options?.signal, websocketConnectTimeoutMs, options?.env);
    const stats = cacheSessionId ? getOrCreateWebSocketDebugStats(cacheSessionId) : undefined;
}}
'''


class CodexCacheAffinityPatchTest(unittest.TestCase):
    def run_fixture(self, account_scoped):
        with tempfile.TemporaryDirectory(prefix="pi-cache-affinity-") as temporary:
            root = Path(temporary)
            target = root / "responses.js"
            types = root / "types.d.ts"
            simple = root / "simple-options.js"
            target.write_text(responses(account_scoped), encoding="utf-8")
            types.write_text(
                "    sessionId?: string;\n    websocketConnectTimeoutMs?: number;\n",
                encoding="utf-8",
            )
            simple.write_text(
                "        sessionId: options?.sessionId,\n        headers: options?.headers,\n",
                encoding="utf-8",
            )
            env = {
                **os.environ,
                "PI_CODEX_RESPONSES_PATH": str(target),
                "PI_AI_TYPES_PATH": str(types),
                "PI_SIMPLE_OPTIONS_PATH": str(simple),
            }
            first = subprocess.run(
                [str(SCRIPT)], env=env, capture_output=True, text=True, check=True
            )
            second = subprocess.run(
                [str(SCRIPT)], env=env, capture_output=True, text=True, check=True
            )
            patched = target.read_text(encoding="utf-8")
            self.assertIn("Codex cache-affinity patch applied", first.stdout)
            self.assertIn("already present", second.stdout)
            self.assertIn(
                "const transportSessionId = options?.cacheRetention", patched
            )
            self.assertIn(
                "const cacheSessionId = options?.cacheRetention === \"none\" ? undefined : (options?.cacheSessionId ?? options?.sessionId)",
                patched,
            )
            self.assertIn("recordWebSocketFailure(transportSessionId, error)", patched)
            self.assertIn("getOrCreateWebSocketDebugStats(transportSessionId)", patched)
            self.assertEqual(types.read_text().count("cacheSessionId?: string;"), 1)
            self.assertEqual(
                simple.read_text().count("cacheSessionId: options?.cacheSessionId"), 1
            )
            if account_scoped:
                self.assertIn(
                    "websocketConnectTimeoutMs, transportSessionId, accountId, grammarToolInputProperties",
                    patched,
                )
                self.assertIn(
                    "acquireWebSocket(url, headers, transportSessionId, accountId, options?.signal",
                    patched,
                )
            else:
                self.assertIn(
                    "websocketConnectTimeoutMs, transportSessionId, grammarToolInputProperties",
                    patched,
                )
                self.assertIn(
                    "acquireWebSocket(url, headers, transportSessionId, options?.signal",
                    patched,
                )

    def test_patches_pre_account_scoped_websocket_shape(self):
        self.run_fixture(False)

    def test_preserves_084_account_scoped_websocket_pooling(self):
        self.run_fixture(True)


if __name__ == "__main__":
    unittest.main()
