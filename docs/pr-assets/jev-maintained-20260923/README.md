# JEV 后台整理实验的证据

结果与解释见 [完整报告](../../reports/jev-optmem-maintained-20260923.md)。

- `original-v5/`：原始布局，窗口全收、按需探索、持续整理三臂。
- `scattered-v5/`：相同问题，必要记忆位于默认窗口之外。
- `continuous-v5/`：同一连续会话、相同前台算法；JEV nap、Local nap、No nap 三臂。
- `summary.json`：从最终报告、压缩原始轨迹、DSH 持久化时间戳交叉复算的汇总，含逐项未命中与冷暖分组。
- `cost-summary.json`：分类 token、前台/后台/预热费用、逐输入明细、官方单价及输入文件哈希；解释见[费用复核报告](../../reports/jev-token-costs-20260923.md)。
- 每个实验目录的 `evaluation.json` 保留全部逐输入结果，`trace-*.jsonl.gz` 保留主副 DSH 请求、观察、发布与导航状态。最终版 `latency.json` 保存 inbox、首段文字及完成时间戳证据。
- `official-main.png` 是官方主 DSH 网页实拍；`official-ui-summary.json` 为核验摘要，`official-audit.json.gz` 为完整持久化会话核验。
- `tests.log` 与 `standalone-artifacts.log` 保存机械测试和独立打包验证输出。

`original/`、`continuous/`、所有 `*-v4/` 是保留的开发轮次，不是最终 v5 成绩。特别是 `continuous-v4` 的一次 API 超时没有发布当前输入的 Candidate，而旧评估器仍给出了 `executionPassed: true`；`initial-audit.json` 明确记录该反例。v5 同时核验实际发布记录、输入版本及决策错误。`official-initial-audit.json.gz` 记录网页实验播种的 Source 实例前缀错误；它没有被删除或并入成功结果。

执行完整不代表质量全部通过。`qualityGate` 要求所有必要证据、所有答案关键词以及旧内容过滤全部通过，不能仅用 `executionPassed` 代替它。答案关键词命中也不是完整事实准确率。All-candidates 指最多 63 条公开窗口结果，不是全库 900 条。

复算（不调用模型）：

```sh
node --experimental-transform-types --disable-warning=ExperimentalWarning scripts/summarize-jev-maintained.mjs
python3 scripts/plot-jev-maintained.py
node scripts/summarize-jev-costs.mjs
```

`latency.json` 已保存完整时间戳证据；重新运行 `inspect-jev-latency.mjs` 还需要 `evaluation.json` 中指向的本地 DSH 会话目录。重新发起真实 API 实验需要在环境中配置 `DEEPSEEK_API_KEY` 和 `TYPESAFE_API_KEY`，命令见报告；凭据不在本目录。
