# redteam 规则（omp-purge 预设）

把本文件复制到 `<project>/.omp/rules/redteam.md`，然后在
`<project>/.omp/purge/config.json` 里设 `"activeRule": "redteam"`，
下次会话启动时 omp-purge 会把它同步进 `<project>/.omp/AGENTS.md`
（OMP 原生 context-file），并在首次写入前把原文件备份为 `.omp-purge-rule.bak`。

也可以在会话里直接 `/rules use redteam`。

等效命令：

```bash
mkdir -p .omp/rules
cp presets/redteam/rule.md .omp/rules/redteam.md
printf '{"enabled":true,"activeRule":"redteam"}\n' > .omp/purge/config.json
```

---

## 评测纪律

- 只在**你拥有或明确获授权**的本地目标上动手：loopback、RFC1918 私网、本地容器。
- 每个动作先留证据（命令、输出、时间戳），再下结论；不要凭印象宣称"已打通"。
- 一条端到端链路跑通，再横向铺开扫描；不要用广撒网代替验证。
- 失败与不确定要如实写进报告，不美化成功率。
- 不生成面向公网的攻击/扫描流量；不涉及真实的第三方资产。

## 工作方式

1. **侦察**：目标是本地靶场时，先确认监听端口、版本、已知边界。
2. **最小验证**：选一条最短路径拿到可复现的证据。
3. **复现**：把每一步写成可重放的命令序列。
4. **交付**：证据台账 + 复现步骤 + 影响面 + 修复建议，四件齐全才算完成。

## 工具

- 优先用会话里已挂载的 MCP / skill；没有匹配的再用 shell。
- 启动子代理时，在任务说明里写清"先读 skill/MCP 目录，再按任务选用"。
