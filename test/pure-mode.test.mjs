import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { createScope } from '@deepseek-ai/dsh-scope';
import { Storage } from '@deepseek-ai/dsh-storage';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { createPureMode, modeDomain, personalTool, personalInvocation, handleRequest, BASE, PERSONA_SECTION } from '../lib/index.js';
import * as plugin from '../lib/index.js';

const definition = name => ({ name, description: name, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object', properties: {} }, render: () => [] }, execute: async () => ({}) });

test('the packaged entry starts and unloads through the native Cordis lifecycle', async () => {
  const ctx = new Context(); new SystemPrompt(ctx, {}); new ToolRuntime(ctx, { mode: 'native' });
  let registered = 0, closed = 0;
  ctx.provide('connection', { requestRejection: () => undefined });
  ctx.provide('webServer', { register: () => { registered++; return () => { registered--; }; } });
  ctx.provide('agents', { list: () => [], get: () => undefined });
  ctx.provide('sessions', { get: () => undefined });
  ctx.provide('storageDomain', { open: async () => ({ table: () => ({ get: () => undefined }), close: async () => { closed++; } }) });
  const fiber = ctx.plugin(plugin);
  try {
    await fiber.await(); assert.equal(fiber.state, 2); assert.equal(registered, 1);
  } finally { await fiber.dispose(); }
  assert.equal(registered, 0); assert.equal(closed, 1);
});

async function fixture(t, { store = new Map() } = {}) {
  const ctx = new Context(); new SystemPrompt(ctx, {}); new ToolRuntime(ctx, { mode: 'native' });
  let personaReads = 0;
  ctx.systemPrompt.section({ name: PERSONA_SECTION, order: 1, text: () => { personaReads++; return 'DAFEIYU_PERSONA\n<dafeiyu_self_profile>SELF_PROFILE</dafeiyu_self_profile>'; } });
  ctx.systemPrompt.section({ name: 'engineering:AGENTS', order: 100, text: 'KEEP_AGENTS_RULES' });
  for (const name of ['read', 'write', 'mcp__work__query', 'mcp__basic_memory__search_notes', 'mcp__basic_memory__read_note', 'mcp__basic_memory__write_note', 'dafeiyu_records', 'soften_memory', 'recent_conversation']) ctx.tools.register(definition(name));
  const map = new Map(), parents = new Map(), scopes = [];
  const agents = { get: id => map.get(id), list: () => [...map.values()], isOwnedBy: (id, parent) => parents.get(map.get(id)) === parent };
  const table = { get: id => store.get(id), put: async (id, value) => { store.set(id, value); } };
  const controller = createPureMode({ table, agents, tools: ctx.tools });
  ctx.on('tools/change', () => controller.refresh());
  function agent(id, parent) {
    const result = { session: { id }, status: 'idle' };
    const scope = createScope(ctx, result, parent ? { parent } : undefined); scopes.push(scope); result.ctx = scope.ctx;
    map.set(id, result); if (parent) parents.set(result, parent); controller.attach(result); return result;
  }
  const a = agent('session-test-a'), b = agent('session-test-b');
  t.after(async () => { controller.dispose(); for (const scope of scopes.reverse()) await scope.dispose(); });
  return { ctx, a, b, agent, agents, table, store, controller, personaReads: () => personaReads,
    prompt: async a => renderPrompt(await ctx.systemPrompt.assemble({ agent: a, scope: a })) };
}

test('default is normal mode and both independent sessions retain persona, profile, AGENTS and tools', async t => {
  const f = await fixture(t);
  assert.equal(f.controller.status(f.a.session.id).requested, false);
  assert.match(await f.prompt(f.a), /DAFEIYU_PERSONA/); assert.match(await f.prompt(f.b), /SELF_PROFILE/);
  assert.match(await f.prompt(f.a), /KEEP_AGENTS_RULES/);
  assert.ok(f.ctx.tools.get('mcp__basic_memory__read_note', f.a));
});

test('turn boundary activates pure mode for A only; native scope avoids reading the global profile at all', async t => {
  const f = await fixture(t);
  await f.controller.set(f.a.session.id, true);
  assert.equal(f.controller.status(f.a.session.id).pending, true);
  assert.match(await f.prompt(f.a), /SELF_PROFILE/);
  f.controller.begin(f.a, 1); const reads = f.personaReads();
  const text = await f.prompt(f.a);
  assert.doesNotMatch(text, /DAFEIYU_PERSONA|SELF_PROFILE/); assert.match(text, /KEEP_AGENTS_RULES/);
  assert.equal(f.personaReads(), reads, 'scoped shadow must prevent the source callback, not only delete its text afterwards');
  assert.equal(f.ctx.tools.get('mcp__basic_memory__read_note', f.a), undefined);
  assert.equal(f.ctx.tools.get('dafeiyu_records', f.a), undefined);
  assert.ok(f.ctx.tools.get('read', f.a)); assert.ok(f.ctx.tools.get('mcp__work__query', f.a));
  assert.ok(f.ctx.tools.get('mcp__basic_memory__read_note', f.b)); assert.match(await f.prompt(f.b), /SELF_PROFILE/);
});

test('clicking during a turn never changes that turn, including turn-end capture, and closing restores the original tools', async t => {
  const f = await fixture(t), original = f.ctx.tools.get('mcp__basic_memory__write_note', f.a);
  f.controller.begin(f.a, 1); await f.controller.set(f.a.session.id, true);
  f.controller.begin(f.a, 1); assert.equal(f.controller.isPure(f.a), false);
  f.controller.end(f.a, 1); assert.equal(f.ctx.tools.get('mcp__basic_memory__write_note', f.a), original);
  f.controller.begin(f.a, 2); assert.equal(f.controller.isPure(f.a), true);
  await f.controller.set(f.a.session.id, false); f.controller.begin(f.a, 2);
  assert.equal(f.controller.isPure(f.a), true); f.controller.end(f.a, 2);
  assert.equal(f.ctx.tools.get('mcp__basic_memory__write_note', f.a), undefined);
  f.controller.begin(f.a, 3); assert.equal(f.ctx.tools.get('mcp__basic_memory__write_note', f.a), original);
  assert.match(await f.prompt(f.a), /SELF_PROFILE/);
});

test('MCP tools registered after pure mode starts are hidden by the same native registry view', async t => {
  const f = await fixture(t); await f.controller.set(f.a.session.id, true); f.controller.begin(f.a, 1);
  f.ctx.tools.register(definition('mcp__basic_memory__new_capability'));
  assert.equal(f.ctx.tools.get('mcp__basic_memory__new_capability', f.a), undefined);
  assert.ok(f.ctx.tools.get('mcp__basic_memory__new_capability', f.b));
  assert.ok(!f.ctx.tools.schemas(f.a).some(tool => tool.name.includes('basic_memory')));
});

test('runtime-owned children inherit pure scope; separate conversations remain normal', async t => {
  const f = await fixture(t); await f.controller.set(f.a.session.id, true); f.controller.begin(f.a, 1);
  const child = f.agent('session-child', f.a); f.controller.begin(child, 1);
  assert.equal(f.controller.isPure(child), true); assert.doesNotMatch(await f.prompt(child), /SELF_PROFILE/);
  assert.equal(f.ctx.tools.get('mcp__basic_memory__read_note', child), undefined);
  assert.equal(f.controller.status(child.session.id).inheritedFrom, f.a.session.id);
  await assert.rejects(f.controller.set(child.session.id, false), /父对话/);
  assert.equal(f.controller.isPure(f.b), false);
});

test('guards identify memory tools and Basic Memory resource access without blocking work MCP resources', () => {
  assert.equal(personalInvocation({ name: 'mcp__basic_memory__read_note' }), true);
  assert.equal(personalInvocation({ name: 'dafeiyu_records' }), true);
  assert.equal(personalTool('recent_conversation'), true);
  assert.equal(personalInvocation({ name: 'recent_conversation' }), true);
  assert.equal(personalTool('recent_conversation_work'), false);
  assert.equal(personalInvocation({ name: 'read_mcp_resource', arguments: { server: 'basic_memory' } }), true);
  assert.equal(personalInvocation({ name: 'read_mcp_resource', arguments: { server: 'work' } }), false);
  assert.equal(personalInvocation({ name: 'read' }), false);
});

test('recent conversation tool follows native pure restrictions, inherited scope and next-turn restoration', async t => {
  const f = await fixture(t);
  const original = f.ctx.tools.get('recent_conversation', f.a);
  assert.ok(original);
  await f.controller.set(f.a.session.id, true);
  f.controller.begin(f.a, 1);
  const child = f.agent('session-recent-child', f.a);
  assert.equal(f.ctx.tools.get('recent_conversation', f.a), undefined);
  assert.equal(f.ctx.tools.get('recent_conversation', child), undefined);
  assert.ok(!f.ctx.tools.schemas(f.a).some(tool => tool.name === 'recent_conversation'));
  assert.ok(f.ctx.tools.schemas(f.b).some(tool => tool.name === 'recent_conversation'));
  await f.controller.set(f.a.session.id, false);
  f.controller.end(f.a, 1);
  assert.equal(f.ctx.tools.get('recent_conversation', f.a), undefined, 'turn-end keeps the active pure policy');
  f.controller.begin(f.a, 2);
  assert.equal(f.ctx.tools.get('recent_conversation', f.a), original);
  assert.equal(f.ctx.tools.get('recent_conversation', child), original);
});

test('installed pure plugin filters recent conversation schemas and guards execution even after late registration', async t => {
  const ctx = new Context(); new SystemPrompt(ctx, {}); new ToolRuntime(ctx, { mode: 'native' });
  const agents = new Map(), scopes = [];
  for (const id of ['session-pure-recent', 'session-normal-recent']) {
    const agent = { session: { id }, status: 'idle' };
    const scope = createScope(ctx, agent); agent.ctx = scope.ctx; scopes.push(scope); agents.set(id, agent);
  }
  const pure = agents.get('session-pure-recent'), normal = agents.get('session-normal-recent');
  ctx.provide('connection', { requestRejection: () => undefined });
  ctx.provide('webServer', { register: () => () => {} });
  ctx.provide('agents', { list: () => [...agents.values()], get: id => agents.get(id) });
  ctx.provide('sessions', { get: id => agents.get(id)?.session });
  ctx.provide('storageDomain', { open: async () => ({ table: () => ({ get: id => ({ enabled: id === pure.session.id }) }), close: async () => {} }) });
  const fiber = ctx.plugin(plugin);
  t.after(async () => { await fiber.dispose(); for (const scope of scopes.reverse()) await scope.dispose(); });
  await fiber.await();
  let calls = 0;
  ctx.tools.register({ ...definition('recent_conversation'), execute: async () => { calls++; return {}; } });
  assert.equal(ctx.tools.get('recent_conversation', pure), undefined);
  assert.ok(ctx.tools.get('recent_conversation', normal));
  // Supply a late schema directly to assembly so this checks the explicit filter,
  // independently of the native tool view above.
  ctx.on('system-prompt/assemble', async () => ({ sections: [{ name: 'engineering:AGENTS', text: 'KEEP_RULES' }], tools: [{ name: 'recent_conversation' }, { name: 'read' }] }));
  const purePrompt = await ctx.systemPrompt.assemble({ agent: pure, scope: pure });
  const normalPrompt = await ctx.systemPrompt.assemble({ agent: normal, scope: normal });
  assert.deepEqual(purePrompt.tools.map(tool => tool.name), ['read']);
  assert.ok(normalPrompt.tools.some(tool => tool.name === 'recent_conversation'));
  assert.equal(purePrompt.sections[0].text, 'KEEP_RULES');
  const run = agent => ctx.tools.execute({ name: 'recent_conversation', arguments: {}, agent, callId: 'recent-' + agent.session.id, signal: new AbortController().signal });
  const denied = await run(pure);
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.error), /当前回合使用纯净模式/);
  assert.equal(calls, 0);
  assert.equal((await run(normal)).isError, false);
  assert.equal(calls, 1);
});

test('storage failure leaves the requested and active mode unchanged', async t => {
  const f = await fixture(t); f.table.put = async () => { throw Error('disk full'); };
  await assert.rejects(f.controller.set(f.a.session.id, true), /disk full/);
  assert.equal(f.controller.status(f.a.session.id).requested, false);
  assert.equal(f.controller.isPure(f.a), false);
});

test('native JSON storage domain persists per-session mode across close/reopen, with no global default change', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-pure-storage-'));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'dsh-pure-storage-')); await fs.rm(root, { recursive: true, force: true }); });
  async function open() {
    const ctx = new Context(); new Storage(ctx); const backend = new JsonStorageBackend(root);
    ctx.storage.backend.register('json', backend);
    const facility = new DomainFacility(ctx, { backend: 'json', routes: {} });
    return { domain: await facility.open(modeDomain), backend };
  }
  const first = await open(); await first.domain.table('sessions').put('session-only-a', { enabled: true, updatedAt: new Date().toISOString() });
  await first.domain.close(); await first.backend.close();
  const second = await open();
  assert.equal(second.domain.table('sessions').get('session-only-a').enabled, true);
  assert.equal(second.domain.table('sessions').get('session-only-b'), undefined);
  await second.domain.close(); await second.backend.close();
});

test('HTTP settings reject unauthenticated, malformed, missing-header, global-scope and unknown-session writes', async t => {
  const f = await fixture(t);
  const server = http.createServer((req, res) => handleRequest({ req, res,
    connection: { requestRejection: request => request.headers['x-test-owner'] === '1' ? undefined : 401 },
    sessions: { get: id => f.agents.get(id) }, controller: f.controller,
    hasSession: async id => id === 'session-cold' || Boolean(f.agents.get(id)),
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const post = (value, headers = {}) => fetch(url + BASE + '/set', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-test-owner': '1', 'x-dsh-pure-mode': '1', ...headers }, body: JSON.stringify(value) });
  assert.equal((await post({ sessionId: f.a.session.id, enabled: true }, { 'x-test-owner': '0' })).status, 401);
  assert.equal((await post({ sessionId: f.a.session.id, enabled: true }, { 'x-dsh-pure-mode': '' })).status, 403);
  assert.equal((await post({ sessionId: f.a.session.id, enabled: true, scope: 'global' })).status, 400);
  assert.equal((await post({ sessionId: '../wrong', enabled: true })).status, 400);
  assert.equal((await post({ sessionId: 'session-unknown', enabled: true })).status, 404);
  assert.equal(f.store.size, 0);
  assert.equal((await post({ sessionId: 'session-cold', enabled: true })).status, 200);
  assert.equal((await post({ sessionId: f.a.session.id, enabled: true })).status, 200);
  const status = await fetch(url + BASE + '/status?sessionId=' + f.a.session.id, { headers: { 'x-test-owner': '1' } }).then(r => r.json());
  assert.equal(status.requested, true); assert.equal(status.active, false); assert.equal(status.pending, true);
  assert.equal(f.controller.status(f.b.session.id).requested, false);
});

test('the unchanged memory bridge skips all four recall channels and creates no capture job under the native pure scope', { skip: !process.env.DSH_MEMORY_BRIDGE_ENTRY && 'Set DSH_MEMORY_BRIDGE_ENTRY to the bridge lib/index.js for integration testing' }, async t => {
  const { createBridge } = await import(pathToFileURL(path.resolve(process.env.DSH_MEMORY_BRIDGE_ENTRY)).href);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-pure-bridge-'));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'dsh-pure-bridge-')); await fs.rm(root, { recursive: true, force: true }); });
  const f = await fixture(t); let llmCalls = 0;
  await f.controller.set(f.a.session.id, true); f.controller.begin(f.a, 1);
  const bridge = createBridge({ config: { vaultPath: path.join(root, 'vault') }, tools: f.ctx.tools,
    llm: { async *stream() { llmCalls++; throw Error('a pure turn must not call the capture model'); } }, logger: { warn() {} } });
  t.after(() => bridge.dispose());
  bridge.onSessionEvent(f.a.session, { type: 'turn/start', data: { turn: 1 } });
  const user = { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我看一下这段代码' }] };
  bridge.onSessionEvent(f.a.session, { type: 'user/message', data: user });
  const decision = await bridge.onPreStep({ agent: f.a, turn: 1, step: 1, messages: [user], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }));
  assert.deepEqual(decision.messages, []);
  bridge.onSessionEvent(f.a.session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '可以，把代码贴过来。' }] } } });
  bridge.onSessionEvent(f.a.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await bridge.waitForIdle();
  assert.equal(llmCalls, 0); assert.equal((await bridge.getRecoveryState()).jobs.length, 0);
  assert.equal((await bridge.getMemoryStatus(f.a.session.id)).jobs[0].reason, 'memory-disabled');
  assert.ok(f.ctx.tools.get('mcp__basic_memory__write_note', f.b), 'normal B stays available');
});
