import { z } from 'zod';

export const name = 'pure-mode';
export const inject = ['connection', 'webServer', 'systemPrompt', 'tools', 'agents', 'sessions', 'storageDomain'];
export const BASE = '/api/dsh-pure-mode';
export const PERSONA_SECTION = 'deployment:dafeiyu-persona';
export const modeDomain = {
  name: 'pure_mode', version: 1, layout: 'single',
  tables: { sessions: { valueSchema: z.object({ enabled: z.boolean(), updatedAt: z.string() }) } },
};

export function personalTool(name) {
  return String(name).startsWith('mcp__basic_memory__') || ['dafeiyu_records', 'soften_memory', 'recent_conversation'].includes(name);
}

export function personalInvocation(exec) {
  return personalTool(exec.name) || (['list_mcp_resources', 'read_mcp_resource', 'list_mcp_resource_templates'].includes(exec.name)
    && exec.arguments?.server === 'basic_memory');
}

/** One persisted preference per root session; active policy is frozen per turn. */
export function createPureMode({ table, agents, tools, logger, now = () => new Date() }) {
  const states = new Map();
  let refreshing = false;
  const idOf = agent => agent?.session?.id;
  const wanted = id => table.get(id)?.enabled === true;
  const parentOf = agent => agents.list().find(parent => parent !== agent && agents.isOwnedBy?.(idOf(agent), parent));

  function isPure(agent, seen = new Set()) {
    if (!agent || seen.has(agent)) return false;
    seen.add(agent);
    const own = states.get(agent);
    if (own?.active) return true;
    const parent = parentOf(agent);
    return parent ? isPure(parent, seen) : !own && wanted(idOf(agent));
  }

  function attach(agent) {
    if (!agent || states.has(agent)) return;
    states.set(agent, { active: wanted(idOf(agent)), open: agent.status === 'running', turn: null, key: '', releaseTools: null, releasePersona: null });
    refresh();
  }

  function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      for (const [agent, state] of states) {
        const enabled = isPure(agent);
        const scopedTools = agent.ctx?.get?.('tools') || agent.ctx?.tools;
        const scopedPrompt = agent.ctx?.get?.('systemPrompt') || agent.ctx?.systemPrompt;
        if (!scopedTools || !scopedPrompt) throw Error('Pure mode requires the native agent scope');
        const deny = enabled ? [...tools.view(agent).restrictableNames].filter(personalTool).sort() : [];
        const key = deny.join('\0');
        if (key !== state.key) {
          const release = state.releaseTools; state.releaseTools = null; state.key = key;
          release?.();
          if (deny.length) state.releaseTools = scopedTools.restrict({ deny });
        }
        if (enabled && !state.releasePersona) state.releasePersona = scopedPrompt.section({
          name: PERSONA_SECTION, order: 1, interpolate: false, text: '',
        });
        else if (!enabled && state.releasePersona) {
          const release = state.releasePersona; state.releasePersona = null; release();
        }
      }
    } finally { refreshing = false; }
  }

  function begin(agent, turn) {
    attach(agent); const state = states.get(agent);
    if (!state || state.turn === turn) return;
    state.turn = turn; state.open = true; state.active = wanted(idOf(agent)); refresh();
  }

  function end(agent, turn) {
    const state = states.get(agent); if (state?.turn === turn) state.open = false;
    // Keep this scope until the NEXT turn starts: turn-end capture is allowed
    // to inspect the same policy the just-finished user turn actually used.
  }

  function status(sessionId) {
    const agent = agents.get(sessionId), parent = agent && parentOf(agent), state = agent && states.get(agent);
    const requested = parent ? isPure(parent) : wanted(sessionId);
    const active = agent ? isPure(agent) : requested;
    return { ok: true, sessionId, requested, active, pending: Boolean(state && active !== requested),
      running: Boolean(state?.open), turn: state?.turn ?? null, inheritedFrom: idOf(parent) || null,
      effective: 'next-user-turn', history: 'existing-context-retained', defaultEnabled: false };
  }

  async function set(sessionId, enabled) {
    const agent = agents.get(sessionId);
    if (agent && parentOf(agent)) throw Object.assign(Error('子代理继承所属任务的纯净设置，请在父对话切换'), { status: 409 });
    await table.put(sessionId, { enabled, updatedAt: now().toISOString() });
    return status(sessionId);
  }

  function forget(agent) {
    const state = states.get(agent); if (!state) return;
    states.delete(agent); state.releaseTools?.(); state.releasePersona?.();
  }

  function dispose() { for (const agent of [...states.keys()]) forget(agent); }
  return { attach, begin, end, refresh, isPure, status, set, forget, dispose };
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

const sessionIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
export async function handleRequest({ req, res, connection, sessions, controller, hasSession = id => Boolean(sessions.get(id)) }) {
  const rejection = connection.requestRejection({ headers: req.headers });
  if (rejection !== undefined) return json(res, rejection, { ok: false, error: '请从已登录的本机DSH打开' });
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === BASE + '/status') {
      const id = sessionIdSchema.parse(url.searchParams.get('sessionId'));
      return json(res, 200, controller.status(id));
    }
    if (req.method === 'POST' && url.pathname === BASE + '/set') {
      if (req.headers['x-dsh-pure-mode'] !== '1') return json(res, 403, { ok: false, error: '缺少设置请求标记' });
      if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { ok: false, error: '需要JSON请求' });
      const buffers = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4096) return json(res, 413, { ok: false, error: '请求过大' }); buffers.push(chunk); }
      const value = z.object({ sessionId: sessionIdSchema, enabled: z.boolean() }).strict().parse(JSON.parse(Buffer.concat(buffers).toString('utf8')));
      // A UI header always addresses a loaded Session. Do not create preferences
      // for arbitrary ids supplied by unrelated requests.
      if (!await hasSession(value.sessionId)) return json(res, 404, { ok: false, error: '请先打开这个对话' });
      return json(res, 200, await controller.set(value.sessionId, value.enabled));
    }
    return json(res, 404, { ok: false, error: '未知设置入口' });
  } catch (error) {
    return json(res, error.status || (error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500), { ok: false, error: error.status ? error.message : '纯净模式设置失败，请重试' });
  }
}

export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(modeDomain);
  const controller = createPureMode({ table: domain.table('sessions'), agents: ctx.agents, tools: ctx.tools, logger: ctx.logger });
  for (const agent of ctx.agents.list()) controller.attach(agent);
  ctx.on('agent/created', ({ agent }) => controller.attach(agent));
  ctx.on('agent/disposed', ({ agent }) => controller.forget(agent));
  ctx.on('tools/change', () => controller.refresh());
  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id); if (!agent) return;
    if (event.type === 'turn/start') controller.begin(agent, event.data.turn);
    else if (event.type === 'turn/end') controller.end(agent, event.data.turn);
  }, { prepend: true });
  ctx.on('agent/pre-step', (payload, next) => { controller.begin(payload.agent, payload.turn); return next(); }, { prepend: true });
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    if (!controller.isPure(context?.agent)) return assembly;
    // Tool restrictions already affect native/PTC schema generation. Also
    // filter explicitly so later MCP registration cannot expose a new schema.
    return { ...assembly, sections: assembly.sections.filter(section => section.name !== PERSONA_SECTION),
      tools: assembly.tools.filter(tool => !personalTool(tool.name)) };
  });
  const releaseGuard = ctx.tools.guard(exec => controller.isPure(exec.agent) && personalInvocation(exec)
    ? '当前回合使用纯净模式，个人记忆工具不可用' : undefined);
  const releaseRoute = ctx.webServer.register({ kind: 'prefix', path: BASE,
    handler: (req, res) => handleRequest({ req, res, connection: ctx.connection, sessions: ctx.sessions, controller,
      hasSession: async id => Boolean(ctx.sessions.get(id) || await ctx.get('sessionPersistence')?.stat(id, { signal: AbortSignal.timeout(5000) })) }) });
  ctx.effect(() => async () => { releaseRoute(); releaseGuard(); controller.dispose(); await domain.close(); }, 'pure-mode cleanup');
}
