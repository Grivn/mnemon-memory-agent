<h1 align="center">Mnemon</h1>

<h3 align="center">原始记录，快速判断，慢速思考</h3>
<p align="center"><sub>Raw Records, Fast Judgments, Slow Thoughts</sub></p>

<p align="center">
  <a href="docs/paper/main.pdf"><b>论文</b></a> ·
  <a href="#结果"><b>结果</b></a> ·
  <a href="#复现论文数字"><b>复现</b></a> ·
  <a href="#运行系统"><b>运行</b></a> ·
  <a href="README.md"><b>English</b></a>
</p>

Mnemon 是一个为 LLM 助手设计的长期记忆 Agent。它把对话保存为带日期的原始记录，等问题到来时才开始工作，并按"双系统"理论的方式分工：

- **System 1**：一个快速的决策模型，对检索返回的记录做大量简单的是非判断。
- **System 2**：一个 LLM，负责写少量检索查询、说明回复需要什么，并组织最终回答。
- **后台整合**：把每条记录整合一次，建成链接回记录的索引，让涉及整段对话的问题也能找到检索本身找不到的证据。

本研究的成果将逐步输送到官方项目 [mnemon](https://github.com/mnemon-dev/mnemon) 和 [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon)（见[从研究到产品](#从研究到产品)）。

<p align="center">
  <img src="assets/tradeoff.png" width="920" alt="LoCoMo 与 LongMemEval-S 上准确率与每题上下文的关系：Mnemon 与 OmniMemEval 重测的 14 个系统">
</p>
<p align="center"><sub>准确率与每题送给作答模型的上下文长度。Mnemon（星号）和 OmniMemEval 重测的 14 个系统都用 gpt-4.1-mini 作答。虚线连接成本效益指数相同的点，越靠左上越好。</sub></p>

## 亮点

- **LoCoMo 准确率第一，上下文不到 4k。** 与 OmniMemEval 重测的 14 个系统相比（都用 gpt-4.1-mini 作答）：
  - LoCoMo 得 **91.7%**，15 个系统中第一；LongMemEval-S 得 **83.8%**，13 个系统中第二。
  - 每题只给作答模型约 **3.8k token**。它是唯一一个在两个基准上都超过 80%、上下文又不到 4k 的系统。
- **LoCoMo 上成本效益指数最低**：0.259，第二名为 0.337。
- **LongMemEval-S 上与公开最佳成绩相当。** 用 DeepSeek-V4.1-Flash 作 System 2 时，LongMemEval-S 得 **94.4%**，LoCoMo 得 **92.2%**（修订标签下 95.3%）。
- **千万 token 规模下成本有界。** 从 BEAM-100K 到 BEAM-10M，记录多了 80 倍，每题成本只变为原来的 **1.11** 倍，每题关键路径上的工作量也基本不变。
- **System 1 判断得更好。** 在同样的 14,359 条记录上区分关键证据：
  - Jev 的 AUC 为 **0.942**，DeepSeek 为 0.900，gpt-4.1-mini 为 0.853。
  - 两个 LLM 的延迟是 Jev 的 3–11 倍。
- **同一个模型用在写入时建图，不如直接判断原始记录。** 同一协议下，用 Jev 在写入时把对话组织成关系图的 Jev-Mem 在 LoCoMo 上得 **84.4%**，Mnemon 为 91.7%（高 7.3 分，95% CI 5.5–9.2）。

## 设计思路

### 快速判断，慢速思考

记忆在读取阶段的工作，大部分属于 System 1：一个个彼此独立、标准明确的是非判断。例如：
- 回复该不该用这条记录？
- 它是否已经不再成立？
- 它是否给出了问题所需的第二个日期？

像 [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) 这样的决策模型，三分之一秒就能做出几十个这样的判断。

只有一小部分属于 System 2：写少量检索查询、说清回复需要什么、组织出答案。这些 LLM 做得好，但慢。

正因为判断够快，Mnemon 才能在问题到来时直接读原始记录，而不必事先改写。两套系统之间的规则只读取 System 1 可靠给出的信息，即排序和"是/否"判断；只有当没有任何已判断的记录满足某个需求时，才去调用 System 2。

<p align="center">
  <img src="assets/architecture.png" width="920" alt="Mnemon 的一轮：规划（System 2）、检索、筛选与判断（System 1）、循环、组成 View；后台整合">
</p>
<p align="center"><sub>Mnemon 处理一轮用户消息的过程。它作为 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 的第二个实例，运行在主 Agent 旁边，不改动主 Agent，每轮发布一个 View。</sub></p>

### 写入时不定结构的记忆

在写入时做抽取的系统，必须事先规定什么算事实、什么算实体、什么算偏好，每换一种数据就要重新设计抽取结构。Mnemon 在写入时不对记录做任何判断，只要求存储能按检索返回带日期的记录。

整合出的索引（话题时间线、取值历史、长期指令）叠在原始记录之上，并链接回记录。它只是叠加在记录上的一层，而不是记录的结构；有没有索引，Mnemon 都能读取原始记录。

因此，只要记录能被检索，就能加上这种记忆。论文评测的是对话记忆，因为这是有公开基准的场景；其他类型的存储还没有测过。

## 结果

所有数字都来自 `docs/paper/data/results.json`，由 `runs/` 中的运行记录计算得出。我们的运行由 gpt-4.1-mini 和 DeepSeek-V4.1-Flash 评分；OmniMemEval 用 gpt-4o-mini 评分，评分模型不同约带来 1–2 分的差异。

### 同一协议下的比较（gpt-4.1-mini 作答）

表中列出准确率（%）、每题送给作答模型的上下文，以及成本效益指数：
- 定义：ECI = (1 − 准确率) + 上下文 / 全量上下文 token 数。
- 含义：假设每答错一题，就用一次全量上下文作答来补救，ECI 就是每题的期望成本，越低越好。
- 其他系统的数字来自 OmniMemEval。

| 系统 | LoCoMo | 上下文 | ECI | LongMemEval-S | 上下文 | ECI |
|---|---:|---:|---:|---:|---:|---:|
| **Mnemon** | **91.7** | 3.8k | **0.259** | 83.8 | 3.8k | 0.198 |
| MemOS | 88.83 | 5.4k | 0.362 | **89.2** | 4.2k | **0.147** |
| Cognee | 83.48 | 32.5k | 1.670 | 51.8 | 10.3k | 0.580 |
| EverMemOS | 82.75 | 8.6k | 0.569 | 80.4 | 12.4k | 0.314 |
| Hindsight | 81.99 | 24.7k | 1.322 | 72.2 | 29.8k | 0.561 |
| Mem0 | 77.68 | 17.4k | 1.028 | 56.0 | 0.9k | 0.448 |
| Letta | 77.12 | 14.2k | 0.885 | 77.67 | 49.4k | 0.693 |
| MemMachine | 73.9 | 2.6k | 0.380 | 63.6 | 2.8k | 0.391 |
| mem9 | 73.64 | 1.6k | 0.337 | 78.0 | 3.8k | 0.256 |
| Supermemory | 73.53 | 15.2k | 0.970 | 66.07 | 6.6k | 0.402 |
| MemoryLake | 72.49 | 5.2k | 0.516 | – | – | – |
| Viking Memory | 69.33 | 6.0k | 0.583 | 61.07 | 2.3k | 0.411 |
| Zep | 63.83 | 1.9k | 0.448 | 79.8 | 117.1k | 1.316 |
| Memori | 41.34 | 8.1k | 0.963 | 20.8 | 2.8k | 0.818 |
| Backboard.io | 22.4 | 1.2k | 0.831 | – | – | – |

这里只比较送给作答模型的上下文，因为这是所有系统都公开的唯一成本。Mnemon 的其他成本（规划、Jev、整合）单独列在下面，不计入这个指数。

### 与各项目公开的最好成绩对比

各项目公布的最好成绩，作答模型、评分模型和协议各不相同，所以这张表比较的是宣称，不是系统本身。完整的 20 项及出处见论文表 3。

| 项目 | LoCoMo | LongMemEval-S | 作答模型 / 评分模型 |
|---|---:|---:|---|
| **Mnemon** | 95.3† | 94.4 | DeepSeek-V4.1-Flash（带思考）/ DeepSeek |
| Zep / Graphiti | 94.7 | 90.2 | gpt-5.4（中等推理）/ gpt-5.4 |
| EverMemOS | 93.05 | 83.0 | gpt-4.1-mini / 三个评分模型取平均 |
| Mem0 | 92.5 | 94.4 | gpt-5 / gpt-5 |
| memU | 92.09 | – | 未说明（早期版本） |
| Hindsight | 92.0 | 94.6 | 未说明（论文中：gemini-3-pro 89.6 / 91.4） |
| MemMachine | 91.69 | 93.0 | gpt-4.1-mini；LongMemEval-S 用 gpt-5-mini / gpt-4o-mini |
| MemOS | 88.83 | 89.2 | gpt-4.1-mini / gpt-4o-mini（OmniMemEval） |

† 使用修订后的 LoCoMo 标签（去掉 44 道无法使用的题、改正 25 个答案）；原始标签下为 92.2，其他各项都用原始标签。

### 各基准与各档位的完整成本

表中设置如下：
- 作答模型：gpt-4.1-mini。
- 得分：依次为 gpt-4.1-mini / DeepSeek 评分模型给出的分数（准确率；HaluMem 为答对比例；BEAM 为评分细则得分）。
- 名次：在 OmniMemEval 重测过的系统中的排名。
- 每千题成本：包括作答、规划和 Jev，按标价计算；整合成本是每份历史一次性的花费。
- Jev 调用（依次进行的波数）和检索次数取中位数题目；最后一列是最大一份历史上单次检索的热索引延迟。

| 基准 | 得分 | 名次 | 上下文 | 每千题<br>成本 | 每份历史的<br>整合成本 | Jev 调用<br>（波数） | 检索<br>次数 | 单次<br>检索 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| LoCoMo | 91.7&nbsp;/&nbsp;91.4 | 1/15 | 3.8k | $3.27 | $0.013 | 5 (4) | 7 | 14&nbsp;ms |
| LongMemEval&#8209;S | 83.8&nbsp;/&nbsp;85.4 | 2/13 | 3.8k | $3.33 | $0.017 | 5 (5) | 7 | 14&nbsp;ms |
| HaluMem | 73.3&nbsp;/&nbsp;65.8 | 8/13 | 3.4k | $3.60 | $0.089 | 7 (6) | 10 | 18&nbsp;ms |
| BEAM&#8209;100K | 64.5&nbsp;/&nbsp;60.5 | 10/12 | 3.8k | $4.80 | $0.012 | 9 (7) | 13 | 17&nbsp;ms |
| BEAM&#8209;10M | 51.2&nbsp;/&nbsp;48.8 | 10/12 | 3.8k | $5.32 | $1.62 | 10 (7) | 14 | 248&nbsp;ms |

读取路径上，除了检索索引，没有任何东西随历史增长：
- 规划只读最近的对话。
- Jev 每轮最多筛选 48 条记录。
- View 有固定预算。

System 1 负责广泛地读，System 2 只读一小部分：
- 每题 Jev 读 3.5 万到 7.3 万 token 的记录，是作答模型所读的 9–19 倍。
- Jev 每 token 的价格约为作答模型的十分之一。

**每题的工作量。** 我们的实验在一台笔记本上调用公开的模型 API，所以用关键路径上的工作量（中位数）而不是实测时间来表述延迟：
- System 2：规划一次（两个调用并行），作答一次；循环中要求新检索的题目（占 6–31%）再多一次调用。
- System 1：Jev 调用 5–10 次，分 4–7 波依次进行，每波约 0.34 秒，合计 1.4–2.4 秒。
- 检索：热索引上每次 14–18 毫秒，主要花在查询的向量化上；每题对 journal 的全部读取合计 0.1–0.2 秒。

从 BEAM-100K 到 BEAM-10M，这些数量基本不变。只有检索会随历史增长：它会给每条记录打分，在 BEAM-10M 最大的一份历史（108,810 条记录）上每次 248 毫秒，每题读取合计 3.5 秒；倒排索引和近似最近邻索引可以避免这一点。

### System 1 与 LLM 的对比

<p align="center">
  <img src="assets/system1.png" width="860" alt="Jev、DeepSeek、gpt-4.1-mini 判断同一批记录的 ROC 曲线与单次调用延迟">
</p>

我们让 Jev、DeepSeek 和 gpt-4.1-mini 对同样的 14,359 条记录判断同一个命题。Jev 区分关键证据的效果最好，而且每条记录能判断两个命题，所用时间只相当于 LLM 判断一个。

### 同一个 Jev：判断原始记录，还是写入时建图

同期工作 [Jev-Mem](https://arxiv.org/abs/2609.23986) 把 Jev 用在写入时：给每轮对话分类并连进关系图，再在图上引导检索。我们按本文协议运行了它公开的代码：同样的 1,540 道 LoCoMo 题，gpt-4.1-mini 只看问题、每题作答一次，用同样的两个评分模型。（它公开的评测脚本默认拿标准答案从三次作答中挑最好的一次，我们没有这样做。）

| LoCoMo，gpt-4.1-mini 作答 | Mnemon | Jev-Mem |
|---|---:|---:|
| 准确率（gpt-4.1-mini 评分） | **91.7** | 84.4 |
| 准确率（DeepSeek 评分） | **91.4** | 82.1 |
| 多跳 / 时间（gpt-4.1-mini 评分） | **91.8 / 91.3** | 77.7 / 82.9 |
| 每题上下文 | 3.8k | 2.6k |
| 每份历史的写入成本 | $0.013 | $0.12 |

逐题配对差为 7.3 分（95% CI 5.5–9.2）。提供每题的类别后，Jev-Mem 得 84.0%。两个系统的差别不止在 Jev 用在哪里，所以这不是消融实验；但在决策模型相同的前提下，等问题到来再判断原始记录的一方更准。适配脚本是 `docs/paper/scripts/jevmem_locomo.py`，运行记录在 `runs/jevmem-locomo-20260928`。

## 组件与版本

Mnemon 是 [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) 的研究分支 `codex/jev-replica-practice`：
- 它从 dsh-mnemon 的 **v0.5.13** 发布版本分出（提交 `84d469ff`，2026-09-22），之后经过 224 个提交，发展到本快照 `8843a5ea`。
- 它运行在 DeepSeek Harness **0.1.5-rc.1** 上，没有修改 DSH。
- 除了对 dsh-mnemon 原有代码的 115 行改动，记忆 Agent 全部由新插件构成。

| 组件 | 版本 | 在 Mnemon 中的角色 |
|---|---|---|
| dsh-mnemon | v0.5.13 + 224 个研究提交（`8843a5ea`） | 记忆插件、副本实例和评测工具 |
| DeepSeek Harness（DSH） | 0.1.5-rc.1 | Agent 框架；Mnemon 作为第二个实例运行在主 Agent 旁边 |
| Jev（TypeSafe System One） | `jev-1.13.0`，通过 `@typesafe-ai/sdk` 0.6.0 调用 | System 1：筛选并判断记录和索引条目 |
| gpt-4.1-mini | 2025-04-14 版本，temperature 0 | 标准设置下的 System 2（规划与作答）；评分模型，标准设置下为主评分模型 |
| DeepSeek-V4.1-Flash | API 模型 `deepseek-flash` | 推理设置下的 System 2（作答带思考，规划不带）；整合（不带思考）；评分模型，推理设置下为主评分模型 |
| nomic-embed-text | 本地部署 | 混合检索和索引条目的向量 |
| Node.js / pnpm | v25.1.0 / 11 | 运行环境与包管理 |

每个运行目录都记录了当时的代码提交和模型（`docs/run-commits.json`）；[VERSIONS.md](VERSIONS.md) 列出了全部版本，包括构建工具和数据集。

## 复现论文数字

论文里的每个数字都来自 `docs/paper/scripts/collect.py`，它读取运行记录，不需要任何 API key。

```sh
python3 tools/restore_runs.py                     # 把 runs/ 展开到 runs-expanded/ 并逐个校验
# 放入两个公开数据集：
#   runs-expanded/benchmarks/locomo10.json              LoCoMo（github.com/snap-research/locomo）
#   runs-expanded/benchmarks/longmemeval_s_cleaned.json LongMemEval-S（cleaned 版）
MNEMON_RUNS=$PWD/runs-expanded python3 docs/paper/scripts/collect.py   # 重写 docs/paper/data/results.json
git diff --stat docs/paper/data/results.json      # 无变化：运行记录重现了论文里的数字
TECTONIC=tectonic PYTHON=python3 bash docs/paper/build.sh   # 生成表格、图（matplotlib）和 main.pdf
python3 docs/paper/scripts/arxiv.py --out out/arxiv         # arXiv 源码包（pdfLaTeX，TeX Live 2025）
```

HaluMem 的运行记录不在仓库中（见 [DATA-LICENSES.md](DATA-LICENSES.md)）。缺少这些记录时，`collect.py` 保留已提交的 HaluMem 条目，所以这部分数字无法在本仓库重算，其余数字都可以。

`beam_evidence.py` 还需要 `pyarrow` 和 BEAM 的 `100K.parquet`。统计每题工作量的 `work.py` 和 `retrieval.ts` 需要读取副本的 trace 和 journal，本快照不包含这些文件，它们的结果在 `docs/paper/data/` 中。

## 运行系统

需要 Node.js 25（实验用的是 v25.1.0）和 pnpm 11。

```sh
pnpm install --frozen-lockfile        # 按锁文件安装，DSH 为 0.1.5-rc.1，与实验一致
pnpm run build && pnpm run build:plugins
pnpm -r --filter 'dsh-mnemon-*' test --passWithNoTests
```

真实运行会调用外部模型。密钥放在环境变量或本地 `.env` 中（该文件已被 git 忽略），不要提交进仓库：

| 变量 | 用途 |
|---|---|
| `TYPESAFE_API_KEY` | Jev（System 1） |
| `DEEPSEEK_API_KEY` | DeepSeek 作答、规划、笔记和整合 |
| `OPENAI_API_KEY` | gpt-4.1-mini 运行与评分 |
| `OPENAI_BASE_URL` | 可选，默认使用 OpenAI API |

两题冒烟运行的命令见[英文 README](README.md#run-the-system)。完整系统还需加上以下参数（`scripts/bench/run.ts` 文件开头说明了所有选项）：
- `--simple`；
- 混合检索：`--embed-url <本地 nomic-embed-text 服务>`；
- 整合：`--consolidate deepseek-flash`。

## 关于这份快照

本仓库是研究分支在 `8843a5ea`（2026-09-29）时的冻结快照，不含 git 历史；每个文件都可以通过 `PROVENANCE.json` 追溯到源文件。

<details>
<summary><b>仓库结构</b></summary>

| 路径 | 内容 |
|---|---|
| `docs/paper/` | 论文：LaTeX 源、参考文献、数据、生成的表格和图、`main.pdf` 及其脚本 |
| `docs/reports/` | 论文背后的预注册与研究报告 |
| `docs/pr-assets/` | 只包含报告实际链接的素材 |
| `docs/plans/` | 报告链接的两份设计文档 |
| `runs/` | `collect.py` 读取的运行记录（gzip 压缩），附 `MANIFEST.json` |
| `docs/run-commits.json` | 每个运行目录对应的代码提交和模型 |
| `src/` | 快照提交时的 dsh-mnemon 内核 |
| `plugins/` | 脚本和内核构建需要的 18 个插件 |
| `scripts/` | 评测工具（`scripts/bench`）、副本启动脚本及其依赖 |
| `assets/` | 本 README 中的图，由论文渲染而来 |
| `tools/` | 快照的生成与检查工具 |
| `VERSIONS.md` | DSH、dsh-mnemon、模型和数据集的版本 |
| `DATA-LICENSES.md` | 运行记录中各基准文本的许可，以及哪些内容没有收录 |
| `PROVENANCE.json` | 源提交号，以及每个文件的 git blob 和 SHA-256 |

</details>

<details>
<summary><b>快照的生成与校验</b></summary>

已校验的内容：
- 只用 `runs/` 和两个公开数据集重算出的 `results.json`，与提交的版本逐字节一致；其中 HaluMem 的条目沿用已提交的值，因为它的运行记录不在仓库中。
- 按锁文件安装、内核与插件构建、插件的 223 个测试全部通过。
- 两题冒烟运行两题都给出了回答。
- `tools/audit.py` 扫描干净，工作区和全部提交（`--history`）都是如此。

安装、构建、测试和冒烟运行是在 `e5c7954a` 的快照上校验的。之后刷新到 `f97c5679`、`3bbf7835`、`c461581c`、`7649d8ff`、`65145f69`、`aea19abc`、`44fb4e71` 和 `8843a5ea`，只改了论文部分和运行记录：正文、参考文献、表格与图的脚本、生成的表格、图和 PDF，统计每题工作量的两个脚本和它们的数据，`collect.py`（缺少 HaluMem 记录时保留已提交的条目，并比较 Jev-Mem 与最终版本），为 arXiv 打包源码的 `arxiv.py`，以及 Jev-Mem 的适配脚本和运行记录。系统代码没有变。重算和扫描在 `8843a5ea` 上重新做过。

快照保证什么、不保证什么：
- `PROVENANCE.json` 列出的文件与源提交逐字节一致；`modified` 下的文件只替换了本机路径。
- 论文的运行目录来自 25 个不同的提交（见 `docs/run-commits.json`）。快照是分支的最新提交，不等同于每个历史提交。
- Memory Spaces、Runtime、三层策略这三个插件，只是因为内核界面打包需要才带上，不含它们的测试。

</details>

## 从研究到产品

本研究的成果将逐步输送到两大官方项目 [mnemon](https://github.com/mnemon-dev/mnemon) 和 [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon)，以达到最佳的产品化体验。

本仓库本身保持为冻结的研究快照：
- 它不是 `mnemon` CLI，也不是 Mnemon Agency；评测的系统没有用到 `mnemon` 二进制。
- 它也不是 `dsh-mnemon` 的发布版本。

## 引用

```bibtex
@misc{wang2026mnemon,
  title  = {Mnemon: Raw Records, Fast Judgments, Slow Thoughts},
  author = {Wang, Guangren},
  year   = {2026},
  note   = {Preprint},
  url    = {https://github.com/Grivn/mnemon-memory-agent}
}
```

## 许可与数据

代码来自 dsh-mnemon，采用 MIT 许可（见 `LICENSE`）。这份许可不覆盖运行记录和报告素材中的基准文本，它们遵循各自的许可：LoCoMo 为 CC BY-NC 4.0，LongMemEval 为 MIT，BEAM 为 CC BY-SA 4.0。HaluMem 的运行记录不在仓库中：它的许可（CC BY-NC-ND 4.0）不允许分享改编内容。详见 [DATA-LICENSES.md](DATA-LICENSES.md)，其中也列出了各数据集的署名。

论文本身（`docs/paper` 中的稿件：正文、图、表和 PDF）版权归 Guangren Wang 所有（© 2026，保留所有权利），不适用 MIT 许可；`docs/paper/scripts` 中的脚本适用 MIT 许可。
