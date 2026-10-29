# 维护

先读 README.md 的开关边界。实现位于 lib/，测试位于 test/。
修改后运行 npm test 与 npm run privacy；涉及桥联动时设置 DSH_MEMORY_BRIDGE_ENTRY 跑跨包测试并报告跳过项。
保持会话持久化、下一回合生效和已有上下文保留语义。公开文件经审查列入 release-files.json；配置、记录和依赖目录留在发布包外。
