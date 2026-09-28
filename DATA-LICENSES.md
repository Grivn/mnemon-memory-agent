# Data licenses

The MIT license in `LICENSE` covers the code only. The run records in `runs/` and some report assets in
`docs/pr-assets/` contain text from the benchmarks the paper evaluates: dialogue turns, questions, reference answers,
and what the system wrote from them (Views, consolidated indexes, answers). That text stays under each benchmark's
own license.

| Benchmark | License | In this repository |
|---|---|---|
| [LoCoMo](https://github.com/snap-research/locomo) | [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) | Run records of the LoCoMo runs. Non-commercial use only, with attribution. |
| [LongMemEval](https://github.com/xiaowu0162/LongMemEval) | MIT, Copyright (c) 2024 Di Wu | Run records of the LongMemEval-S runs. The MIT notice is reproduced below. |
| [BEAM](https://github.com/mohammadtavakoli78/BEAM) | Data: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | Run records of the BEAM-100K and BEAM-10M runs (`runs/phase03-20260925/heldout/beam*`). Material adapted from BEAM is shared under CC BY-SA 4.0. |
| [HaluMem](https://github.com/MemTensor/HaluMem) | [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/) | **Not included.** The license allows no adapted material to be shared, so HaluMem's run records are left out. |

The licenses were checked at their sources on 2026-09-28: each project's repository, and HaluMem's dataset card on
Hugging Face.

## What is left out, and what that changes

- HaluMem's run records are not in `runs/`, and `.gitignore` and `tools/audit.py` keep them out.
- The paper's HaluMem numbers stay in `docs/paper/data/results.json`. They are aggregate scores, not HaluMem's text.
- `docs/paper/scripts/collect.py` recomputes every other number from `runs/`. When HaluMem's records are absent, it
  keeps the committed HaluMem entries as they are, so the recomputed `results.json` still equals the committed one.
  The HaluMem numbers themselves cannot be recomputed from this repository.
- The datasets themselves are not packaged. Download LoCoMo and LongMemEval-S as the README describes.

## Attribution

- LoCoMo: A. Maharana, D.-H. Lee, S. Tulyakov, M. Bansal, F. Barbieri and Y. Fang. Evaluating very long-term
  conversational memory of LLM agents. ACL 2024.
- LongMemEval: D. Wu, H. Wang, W. Yu, Y. Zhang, K.-W. Chang and D. Yu. LongMemEval: Benchmarking chat assistants on
  long-term interactive memory. ICLR 2025.
- BEAM: M. Tavakoli, A. Salemi, C. Ye, M. Abdalla, H. Zamani and J. R. Mitchell. Beyond a million tokens:
  Benchmarking and enhancing long-term memory in LLMs. ICLR 2026.
- HaluMem: D. Chen et al. HaluMem: Evaluating hallucinations in memory systems of agents. arXiv:2511.03506, 2025.

The paper's bibliography (`docs/paper/references.bib`) gives the full references.

## LongMemEval's MIT notice

```
MIT License

Copyright (c) 2024 Di Wu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
