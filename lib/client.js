window.__ModuleLoader__.load({
  id: 'dsh-pure-mode',
  factory: require => {
    const React = require('react'), h = React.createElement;
    const API = '/api/dsh-pure-mode';
    async function request(path, value) {
      const response = await fetch(API + path, { method: value === undefined ? 'GET' : 'POST',
        headers: value === undefined ? {} : { 'content-type': 'application/json', 'x-dsh-pure-mode': '1' },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }), cache: 'no-store' });
      const body = await response.json(); if (!response.ok || !body.ok) throw Error(body.error || '读取失败'); return body;
    }
    function PureModeButton(props) {
      const sessionId = props.sessionId;
      const [state, setState] = React.useState(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
      const current = React.useRef(sessionId); current.current = sessionId;
      const load = React.useCallback(async () => {
        if (!sessionId) return;
        try { const result = await request('/status?sessionId=' + encodeURIComponent(sessionId)); if (current.current === sessionId) { setState(result); setError(''); } }
        catch (err) { if (current.current === sessionId) setError(err.message); }
      }, [sessionId]);
      React.useEffect(() => { setState(null); setBusy(false); setError(''); load(); }, [load]);
      React.useEffect(() => { window.addEventListener('focus', load); return () => window.removeEventListener('focus', load); }, [load]);
      React.useEffect(() => { if (!state?.pending) return; const timer = setInterval(load, 1500); return () => clearInterval(timer); }, [state?.pending, load]);
      async function toggle() {
        if (!state || busy || state.inheritedFrom) return;
        const target = sessionId; setBusy(true); setError('');
        try { const result = await request('/set', { sessionId: target, enabled: !state.requested }); if (current.current === target) setState(result); }
        catch (err) { if (current.current === target) setError(err.message); }
        finally { if (current.current === target) setBusy(false); }
      }
      const enabled = state?.requested === true;
      const description = !sessionId ? '先打开一个对话' : state?.inheritedFrom ? '子代理继承所属任务，请在父对话切换'
        : '仅当前对话；从下一条新消息起生效。停用个人记忆、人设与自我档案，保留AGENTS.md和工作工具。已有上下文不会清除，建议在新对话第一条消息前开启。';
      return h('span', { className: 'dsh-pure-wrap' },
        h('button', { type: 'button', className: 'dsh-pure-trigger' + (enabled ? ' on' : ''),
          title: error || description, 'aria-label': '纯净模式：' + (enabled ? '开' : '关'), 'aria-pressed': state ? enabled : undefined,
          disabled: !sessionId || (!state && !error) || busy || Boolean(state?.inheritedFrom), onClick: state ? toggle : load },
          busy ? '保存中…' : !state && error ? '纯净模式：重试' : '纯净模式：' + (enabled ? '开' : '关'),
          state?.pending ? h('small', { className: 'dsh-pure-pending' }, '下轮生效') : null),
        error ? h('small', { className: 'dsh-pure-error', role: 'alert' }, error) : null);
    }
    return { inject: ['slots'], apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style'); style.id = 'dsh-pure-mode-style';
        style.textContent = '.dsh-pure-wrap{display:inline-flex;align-items:center;gap:5px}.dsh-pure-trigger{background:transparent;border:0;border-radius:8px;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;font:inherit;font-size:13px;line-height:20px;padding:5px 10px;white-space:nowrap}.dsh-pure-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,ButtonFace)}.dsh-pure-trigger.on{color:var(--dsw-alias-brand-primary,#61d5df);background:color-mix(in srgb,currentColor 8%,transparent)}.dsh-pure-trigger:focus-visible{outline:2px solid var(--dsw-focus-ring-color,Highlight);outline-offset:1px}.dsh-pure-trigger:disabled{cursor:default;opacity:.5}.dsh-pure-pending{margin-left:6px;font-size:10px;opacity:.7}.dsh-pure-error{font-size:11px;color:var(--dsw-alias-state-error-primary,#e58b8b)}';
        document.head.appendChild(style); return () => style.remove();
      }, 'pure-mode styles');
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities', id: 'dsh-pure-mode', order: -21,
      }, PureModeButton));
      // Blank prepared sessions hide the title bar until their first message.
      // Reuse its existing options seat so the first turn can already be pure.
      ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
        name: 'conversation.hero.options', id: 'dsh-pure-mode', order: 9,
      }, PureModeButton));
    } };
  },
});
