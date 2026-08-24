import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import exaSearchExtension from "./index.ts";

const EMPTY_ENV_PATH = join(tmpdir(), `pi-exa-no-env-${process.pid}`);

function registeredExtension(statePath?: string, envPath = EMPTY_ENV_PATH) {
	const tools: any[] = [];
	const commands = new Map<string, any>();
	exaSearchExtension({
		registerTool: (tool: unknown) => tools.push(tool),
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
	} as unknown as ExtensionAPI, statePath, envPath);
	return { tools, commands };
}

function registeredTools(statePath?: string, envPath?: string) {
	return registeredExtension(statePath, envPath).tools;
}

type FakeResponse = { status: number; body: unknown };
type FakeRequest = { apiKey: string | null; path: string; body: any };

async function withExaKeys(keys: Record<number, string>, run: () => Promise<void>) {
	const previousKeys = Object.entries(process.env).filter(([name]) => /^EXA_API_KEY(?:_\d+)?$/.test(name));
	for (const name of Object.keys(process.env)) {
		if (/^EXA_API_KEY(?:_\d+)?$/.test(name)) delete process.env[name];
	}
	for (const [idText, apiKey] of Object.entries(keys)) {
		const id = Number(idText);
		process.env[id === 1 ? "EXA_API_KEY" : `EXA_API_KEY_${id}`] = apiKey;
	}
	try {
		await run();
	} finally {
		for (const name of Object.keys(process.env)) {
			if (/^EXA_API_KEY(?:_\d+)?$/.test(name)) delete process.env[name];
		}
		for (const [name, value] of previousKeys) {
			if (value !== undefined) process.env[name] = value;
		}
	}
}

async function withFakeExa(
	responses: FakeResponse[],
	run: (requests: FakeRequest[]) => Promise<void>,
	keys: Record<number, string> = { 1: "test-primary-key", 2: "test-secondary-key" },
) {
	const previousFetch = globalThis.fetch;
	const requests: FakeRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const response = responses.shift();
		if (!response) throw new Error("Unexpected Exa request");
		const headers = new Headers(init?.headers);
		requests.push({
			apiKey: headers.get("x-api-key"),
			path: new URL(input instanceof Request ? input.url : input).pathname,
			body: JSON.parse(String(init?.body)),
		});
		return new Response(JSON.stringify(response.body), { status: response.status });
	}) as typeof fetch;
	try {
		await withExaKeys(keys, async () => {
			await run(requests);
			assert.equal(responses.length, 0);
		});
	} finally {
		globalThis.fetch = previousFetch;
	}
}

async function withStatePath(run: (statePath: string) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "pi-exa-accounts-"));
	try {
		await run(join(directory, "runtime", "account.json"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function activeAccount(statePath: string) {
	return JSON.parse(await readFile(statePath, "utf8")).activeAccount as number;
}

async function statusFile(statePath: string, account: number) {
	const name = (await readdir(dirname(statePath))).find((entry) => entry.startsWith(`status-${account}-`));
	if (!name) throw new Error(`Missing status file for account ${account}`);
	return join(dirname(statePath), name);
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

test("exa_search call header shows the normalized model query", () => {
	const search = registeredTools().find((tool) => tool.name === "exa_search");
	assert.ok(search?.renderCall);
	const component = search.renderCall(
		{ query: "  Pi prompt\ncache behavior  " },
		theme,
		{ lastComponent: undefined },
	);
	assert.deepEqual(component.render(120).map((line: string) => line.trimEnd()), ["exa_search: Pi prompt cache behavior"]);
});

test("exa_search keeps fallback result rendering", () => {
	const search = registeredTools().find((tool) => tool.name === "exa_search");
	assert.equal(search.renderResult, undefined);
});

test("402 rotates to account 2 and independent tool instances keep using it", async () => {
	await withStatePath(async (statePath) => {
		await withFakeExa([
			{ status: 402, body: { error: "credits exhausted" } },
			{ status: 200, body: { results: [{ title: "First", url: "https://example.com/1" }] } },
			{ status: 200, body: { results: [{ title: "Second", url: "https://example.com/2" }] } },
		], async (requests) => {
			const firstSearch = registeredTools(statePath).find((tool) => tool.name === "exa_search");
			const result = await firstSearch.execute("call-1", { query: "quota rotation", numResults: 3 });
			assert.match(result.content[0].text, /First/);
			assert.deepEqual(requests.map((request) => request.apiKey), ["test-primary-key", "test-secondary-key"]);

			const stateText = await readFile(statePath, "utf8");
			assert.equal(JSON.parse(stateText).activeAccount, 2);
			assert.doesNotMatch(stateText, /test-.*-key|quota rotation/);
			const firstStatusPath = await statusFile(statePath, 1);
			const secondStatusPath = await statusFile(statePath, 2);
			const firstStatus = await readFile(firstStatusPath, "utf8");
			const secondStatus = await readFile(secondStatusPath, "utf8");
			assert.equal(JSON.parse(firstStatus).status, 402);
			assert.equal(JSON.parse(secondStatus).status, 200);
			assert.doesNotMatch(`${firstStatus}${secondStatus}`, /test-.*-key|quota rotation/);
			assert.equal((await stat(secondStatusPath)).mode & 0o777, 0o600);
			assert.equal((await stat(statePath)).mode & 0o777, 0o600);
			assert.equal((await stat(dirname(statePath))).mode & 0o777, 0o700);

			const secondSearch = registeredTools(statePath).find((tool) => tool.name === "exa_search");
			await secondSearch.execute("call-2", { query: "next search", numResults: 3 });
			assert.equal(requests[2].apiKey, "test-secondary-key");
		});
	});
});

test("account 2 exhaustion rotates back to account 1", async () => {
	await withStatePath(async (statePath) => {
		await mkdir(dirname(statePath), { recursive: true });
		await writeFile(statePath, '{"activeAccount":2}\n');
		await withFakeExa([
			{ status: 402, body: { error: "credits exhausted" } },
			{ status: 200, body: { results: [] } },
		], async (requests) => {
			const search = registeredTools(statePath).find((tool) => tool.name === "exa_search");
			await search.execute("call", { query: "new billing period", numResults: 3 });
			assert.deepEqual(requests.map((request) => request.apiKey), ["test-secondary-key", "test-primary-key"]);
			assert.equal(await activeAccount(statePath), 1);
		});
	});
});

test("future numbered file keys rotate in numeric order and wrap", async () => {
	await withStatePath(async (statePath) => {
		const envPath = join(dirname(statePath), "exa.env");
		await mkdir(dirname(statePath), { recursive: true });
		await writeFile(envPath, [
			'EXA_API_KEY="file-primary-key"',
			'EXA_API_KEY_3="file-third-key"',
			'export EXA_API_KEY_10="file-tenth-key"',
		].join("\n"));
		await writeFile(statePath, '{"activeAccount":3}\n');
		await withFakeExa([
			{ status: 402, body: { error: "third exhausted" } },
			{ status: 402, body: { error: "tenth exhausted" } },
			{ status: 200, body: { results: [] } },
		], async (requests) => {
			const search = registeredTools(statePath, envPath).find((tool) => tool.name === "exa_search");
			await search.execute("call", { query: "future accounts", numResults: 3 });
			assert.deepEqual(requests.map((request) => request.apiKey), [
				"file-third-key",
				"file-tenth-key",
				"file-primary-key",
			]);
			assert.equal(await activeAccount(statePath), 1);
		}, {});
	});
});

test("concurrent stale failover cannot regress the globally selected account", async () => {
	await withStatePath(async (statePath) => {
		const previousFetch = globalThis.fetch;
		let releaseFirstRequest!: () => void;
		let markFirstStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
		const blockedFirst = new Promise<Response>((resolve) => {
			releaseFirstRequest = () => resolve(new Response('{"error":"primary exhausted"}', { status: 402 }));
		});
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const apiKey = new Headers(init?.headers).get("x-api-key");
			const query = JSON.parse(String(init?.body)).query;
			if (query === "A" && apiKey === "concurrent-primary") {
				markFirstStarted();
				return blockedFirst;
			}
			if (query === "A" && apiKey === "concurrent-secondary") {
				return new Response('{"error":"stop stale request"}', { status: 500 });
			}
			if (query === "B" && (apiKey === "concurrent-primary" || apiKey === "concurrent-secondary")) {
				return new Response('{"error":"exhausted"}', { status: 402 });
			}
			if (query === "B" && apiKey === "concurrent-third") {
				return new Response('{"results":[]}', { status: 200 });
			}
			throw new Error(`Unexpected concurrent request: ${query}`);
		}) as typeof fetch;
		try {
			await withExaKeys({
				1: "concurrent-primary",
				2: "concurrent-secondary",
				3: "concurrent-third",
			}, async () => {
				const search = registeredTools(statePath).find((tool) => tool.name === "exa_search");
				const first = search.execute("first", { query: "A", numResults: 3 });
				await firstStarted;
				await search.execute("second", { query: "B", numResults: 3 });
				assert.equal(await activeAccount(statePath), 3);
				releaseFirstRequest();
				await assert.rejects(() => first, /Exa 500/);
				assert.equal(await activeAccount(statePath), 3);
			});
		} finally {
			globalThis.fetch = previousFetch;
		}
	});
});

test("a delayed success cannot override a newer quota rotation", async () => {
	await withStatePath(async (statePath) => {
		await mkdir(dirname(statePath), { recursive: true });
		await writeFile(statePath, '{"activeAccount":1}\n');
		const previousFetch = globalThis.fetch;
		let releaseDelayedSuccess!: () => void;
		let markDelayedStarted!: () => void;
		const delayedStarted = new Promise<void>((resolve) => { markDelayedStarted = resolve; });
		const delayedSuccess = new Promise<Response>((resolve) => {
			releaseDelayedSuccess = () => resolve(new Response('{"results":[]}', { status: 200 }));
		});
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const apiKey = new Headers(init?.headers).get("x-api-key");
			const query = JSON.parse(String(init?.body)).query;
			if (query === "slow" && apiKey === "generation-primary") {
				markDelayedStarted();
				return delayedSuccess;
			}
			if (query === "rotate" && apiKey === "generation-primary") {
				return new Response('{"error":"exhausted"}', { status: 402 });
			}
			if (query === "rotate" && apiKey === "generation-secondary") {
				return new Response('{"results":[]}', { status: 200 });
			}
			throw new Error(`Unexpected generation request: ${query}`);
		}) as typeof fetch;
		try {
			await withExaKeys({ 1: "generation-primary", 2: "generation-secondary" }, async () => {
				const search = registeredTools(statePath).find((tool) => tool.name === "exa_search");
				const slow = search.execute("slow", { query: "slow", numResults: 3 });
				await delayedStarted;
				await search.execute("rotate", { query: "rotate", numResults: 3 });
				assert.equal(await activeAccount(statePath), 2);
				releaseDelayedSuccess();
				await slow;
				assert.equal(await activeAccount(statePath), 2);
			});
		} finally {
			globalThis.fetch = previousFetch;
		}
	});
});

test("a late response from a replaced credential cannot alter its replacement", async () => {
	await withStatePath(async (statePath) => {
		const envPath = join(dirname(statePath), "exa.env");
		await mkdir(dirname(statePath), { recursive: true });
		await writeFile(envPath, 'EXA_API_KEY="replacement-primary"\nEXA_API_KEY_2="old-secondary"\n');
		await writeFile(statePath, '{"activeAccount":2}\n');
		const previousFetch = globalThis.fetch;
		let releaseOldRequest!: () => void;
		let markOldStarted!: () => void;
		const oldStarted = new Promise<void>((resolve) => { markOldStarted = resolve; });
		const blockedOld = new Promise<Response>((resolve) => {
			releaseOldRequest = () => resolve(new Response('{"error":"old key exhausted"}', { status: 402 }));
		});
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const apiKey = new Headers(init?.headers).get("x-api-key");
			const query = JSON.parse(String(init?.body)).query;
			if (query === "old" && apiKey === "old-secondary") {
				markOldStarted();
				return blockedOld;
			}
			if (query === "new" && apiKey === "new-secondary") {
				return new Response('{"results":[]}', { status: 200 });
			}
			if (query === "old" && apiKey === "replacement-primary") {
				return new Response('{"error":"stop old request"}', { status: 500 });
			}
			throw new Error(`Unexpected replacement request: ${query}`);
		}) as typeof fetch;
		try {
			await withExaKeys({}, async () => {
				const search = registeredTools(statePath, envPath).find((tool) => tool.name === "exa_search");
				const oldRequest = search.execute("old", { query: "old", numResults: 3 });
				await oldStarted;
				await writeFile(envPath, 'EXA_API_KEY="replacement-primary"\nEXA_API_KEY_2="new-secondary"\n');
				await search.execute("new", { query: "new", numResults: 3 });
				releaseOldRequest();
				await assert.rejects(() => oldRequest, /Exa 500/);
				assert.equal(await activeAccount(statePath), 2);

				const messages: string[] = [];
				await registeredExtension(statePath, envPath).commands.get("exa-info").handler("", {
					ui: { notify: (message: string) => messages.push(message) },
				});
				assert.match(messages[0], /\* EXA_API_KEY_2 — HTTP 200 \(ok\)/);
				assert.doesNotMatch(messages[0], /old-secondary|new-secondary/);
				assert.equal((await readdir(dirname(statePath))).filter((name) => name.startsWith("status-2-")).length, 2);
			});
		} finally {
			globalThis.fetch = previousFetch;
		}
	});
});

test("/exa-info reports every account without probing and rejects stale credential status", async () => {
	await withStatePath(async (statePath) => {
		const envPath = join(dirname(statePath), "exa.env");
		await mkdir(dirname(statePath), { recursive: true });
		await writeFile(envPath, 'EXA_API_KEY="info-primary-key"\nEXA_API_KEY_3="info-third-key"\n');
		await withFakeExa([
			{ status: 402, body: { error: "primary exhausted" } },
			{ status: 200, body: { results: [] } },
		], async (requests) => {
			const extension = registeredExtension(statePath, envPath);
			const search = extension.tools.find((tool) => tool.name === "exa_search");
			await search.execute("call", { query: "record status", numResults: 3 });
			const requestCount = requests.length;
			const messages: string[] = [];
			await extension.commands.get("exa-info").handler("", {
				ui: { notify: (message: string) => messages.push(message) },
			});
			assert.equal(requests.length, requestCount);
			assert.match(messages[0], /Exa accounts \(2\).*last observed HTTP status/);
			assert.match(messages[0], /EXA_API_KEY — HTTP 402 \(quota exhausted\)/);
			assert.match(messages[0], /\* EXA_API_KEY_3 — HTTP 200 \(ok\)/);
			assert.match(messages[0], /Rotation: 1 → 3 → 1/);
			assert.match(messages[0], /per-key usage endpoint reports spend/);
			assert.doesNotMatch(messages[0], /info-.*-key/);

			await writeFile(envPath, 'EXA_API_KEY="info-primary-key"\nEXA_API_KEY_3="replacement-third-key"\n');
			const replacementMessages: string[] = [];
			await registeredExtension(statePath, envPath).commands.get("exa-info").handler("", {
				ui: { notify: (message: string) => replacementMessages.push(message) },
			});
			assert.match(replacementMessages[0], /  EXA_API_KEY_3 — no request observed yet/);
			assert.match(replacementMessages[0], /\* EXA_API_KEY — HTTP 402/);
		}, {});
	});
});

test("429 rate-limit errors do not rotate accounts", async () => {
	await withStatePath(async (statePath) => {
		await withFakeExa([
			{ status: 429, body: { error: "rate limited" } },
		], async (requests) => {
			const search = registeredTools(statePath).find((tool) => tool.name === "exa_search");
			await assert.rejects(() => search.execute("call", { query: "rate limit", numResults: 3 }), /Exa 429/);
			assert.deepEqual(requests.map((request) => request.apiKey), ["test-primary-key"]);
			assert.equal(existsSync(statePath), false);
		});
	});
});

test("both exhausted accounts are tried once without the includeText fallback", async () => {
	await withStatePath(async (statePath) => {
		await withFakeExa([
			{ status: 402, body: { error: "primary exhausted" } },
			{ status: 402, body: { error: "secondary exhausted" } },
		], async (requests) => {
			const search = registeredTools(statePath).find((tool) => tool.name === "exa_search");
			await assert.rejects(
				() => search.execute("call", { query: "research", numResults: 3, includeText: true }),
				/all 2 configured accounts have exceeded their credits limit/,
			);
			assert.deepEqual(requests.map((request) => request.apiKey), ["test-primary-key", "test-secondary-key"]);
			assert.equal(await activeAccount(statePath), 1);
		});
	});
});

test("exa_answer shares the same persistent account rotation", async () => {
	await withStatePath(async (statePath) => {
		await withFakeExa([
			{ status: 402, body: { error: "credits exhausted" } },
			{ status: 200, body: { answer: "Sourced answer", citations: [] } },
		], async (requests) => {
			const answer = registeredTools(statePath).find((tool) => tool.name === "exa_answer");
			const result = await answer.execute("call", { query: "question" });
			assert.equal(result.content[0].text, "Sourced answer\n\n## Citations\n");
			assert.deepEqual(requests.map((request) => request.path), ["/answer", "/answer"]);
			assert.deepEqual(requests.map((request) => request.apiKey), ["test-primary-key", "test-secondary-key"]);
		});
	});
});
