# dsh-pure-mode

> **兼容范围（2026-10-29）**：本方案已验证 DSH **0.2.1-rc.2**。官方 **0.2.2-alpha.2** 涉及工具、提示词和会话接口调整，尚未完成兼容验证；不要将本次记忆插件更新视为宿主升级许可。先保留现用环境，在隔离部署验证新版。见[官方更新说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-alpha.2)。新版宿主要求 Node.js 24.9+；下文较低运行时要求只对应旧适配基线。

DSH Web 的会话级纯净模式，版本 0.1.0。独立维护，非 DeepSeek 官方插件。

## 安装

基线为 DSH 0.2.1-rc.2、Node.js 22.19+。在选定的 DSH_HOME 和 web profile 中安装：

```powershell
dsh plugin --profile web add github:XRH66/dsh-pure-mode
```

本地源码安装可运行 `npm ci`，再执行 `dsh plugin --profile web add (Get-Location).Path`。安装后在会话空闲时重载对应 Harness。包内没有原机路径，不携带正式配置或记忆数据。

## 开关边界

- 默认关；设置按会话持久保存，重开该会话仍保留选择，不改变其他独立会话。
- 在空白会话选项区或对话页头切换；下一条用户消息开启的新回合生效，正在执行的回合及其结束整理沿用原状态。
- 此前普通回合已产生的后台整理任务不会被开关自动取消；升级时须另外隔离后台写入。
- 已有上下文和聊天记录保留。希望从第一轮开始纯净，请在新会话首条消息前打开。
- 生效后停用约定的个人记忆工具、人设和自我档案注入；近期对话工具及兼容记忆桥的近期缓存读写停用。不会删除已有缓存、Vault 或人设。
- Basic Memory 的勾选不改；通过原生会话工具作用域与执行守卫限制访问。桥须尊重工具可用状态；任意第三方后台插件不在此保证范围内。
- AGENTS 工程规则、普通文件和工作工具保留。它不是文件系统隔离或清除上下文功能。
- Harness 所属子代理继承父任务模式，独立会话不受影响。关闭后下一新回合恢复。

接口为 `GET /api/dsh-pure-mode/status?sessionId=...` 和 `POST /api/dsh-pure-mode/set`；写入 JSON 为 `{ "sessionId": "session-example", "enabled": true }`，需要 `x-dsh-pure-mode: 1`，沿用 Harness 连接访问校验。

## 开发验证

```powershell
npm ci
npm test
npm run privacy
```

测试使用临时目录和本地随机端口，不调用真实模型。原生 Cordis、SystemPrompt、ToolRuntime、Scope、Storage、JSON storage 和 DomainFacility 测试依赖已声明在 devDependencies；不是用模拟接口替代原生行为。开发依赖不会随插件打包。

跨包记忆桥测试默认跳过；设置 `DSH_MEMORY_BRIDGE_ENTRY` 为兼容桥的 `lib/index.js` 绝对路径后运行 `npm test` 可启用，不要求特定机器目录。测试包含原生持久化、回合边界、子代理继承、工具限制和 HTTP 校验；实际浏览器及真实模型部署需另行验证。

公开文件由 release-files.json 明确列出，隐私脚本复用 dsh-global-settings 的检查。安装、升级与回退见主仓库 [docs/upgrade.md](https://github.com/XRH66/codex-deepseek-starter/blob/main/docs/upgrade.md)。

## 许可

MIT 适用于本仓库自研插件、测试和文档。代码审查范围为 lib/、test/ 和 bundle patch；未复制 DSH 实现、依赖源码或本机备份。原生 DSH 与 Zod 通过包依赖引用，保留各自许可，不因本仓库许可改变归属。

## 本次发布与维护边界

本页说明对应已发布插件；公开副本不代表用户的运行进程已经更新。升级先核对版本和路径、备份，再按[统一升级指南](https://github.com/XRH66/codex-deepseek-starter/blob/main/docs/upgrade.md)操作。每次涉及重启，执行者必须先说明影响、保存本地续接记录并暂停，等待用户手动重启；随后核验实际加载。旧库整理在基础设施验收后单独执行。
