# 长任务实验原始数据

正式比较保存在 `formal/`，实验设计见 `../../plans/jev-long-tasks-experiment.md`。

已完成三类任务 × 32 次输入 × 三种策略 × 两次重复，共 576 次输入。结论与解释见[实验报告](../../reports/jev-long-tasks-20260923.md)，计量见 [metrics.md](formal/metrics.md)。`evaluation.json` 的 `executionPassed=false` 保留了预算终止和五次旧 View；完成采集不代表系统通过验收。

每个运行目录的 `trace.jsonl.br`（运行期间为 `.gz`）包含逐次主模型请求的计量和装配后的文本部分、工具输入输出、时序和副本审计；它不是原始 HTTP 报文转储。结束后仅更换无损压缩格式，`trace-archive.json` 记录解压内容和两种压缩文件的 SHA-256。`outputs/` 是该运行独立产生的最终文件，`phase1/` 是切换新会话前的文件快照。交付文件由被测模型生成，不能将文件中的叙述当作人工验收结论。

原始产物、浏览器下载的 CSV 和绘图导出的 SVG 保留原始换行与空白，不为通过代码的 whitespace 检查而重写。代码和报告的 whitespace 检查排除 `formal/` 资料目录；产物完整性使用哈希校验。

`evaluation.json` 是冻结的逐输入结果；`summary.json` 是逐请求用量核验后的汇总；`manual-review.json` 是助手的事后语义审查（非盲评）；`domain-review.json` 解释功能验收与备份结构差异；`browser/inspection.json` 保留真实网页操作及截图。浏览器首版定位器误假定邮箱必须为 `type=email`、备份必须下载，原记录另存 `inspection-initial.json`；之后按实际页面标签、文本框与下载按钮适配，不修改被测页面。

`memoryText` 代表所有保留的 Mnemon 插件消息，包含历史 View，不能当作最新一次选中内容。`summary.json` 的 `contextHistory` 同时列出历史快照数量、累计字符、最新快照及当前候选正文，帮助区分两者。不同统计量的字符数不等同于 API token。

`summary.json` 按决策用途分摊前台和后台用量，包含前台选择失败、未能发布新候选时已发生的调用。`api-failures.json` 列出正式运行中 20 次未返回用量的调用；`calibration-costs.json` 在本目录单列正式比较之外的已知试跑费用。`transport-update-case.json` 和 `memory-feedback-case.json` 保留具体材料可达性与错误写回案例。

校准记录保留但不计入正式比较：

- `pilot/`：主动 Source 查询误用了管理 read 接口，多种 Source 不支持该入口。
- `pilot-v2/`：已改用公开 Route；仍缺少卡片和文件的进一步读取入口，4096 输出上限也会截断代码工具参数。
- `pilot-v3/`：验证三臂共用的进一步读取入口和 8192 输出上限。
- `serial-prefix/`：只并发场景、串行等待策略组的首段运行，107 次输入后统一停止，未产生最终验收分数。为降低外层等待，正式比较改为独立策略组并发并从头运行。保留中断会话、文件和记录，不与新负载条件的延迟混算。

小样没有走完全部需求变更，因此其“最终验收”必然包含尚未下达的要求，不能用来评价策略的最终质量。正式运行失败或不利结果保留，不按得分选择重跑。

费用按供应商返回的用量和公开单价估算，包含预热与后台调用；被取消且没有返回用量的调用另行计数，不假定免费。凭据只通过进程环境传递，未写入这些资料。
