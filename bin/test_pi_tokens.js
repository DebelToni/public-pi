const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const tokens = require('./pi-tokens');

function entry(id, timestamp, role, usage) {
  return JSON.stringify({
    type: 'message',
    id,
    timestamp,
    message: { role, provider: 'codex-test', model: 'test-model', usage },
  });
}

function internal(id, timestamp, usage) {
  return JSON.stringify({
    type: 'custom',
    customType: 'pi-internal-llm-usage',
    id,
    timestamp,
    data: { provider: 'internal', model: 'helper', usage },
  });
}

test('arguments distinguish month values from a sessions root', () => {
  const parsed = tokens.parseArgs(['--by-model', '--month', '2026-08', '/tmp/sessions']);
  assert.equal(parsed.byModel, true);
  assert.equal(parsed.month, '2026-08');
  assert.equal(parsed.root, '/tmp/sessions');
  assert.throws(() => tokens.parseArgs(['--month', '2026-8']), /YYYY-MM/);
});

test('GitHub heat levels assign zero plus four usage bands', () => {
  assert.deepEqual(tokens.heatLevels([0, 10, 20, 30, 40]), [0, 1, 2, 3, 4]);
  assert.deepEqual(tokens.heatLevels([0, 0]), [0, 0]);
});

test('month layout starts on Monday and spans only required weeks', () => {
  const august = tokens.monthDetails('2026-08');
  assert.equal(august.mondayOffset, 5);
  assert.equal(august.days, 31);
  assert.equal(august.weeks, 6);
});

test('custom roots cannot overwrite the primary sessions cache', () => {
  const custom = tokens.cachePathForRoot('/tmp/custom-pi-sessions');
  const primary = tokens.cachePathForRoot(path.join(os.homedir(), '.pi', 'agent', 'sessions'));
  assert.notEqual(custom, primary);
});

test('default cache uses the platform cache directory and honors XDG on Linux', () => {
  const root = path.join(os.homedir(), '.pi', 'agent', 'sessions');
  const script = `console.log(require(${JSON.stringify(path.join(__dirname, 'pi-tokens'))}).cachePathForRoot(${JSON.stringify(root)}))`;
  for (const xdg of ['', '/tmp/pi-tokens-xdg']) {
    const actual = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, XDG_CACHE_HOME: xdg },
      encoding: 'utf8',
    }).trim();
    const cacheRoot = process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches')
      : xdg || path.join(os.homedir(), '.cache');
    assert.equal(actual, path.join(cacheRoot, 'pi-tokens', 'cache-v2.json'));
  }
});

test('empty sessions index and cache without a false rewrite error', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tokens-empty-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cachePath = path.join(root, 'cache.json');
  fs.writeFileSync(path.join(root, 'empty.jsonl'), '');

  for (let run = 0; run < 2; run++) {
    const aggregate = await tokens.collect(root, { cachePath });
    assert.equal(aggregate.total.sessions, 1);
    assert.equal(aggregate.total.messages, 0);
  }
});

test('cache incrementally includes appended records without recounting old ones', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tokens-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cachePath = path.join(root, 'cache', 'cache.json');
  const session = path.join(root, 'session.jsonl');
  fs.writeFileSync(session, [
    entry('u1', '2026-08-02T12:00:00.000Z', 'user'),
    entry('a1', '2026-08-02T12:00:01.000Z', 'assistant', { input: 100, output: 20, cost: { total: 0.1 } }),
    JSON.stringify({ type: 'message', id: 't1', timestamp: '2026-08-02T12:00:02.000Z', message: { role: 'toolResult', content: 'x'.repeat(10000) } }),
    '',
  ].join('\n'));

  const first = await tokens.collect(root, { cachePath });
  assert.equal(first.total.input, 100);
  assert.equal(first.total.output, 20);
  assert.equal(first.total.messages, 3);
  assert.equal(first.total.user, 1);
  assert.equal(first.total.assistant, 1);

  fs.appendFileSync(session, `${internal('i1', '2026-08-03T10:00:00.000Z', { input: 7, output: 3, cost: { total: 0.02 } })}\n`);
  const second = await tokens.collect(root, { cachePath });
  assert.equal(second.total.input, 107);
  assert.equal(second.total.output, 23);
  assert.equal(second.total.messages, 3);
  assert.equal(second.total.internal, 1);
  assert.equal(second.days['2026-08-02'].input, 100);
  assert.equal(second.days['2026-08-03'].output, 3);
  assert.equal(second.models['codex-test/test-model'].assistant, 1);
});

test('a larger in-place rewrite is rebuilt instead of treated as an append', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tokens-rewrite-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cachePath = path.join(root, 'cache.json');
  const session = path.join(root, 'session.jsonl');
  fs.writeFileSync(session, `${entry('a1', '2026-08-04T12:00:00.000Z', 'assistant', {
    input: 10,
    output: 1,
    cost: { total: 0.01 },
  })}\n`);
  assert.equal((await tokens.collect(root, { cachePath })).total.input, 10);

  const replacement = JSON.parse(entry('a2', '2026-08-04T12:01:00.000Z', 'assistant', {
    input: 99,
    output: 9,
    cost: { total: 0.09 },
  }));
  replacement.message.content = 'replacement is deliberately larger';
  fs.writeFileSync(session, `${JSON.stringify(replacement)}\n`);
  const rebuilt = await tokens.collect(root, { cachePath });
  assert.equal(rebuilt.total.input, 99);
  assert.equal(rebuilt.total.output, 9);
  assert.equal(rebuilt.total.assistant, 1);
});

test('an incomplete final JSONL record is resumed instead of lost', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tokens-partial-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cachePath = path.join(root, 'cache.json');
  const session = path.join(root, 'session.jsonl');
  const value = JSON.parse(entry('a1', '2026-08-04T12:00:00.000Z', 'assistant', {
    input: 11,
    output: 2,
    cost: { total: 0.01 },
  }));
  value.message.provider = 'codex-🟢';
  const line = Buffer.from(JSON.stringify(value));
  const emoji = line.indexOf(Buffer.from('🟢'));
  const split = emoji + 1;
  fs.writeFileSync(session, line.subarray(0, split));
  const incomplete = await tokens.collect(root, { cachePath });
  assert.equal(incomplete.total.assistant, 0);

  fs.appendFileSync(session, Buffer.concat([line.subarray(split), Buffer.from('\n')]));
  const complete = await tokens.collect(root, { cachePath });
  assert.equal(complete.total.assistant, 1);
  assert.equal(complete.total.input, 11);
  assert.equal(complete.total.output, 2);
});

test('parser preserves JSON semantics for whitespace, key order, and malformed lines', () => {
  const aggregate = { total: tokens.empty(), days: {}, models: {} };
  tokens.processLine('  {"message":{"role":"user"},"timestamp":"2026-08-01T00:00:00Z","type":"message"}', aggregate);
  tokens.processLine('{"type":"message","message":{"role":"user"}', aggregate);
  tokens.processLine(JSON.stringify({
    type: 'custom',
    customType: 'unrelated',
    data: { note: 'pi-internal-llm-usage', usage: { input: 999 } },
  }), aggregate);
  assert.equal(aggregate.total.messages, 1);
  assert.equal(aggregate.total.user, 1);
  assert.equal(aggregate.total.internal, 0);
  assert.equal(aggregate.total.input, 0);
});

test('month renderer includes summary and a seven-row calendar', () => {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(' '));
  try {
    tokens.renderMonth({
      '2026-08-01': { ...tokens.empty(), input: 1000, output: 50, cost: 0.2 },
    }, '2026-08', { color: false });
  } finally {
    console.log = original;
  }
  assert.match(lines[0], /August 2026 · 1\.05K recorded tokens · 1 active days/);
  assert.equal(lines.some((line) => line.trim() === '1  3 10 17 24 31'), true);
  for (const weekday of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    assert.equal(lines.some((line) => line.startsWith(weekday)), true);
  }
  assert.equal(lines.some((line) => line.includes('Less · ░ ▒ ▓ █ More')), true);
});
