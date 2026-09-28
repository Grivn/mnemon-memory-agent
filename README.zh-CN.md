# Mnemon 记忆 Agent：论文成果

[English](README.md)

本仓库包含技术报告《Read Raw, Judge Fast: Mnemon》（`docs/paper`）所评测的系统、计算论文数字所用的运行记录，以及生成这份快照的工具。

这里的 Mnemon 是一个构建在 DeepSeek Harness（DSH）上的双系统记忆 Agent：一个专用的记忆 DSH 运行在主 DSH 旁边，保存原始对话记录，用大模型规划检索，由 JEV 决策模型判断最新消息需要哪些记忆（系统 1），并把每条记录整理一次，写入一个链接回原始记录的索引。主 DSH 以 View 的形式收到选中的内容。

**它不是什么。** 它不是 `mnemon` CLI（[mnemon-dev/mnemon](https://github.com/mnemon-dev/mnemon)，另一个独立产品），也不是 Mnemon Agency；评测的系统没有用到 `mnemon` 二进制。它也不是 `dsh-mnemon` 的发布版本，而是冻结的研究快照。

**状态。** 快照取自研究分支的 `e5c7954a`（2026-09-28）。论文仍在定稿，数字冻结后会用 `tools/snapshot.py` 重新生成。

## 目录

| 路径 | 内容 |
|---|---|
| `docs/paper/` | 论文：LaTeX 源、参考文献、数据、生成的表格和图、`main.pdf` 及其脚本 |
| `docs/reports/` | 论文引用的预注册和研究报告 |
| `docs/pr-assets/` | 只包含报告实际链接的素材 |
| `docs/plans/` | 报告链接的两份设计文档 |
| `runs/` | `collect.py` 读取的运行记录（gzip 压缩），附 `MANIFEST.json` |
| `docs/run-commits.json` | 每个运行目录对应的代码提交和模型 |
| `src/` | 快照提交时的 dsh-mnemon 内核 |
| `plugins/` | 脚本和内核构建需要的 18 个插件 |
| `scripts/` | 评测工具（`scripts/bench`）、副本启动脚本及其依赖 |
| `tools/` | 快照的生成与检查工具 |
| `VERSIONS.md` | DSH、dsh-mnemon、模型和数据集的版本 |
| `PROVENANCE.json` | 源提交号，以及每个文件的 git blob 和 SHA-256 |

## 复现论文数字（不需要任何 key）

```sh
python3 tools/restore_runs.py                     # 把 runs/ 展开到 runs-expanded/ 并逐个校验
# 放入两个公开数据集：
#   runs-expanded/benchmarks/locomo10.json              LoCoMo
#   runs-expanded/benchmarks/longmemeval_s_cleaned.json LongMemEval-S（cleaned）
MNEMON_RUNS=$PWD/runs-expanded python3 docs/paper/scripts/collect.py
git diff --stat docs/paper/data/results.json      # 只有 HaluMem 的条目会变：它的运行记录不在仓库中
TECTONIC=tectonic PYTHON=python3 bash docs/paper/build.sh
```

## 运行系统

需要 Node.js 25（实验用的是 v25.1.0）和 pnpm 11。

```sh
pnpm install --frozen-lockfile        # 按锁文件安装，DSH 为 0.1.5-rc.1，与实验一致
pnpm run build && pnpm run build:plugins
pnpm -r --filter 'dsh-mnemon-*' test --passWithNoTests
```

真实运行会调用外部模型，密钥放在环境变量或本地 `.env`（已忽略）中，不要提交：`TYPESAFE_API_KEY`（JEV）、`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`，以及可选的 `OPENAI_BASE_URL`（默认 OpenAI API）。两题冒烟运行的命令见英文 README。

## 已验证

- 只用 `runs/` 和两个数据集重算的 `results.json`，除 HaluMem 的条目外与提交的一致；
- 锁文件安装、内核与插件构建、插件的 223 个测试全部通过；
- 两题冒烟运行两题都给出了回答；
- `tools/audit.py` 扫描干净。

## 保真说明

- `PROVENANCE.json` 列出的文件与源提交逐字节一致，`modified` 下的文件只替换了本机路径。
- 论文的运行目录来自 25 个不同的提交（见 `docs/run-commits.json`）；快照是分支的最新提交，不等同于每个历史提交。
- Memory Spaces、Runtime、三层策略这三个插件只因内核界面打包需要而带上，不含它们的测试。
- 不含 git 历史。

## 许可与数据

代码来自 dsh-mnemon，MIT 许可（见 `LICENSE`）。运行记录和报告素材中含有来自 LoCoMo、LongMemEval、BEAM 的文本，再分发前请确认各数据集的许可。HaluMem 的运行记录不在仓库中：它的许可（CC BY-NC-ND 4.0）不允许分享改编内容。
