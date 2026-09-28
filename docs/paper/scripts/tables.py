"""Write the paper's result tables (tables/*.tex) from data/results.json and data/reported.json, so that no number is
typed by hand. Run after collect.py:

    python3 docs/paper/scripts/tables.py
"""
import json, math
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
R = json.load(open(HERE / 'data/results.json'))
P = json.load(open(HERE / 'data/reported.json'))
OUT = HERE / 'tables'
OUT.mkdir(exist_ok=True)
FULL = P['full_context_tokens']
MINI_IN = R['prices_per_million']['gpt-4.1-mini']['miss']

def write(name, text):
    (OUT / f'{name}.tex').write_text(text.strip() + '\n'); print('wrote', OUT / f'{name}.tex')
f1 = lambda v: '--' if v is None else f'{v:.1f}'
def given(v):
    """A published number as it was published: two decimals when it has them, otherwise one."""
    if v is None: return '--'
    s = f'{v:.2f}'
    return s[:-1] if s.endswith('0') else s
def bold_max(values, fmt=f1):
    """Format a column, bolding its maximum."""
    real = [v for v in values if v is not None]
    top = max(real) if real else None
    return [('\\best{' + fmt(v) + '}') if v is not None and v == top else fmt(v) for v in values]
def pval(p): return '$<$0.001' if p < 0.001 else f'{p:.3f}' if p < 0.1 else f'{p:.2f}'
def mcnemar_p(b, c):
    n = b + c
    return 1.0 if n == 0 else min(1.0, 2 * sum(math.comb(n, i) for i in range(min(b, c) + 1)) / 2 ** n)
def signed(v, digits=1):
    if abs(v) < 0.5 * 10 ** -digits: return f'{0:.{digits}f}'
    return ('+' if v > 0 else '$-$') + f'{abs(v):.{digits}f}'
def flip(d): return f"{signed(d['diff'])} (+{d['up']}/$-${d['down']}, $p$\\,=\\,{pval(d['p'])})".replace('$p$\\,=\\,$<$', '$p$\\,$<$\\,')

LOCOMO_TYPES = ['single-hop', 'multi-hop', 'temporal', 'open-domain']
LME_TYPES = ['single-session-user', 'single-session-assistant', 'single-session-preference', 'temporal-reasoning', 'multi-session', 'knowledge-update']
NAMES = {'S0': 'Cue recall (S0)', 'S4h': '+ hybrid retrieval (S4h)', 'S5h': '+ judge--act loop (S5h)', 'S6': '+ unsure fill (S6)',
         'S6 (rerun)': '+ unsure fill, second run', 'simple': '+ budgets = \\sys{} w/o consolidation', 'fast': '+ unsure fill, no planner', 'simple-fast': 'w/o consolidation, no planner',
         'final': '+ consolidation = \\sys{}'}

# The paper's main configurations in the standard setting: the adopted simple mode and its fast variant once they have
# been measured with gpt-4.1-mini (amendment 15); until then their predecessors, S6 and its fast mode.
_std = [R['gpt41mini_chain'][d]['runs'] for d in ('locomo', 'lme')]
MAIN = ('simple', 'simple-fast') if all('simple' in runs and 'simple-fast' in runs for runs in _std) else ('S6', 'fast')
MAIN_LABEL = {MAIN[0]: 'w/o consolidation', MAIN[1]: 'w/o consolidation, no planner'}
# The final version (consolidation on, amendments 29-34), from collect.py's `final` block; `\pending` marks a number
# whose run has not finished.
F = R.get('final', {})
PENDING = '\\pending{}'
WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
         'thirteenth', 'fourteenth', 'fifteenth']
def done(setting, key):
    """A finished final-version comparison (both sides graded and paired), or None."""
    x = F.get(setting, {}).get(key)
    return x if x and x.get('paired') else None

# ------------------------------------------------------------------------------------------------------------------
# Standard setting: accuracy overall (both judges) and by type.
def main_standard():
    rows = []
    for ds, types, head in (('locomo', LOCOMO_TYPES, ['single-hop', 'multi-hop', 'temporal', 'open-domain', '', '']),
                            ('lme', LME_TYPES, ['SS-user', 'SS-asst.', 'SS-pref.', 'temporal', 'multi-sess.', 'know.\\ upd.'])):
        c = R['gpt41mini_chain'][ds]
        runs = ['S0', 'S4h', 'S6', 'fast'] + [x for x in ('simple', 'simple-fast', 'final') if x in R['gpt41mini_chain'][ds]['runs']]
        title = f"LoCoMo ({c['questions']:,} questions)" if ds == 'locomo' else f"\\lme{{}} ({c['questions']} questions)"
        rows.append(f"\\midrule\n\\multicolumn{{9}}{{@{{}}l}}{{\\textit{{{title}}}}} \\\\")
        rows.append(' & gpt-4.1-mini & DeepSeek & ' + ' & '.join(head) + ' \\\\')
        cols = [bold_max([c['runs'][r]['mini']['accuracy'] for r in runs]), bold_max([c['runs'][r]['deepseek']['accuracy'] for r in runs])]
        cols += [bold_max([c['runs'][r]['mini']['per_type'][t] for r in runs]) for t in types]
        cols += [[''] * len(runs)] * (6 - len(types))
        for i, r in enumerate(runs):
            rows.append(NAMES[r] + ' & ' + ' & '.join(col[i] for col in cols) + ' \\\\')
    write('main_standard', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{Standard setting: gpt-4.1-mini answers and plans.} Accuracy (\%) overall under both judges, and by question type under the gpt-4.1-mini judge. Each row adds one design step (pre-registration codes in parentheses; with gpt-4.1-mini the loop and the unsure fill came in one step); the budgets give \sys{} w/o consolidation (amendment~15), and consolidation gives \sys{} (amendments 30 and 34, exploratory); ``no planner'' rows drop the planner. Best per column in bold.}
\label{tab:main}
\setlength{\tabcolsep}{4.2pt}
\resizebox{\linewidth}{!}{%
\begin{tabular}{@{}l cc cccccc@{}}
\toprule
& \multicolumn{2}{c}{Overall, judged by} & \multicolumn{6}{c}{By type (gpt-4.1-mini judge)} \\
\cmidrule(lr){2-3}\cmidrule(l){4-9}
''' + '\n'.join(rows) + r'''
\bottomrule
\end{tabular}}
\end{gentable}''')

# Paired tests in the standard setting.
def paired_standard():
    lines = []
    ladder = (('S4h vs S0', 'S4h vs S0 (hybrid retrieval)'), ('S6 vs S4h', 'S6 vs S4h (loop, unsure fill)'), ('S6 vs S0', 'S6 vs S0 (all changes)'), ('fast vs S6', 'Fast vs S6 (no planner)'))
    # Amendment 15's comparisons, once its runs are in: the adopted simple mode against S6 and S0, its fast variant
    # against the simple mode and against the earlier fast mode.
    adopted = (('simple vs S6', 'Budgets for rules (w/o consolidation vs S6)'), ('simple vs S0', 'w/o consolidation vs cue recall'),
               ('simple-fast vs simple', 'No planner (w/o consolidation)'), ('simple-fast vs fast', 'No planner: budgets vs S6 rules'))
    final = (('final vs simple', 'Consolidation (\\sys{} vs w/o consolidation)'), ('final vs S0', '\\sys{} vs cue recall (all steps)'))
    pairs = [R['gpt41mini_chain'][d]['paired_mini_judge'] for d in ('locomo', 'lme')]
    for block in (ladder, adopted, final):
        present = [(key, label) for key, label in block if all(key in p for p in pairs)]
        if present and lines: lines.append('\\midrule')
        for key, label in present:
            lines.append(f"{label} & {flip(pairs[0][key]['all'])} & {flip(pairs[1][key]['all'])} \\\\")
    write('paired_standard', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{Paired comparisons in the standard setting} (gpt-4.1-mini judge): net change in points, questions gained and lost, exact McNemar $p$.}
\label{tab:paired-standard}
\begin{tabular}{@{}lll@{}}
\toprule
& LoCoMo (1,540) & \lme{} (500) \\
\midrule
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')

# Cost, latency and process measures in the standard setting.
def costs_standard():
    lines = []
    for ds, label in (('locomo', 'LoCoMo'), ('lme', '\\lme')):
        lines.append(f'\\midrule\n\\multicolumn{{10}}{{@{{}}l}}{{\\textit{{{label}}}}} \\\\')
        for r in ['S0', 'S4h', 'S6', 'fast'] + [x for x in ('simple', 'simple-fast', 'final') if x in R['gpt41mini_chain'][ds]['runs']]:
            d = R['gpt41mini_chain'][ds]['runs'][r]['mini']; c = d['cost_per_question']
            lines.append(f"{NAMES[r]} & {d['latency_p50_s']:.1f} / {d['latency_p90_s']:.1f} & {d['view_items']:.1f} & {d['answer_input_tokens']:,} & {d['evidence_all_shown']:.1f} & "
                         f"{d['jev_tokens'] / 1000:.1f} & {d['jev_calls']:.2f} & {1e3 * c['answer']:.2f} & {1e3 * c['planner']:.2f} & {1e3 * c['jev']:.2f} / \\textbf{{{1e3 * c['total']:.2f}}} \\\\")
    write('costs_standard', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{Cost and process in the standard setting.} Latency per question (median / 90th percentile); records in the View; input tokens of the answering call; share of questions with all gold evidence in the View; \jev{} input tokens and calls per question; cost per question in thousandths of a dollar (answer, planner, \jev{} / total) at list prices.}
\label{tab:costs-standard}
\setlength{\tabcolsep}{3.6pt}
\begin{tabular}{@{}l cccc cc ccc@{}}
\toprule
& latency (s) & View & answer & evidence & \multicolumn{2}{c}{\jev{} per question} & \multicolumn{3}{c}{cost ($10^{-3}$\,\$)} \\
\cmidrule(lr){6-7}\cmidrule(l){8-10}
& p50 / p90 & records & input tok. & all shown & k tok. & calls & answer & planner & \jev{} / total \\
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')

# Reasoning setting: the ladder with DeepSeek answering, planning and judging.
def deepseek_ladder():
    L, M = R['deepseek_chain']['locomo'], R['deepseek_chain']['lme']
    runs = ['S0', 'S4h', 'S5h', 'S6', 'S6 (rerun)', 'simple'] + (['final'] if 'final' in L['runs'] and 'final' in M['runs'] else [])
    acc_l = bold_max([L['runs'][r]['deepseek']['accuracy'] for r in runs]); acc_m = bold_max([M['runs'][r]['deepseek']['accuracy'] for r in runs])
    lines = []
    for i, r in enumerate(runs):
        l, m = L['runs'][r]['deepseek'], M['runs'][r]['deepseek']
        lines.append(f"{NAMES[r]} & {acc_l[i]} & {acc_m[i]} & {l['view_items']:.1f} / {m['view_items']:.1f} & {l['answer_input_tokens']:,} / {m['answer_input_tokens']:,} & "
                     f"{l['evidence_all_shown']:.1f} / {m['evidence_all_shown']:.1f} & {l['jev_tokens'] / 1000:.1f} / {m['jev_tokens'] / 1000:.1f} & "
                     f"{1e3 * l['cost_per_question']['total']:.2f} / {1e3 * m['cost_per_question']['total']:.2f} & {l['latency_p50_s']:.1f} / {m['latency_p50_s']:.1f} \\\\")
        if r == 'S6': lines.append('\\addlinespace[2pt]')
    pairs = []
    for key, label in (('S4h vs S0', 'S4h vs S0'), ('S5h vs S4h', 'S5h vs S4h'), ('S6 vs S5h', 'S6 vs S5h'), ('S5h vs S0', 'S5h vs S0'), ('S6 (rerun) vs S6', 'S6, second run vs first'),
                       ('final vs simple', 'Consolidation (\\sys{} vs w/o consolidation)'), ('final vs S0', '\\sys{} vs cue recall (all steps)')):
        if key not in L['paired_deepseek_judge'] or key not in M['paired_deepseek_judge']: continue
        pairs.append(f"{label} & {flip(L['paired_deepseek_judge'][key]['all'])} & {flip(M['paired_deepseek_judge'][key]['all'])} \\\\")
    write('deepseek_ladder', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{Reasoning setting: DeepSeek-V4.1-Flash answers and plans, DeepSeek judges.} Top: accuracy (\%) and process measures, LoCoMo / \lme, on the ''' + f"{L['questions']:,}" + r''' LoCoMo and 500 \lme{} questions every run answered. The second S6 run and the budgets (\sys{} w/o consolidation) were run side by side (\cref{sec:simple}); consolidation gives \sys{} (amendment~31, exploratory). Bottom: paired comparisons.}
\label{tab:deepseek}
\setlength{\tabcolsep}{3.4pt}
\resizebox{\linewidth}{!}{%
\begin{tabular}{@{}l cc cccccc@{}}
\toprule
& LoCoMo & \lme & View records & answer input tok. & evidence all shown & \jev{} k tok. & cost ($10^{-3}$\,\$) & p50 (s) \\
\midrule
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}}

\vspace{4pt}
\begin{tabular}{@{}lll@{}}
\toprule
Paired (DeepSeek judge) & LoCoMo & \lme \\
\midrule
''' + '\n'.join(pairs) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')

# Simple mode vs S6, run side by side.
def simple_table():
    S, ni = R['simple_vs_s6'], R['simple_noninferiority']
    lines = []
    for ds, label in (('locomo', 'LoCoMo'), ('lme', '\\lme{}')):
        s6, sm, t = S[ds]['runs']['S6']['deepseek'], S[ds]['runs']['simple']['deepseek'], S[ds]['paired']['all']
        lines.append(f"{label} ({S[ds]['questions']:,}) & {s6['accuracy']:.1f} & {sm['accuracy']:.1f} & {flip(t)} & "
                     f"{1e3 * s6['cost_per_question']['total']:.2f} $\\to$ {1e3 * sm['cost_per_question']['total']:.2f} & {s6['latency_p50_s']:.1f} $\\to$ {sm['latency_p50_s']:.1f} & "
                     f"{s6['view_items']:.1f} $\\to$ {sm['view_items']:.1f} & {s6['evidence_all_shown']:.1f} $\\to$ {sm['evidence_all_shown']:.1f} \\\\")
    write('simple', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{Budgets for rules: \sys{} w/o consolidation against S6}, both with DeepSeek answering, planning and judging, run side by side. Pooled over both benchmarks (''' + f"{ni['n']:,}" + r''' questions) the paired difference is ''' + signed(ni['diff'], 2).replace('+', '') + r''' points, 95\% interval [''' + f"{signed(ni['ci95'][0], 2)}, {signed(ni['ci95'][1], 2)}" + r'''], above the pre-registered margin of $-2$.}
\label{tab:simple}
\setlength{\tabcolsep}{3.5pt}
\resizebox{\linewidth}{!}{%
\begin{tabular}{@{}lccl cccc@{}}
\toprule
& S6 & simple & paired difference & cost ($10^{-3}$\,\$) & p50 (s) & View records & evidence all shown (\%) \\
\midrule
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}}
\end{gentable}''')

# ------------------------------------------------------------------------------------------------------------------
# Comparison with OmniMemEval (same answering model): accuracy, answer-stage context and the effective cost index of
# Mnemon and the 14 re-evaluated systems.
def omnimemeval():
    sysd = P['omnimemeval']['systems']
    rows_of = {d: {n: (a, c, e, ours) for n, a, c, e, ours in eci_rows(d, core=False)} for d in ('locomo', 'lme')}
    top_acc = {d: max(v[0] for v in r.values()) for d, r in rows_of.items()}
    top_eci = {d: min(v[2] for v in r.values()) for d, r in rows_of.items()}
    def cells(name, d, published=None):
        v = rows_of[d].get(name)
        if v is None: return [PENDING] * 3 if name == '\\sys{}' else ['--'] * 3
        a, c, e, ours = v
        acc = f'{100 * a:.1f}' if ours else given(published)
        mark = lambda text, top: '\\best{' + text + '}' if top else text
        return [mark(acc, a == top_acc[d]), f'{c / 1000:.1f}k', mark(f'{e:.3f}', e == top_eci[d])]
    ours = '\\textbf{\\sys{}} & ' + ' & '.join(cells('\\sys{}', 'locomo') + cells('\\sys{}', 'lme')) + ' \\\\'
    rows = [name + ' & ' + ' & '.join(cells(name, 'locomo', s['locomo']) + (cells(name, 'lme', s['lme']) if s['lme'] is not None else ['--'] * 3)) + ' \\\\'
            for name, s in sorted(sysd.items(), key=lambda kv: -kv[1]['locomo'])]
    ds = [get_acc('deepseek', d) for d in ('locomo', 'lme')]
    judge = f' Under DeepSeek as judge, \\sys{{}} scores {ds[0]}\\% and {ds[1]}\\%.' if None not in ds else ''
    write('omnimemeval', r'''
\begin{gentable}[!htb]
\centering
\small
\caption{\sys{} and the 14 systems re-evaluated by OmniMemEval~\citep{omnimemeval2026}, all with gpt-4.1-mini answering: accuracy (\%), context sent to the answering model per question (tokens), and effective cost index (ECI, \cref{eq:eci}; lower is better). OmniMemEval grades with gpt-4o-mini and we with gpt-4.1-mini.''' + judge + r''' Best per column in bold.}
\label{tab:omnimemeval}
\setlength{\tabcolsep}{5pt}
\begin{tabular}{@{}l ccc ccc@{}}
\toprule
& \multicolumn{3}{c}{LoCoMo (1,540 questions)} & \multicolumn{3}{c}{\lme{} (500 questions)} \\
\cmidrule(lr){2-4}\cmidrule(l){5-7}
System & accuracy & context & ECI & accuracy & context & ECI \\
\midrule
''' + ours + '\n\\midrule\n' + '\n'.join(rows) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')

def get_acc(judge, d, setting='standard'):
    """The final version's accuracy under one judge, formatted, or None."""
    x = done(setting, d)
    return None if not x else f"{x['final']['accuracy'][judge]:.1f}"

# Published self-reported results with gpt-4.1-mini answering, and full-context baselines.
def self_reported():
    sr = {k: v for k, v in P['self_reported_gpt41mini'].items() if not k.startswith('_')}
    sr['SmartSearch'] = [93.5, 88.4, 'gpt-4o-mini', 'LoCoMo under the EverMemOS protocol']
    rows = [f"{name} & {given(v[0])} & {given(v[1])} & {v[2]} \\\\" for name, v in sorted(sr.items(), key=lambda kv: -(kv[1][0] or kv[1][1] or 0))]
    full = [('MIRIX', 87.52, None, 'GPT-4.1, mean of 3 runs'), ('MemR3', 89.00, None, 'GPT-4.1, 1,529 questions'), ('LycheeMemory V2', 84.80, 66.20, 'gpt-4o-mini'),
            ('Nemori', 80.6, 65.6, 'gpt-4o-mini'), ('SwiftMem (v2)', 84.87, 63.4, 'not stated'), ('LeanMem', 56.92, 77.40, 'gpt-4.1-mini')]
    frows = [f"{name} & {given(a)} & {given(b)} & {j} \\\\" for name, a, b, j in full]
    write('self_reported', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{Published results with gpt-4.1-mini answering, each from its own evaluation.} Top: memory systems as reported by their authors. Bottom: the full-context baseline (whole history in the prompt, gpt-4.1-mini answering) as reported in the same papers. Judges and question sets differ, so only overall scores are comparable, and only roughly.}
\label{tab:self-reported}
\begin{tabular}{@{}lccl@{}}
\toprule
& LoCoMo & \lme & judge \\
\midrule
''' + '\n'.join(rows) + r'''
\midrule
\multicolumn{4}{@{}l}{\textit{Full context, gpt-4.1-mini answering}} \\
''' + '\n'.join(frows) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')

# Each open-source project's best published result, any model.
def best_reported():
    br = {k: v for k, v in P['best_reported'].items() if not k.startswith('_')}
    ds = R['deepseek_chain']
    loco, lme_final = (done('reasoning', 'locomo') or {}).get('final', {}).get('labels', {}).get('deepseek'), done('reasoning', 'lme')
    if loco and lme_final:
        # The final version with the reasoning reader (amendment 31), DeepSeek judge.
        ours_l = loco
        br['\\textbf{\\sys}'] = [loco['revised'], lme_final['final']['accuracy']['deepseek'], 'DeepSeek-V4.1-Flash (thinking) / DeepSeek',
                                 'raw records and a consolidated index, cue search, \\jev{} judging']
    else:
        ours_l = ds['locomo']['label_variants']['S5h']
        br['\\textbf{\\sys}'] = [ours_l['revised'], ds['lme']['runs']['S5h']['deepseek']['accuracy'], 'DeepSeek-V4.1-Flash (thinking) / DeepSeek',
                                 'raw records, cue search, \\jev{} judging']
    # Where each claim was published.
    cites = {'Zep / Graphiti': 'zeprepo', 'EverMemOS': 'evermemos2026', 'Mem0': 'mem0repo', 'MemU': 'memu2026', 'Hindsight': 'hindsightrepo,hindsight2025',
             'MemMachine': 'memmachine2026', 'MemOS': 'omnimemeval2026', 'Memori': 'memori2026', 'mem9': 'mem9_2026', 'MIRIX': 'wang2025mirix',
             'Nemori': 'nan2025nemori', 'OpenViking': 'openviking2026', 'Memobase': 'memobase2025', 'Letta': 'letta2024', 'LightMem': 'fang2025lightmem',
             'Supermemory': 'supermemory2026', 'SimpleMem': 'simplemem2026'}
    missing = [n for n in br if n not in cites and 'sys' not in n]
    assert not missing, missing
    label = lambda name: name + (f'~\\citep{{{cites[name]}}}' if name in cites else '')
    # Our LoCoMo entry is on the revised labels and carries a dagger.
    cell = lambda name, v: given(v) + ('$^\\dagger$' if name == '\\textbf{\\sys}' else '')
    rows = [f"{label(name)} & {cell(name, v[0])} & {given(v[1])} & {v[2]} & {v[3]} \\\\" for name, v in sorted(br.items(), key=lambda kv: -(kv[1][0] or 0))]
    write('best_reported', r'''
\begin{gentable}[!htb]
\centering
\scriptsize
\caption{Each open-source project's best published result, with whatever answering model, judge and protocol it used (checked September 26, 2026). The settings differ widely, so the table ranks claims, not systems. $^\dagger$On the revised LoCoMo labels (\cref{sec:setup}); ''' + f"{ours_l['original']:.1f}" + r''' on the original labels, which every other entry uses.}
\label{tab:best-reported}
\setlength{\tabcolsep}{3pt}
\begin{tabularx}{\linewidth}{@{}lcc>{\raggedright\arraybackslash}p{4.6cm}>{\raggedright\arraybackslash}X@{}}
\toprule
Project & LoCoMo & \lme & answer model / judge & method \\
\midrule
''' + '\n'.join(rows) + r'''
\bottomrule
\end{tabularx}
\end{gentable}''')

# ------------------------------------------------------------------------------------------------------------------
# Effective cost index: ECI = (1 - a) + c / c_full, c the context sent to the answering model per question.
def eci_rows(ds, core=True):
    m = R['gpt41mini_chain'][ds]['runs']
    rows = []
    fin = done('standard', ds)
    # Answer-stage context only, the one cost reported for every system; our other costs (planner, Jev, and
    # consolidation's write cost) have no published counterpart for the other systems and are reported separately.
    # `core` adds the configuration without consolidation.
    if fin:
        f = fin['final']; a = f['accuracy']['mini'] / 100
        rows.append(('\\sys{}', a, f['answer_input_tokens'], True))
    for r in MAIN[:1] if core else ():
        d = m[r]['mini']; a = d['correct'] / d['n']
        rows.append((MAIN_LABEL[r], a, d['answer_input_tokens'], True))
    for name, s in P['omnimemeval']['systems'].items():
        if s[ds] is not None: rows.append((name, s[ds] / 100, s['ctx_' + ds], False))
    return [(n, a, c, (1 - a) + c / FULL[ds], ours) for n, a, c, ours in rows]

def eci():
    blocks = []
    for ds, label in (('locomo', 'LoCoMo ($c_\\text{full}$ = ' + f"{FULL['locomo']:,}" + ' tokens)'), ('lme', '\\lme{} ($c_\\text{full}$ = ' + f"{FULL['lme']:,}" + ' tokens)')):
        rows = sorted(eci_rows(ds), key=lambda x: x[3])
        mark = lambda text, ours: '\\textbf{' + text + '}' if ours else text
        body = ['%s & %.1f & %s & %s \\\\' % (mark(n, ours), 100 * a, f'{c:,.0f}', mark('%.3f' % e, ours)) for n, a, c, e, ours in rows]
        blocks.append((label, body))
    left, right = blocks
    n = max(len(left[1]), len(right[1]))
    pad = lambda b: b + [' & & & \\\\'] * (n - len(b))
    lines = [l[:-2].rstrip() + ' & ' + r for l, r in zip(pad(left[1]), pad(right[1]))]
    write('eci', r'''
\begin{gentable}
\centering
\scriptsize
\caption{\textbf{Effective cost index}, $\mathrm{ECI} = (1-a) + c/c_\text{full}$: expected cost per question when an error costs one full-context answer, in units of that answer; lower is better. $a$ is accuracy and $c$ the context sent to the answering model per question, as reported by OmniMemEval for the other systems and measured the same way for \sys{} with and without consolidation; it is a lower bound on every system's cost. Costs at retrieval and at write time are not published for the other systems and are left out for all; ours (planner, \jev{} and consolidation) are in \cref{tab:costs-standard,tab:consolidation}.}
\label{tab:eci}
\setlength{\tabcolsep}{3.2pt}
\begin{tabular}{@{}lccc@{\hspace{14pt}}lccc@{}}
\toprule
\multicolumn{4}{@{}l}{''' + left[0] + r'''} & \multicolumn{4}{l}{''' + right[0] + r'''} \\
\cmidrule(r){1-4}\cmidrule(l){5-8}
system & acc.\ (\%) & $c$ (tok.) & ECI & system & acc.\ (\%) & $c$ (tok.) & ECI \\
\midrule
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')
    # Dominance and break-even values of an error, for the text.
    notes = {}
    for ds in ('locomo', 'lme'):
        rows = eci_rows(ds)
        for scope in ('A',):
            _, a0, c0, _, _ = next(r for r in rows if r[0] == MAIN_LABEL[MAIN[0]])
            others = [r for r in rows if not r[4]]
            dominated = [n for n, a, c, e, _ in others if a <= a0 and c >= c0]
            dominating = [n for n, a, c, e, _ in others if a >= a0 and c <= c0]
            cheaper = {n: round((c0 - c) / FULL[ds] / (a0 - a), 3) for n, a, c, e, _ in others if c < c0 and a < a0}
            dearer = {n: round((c - c0) / FULL[ds] / (a - a0), 3) for n, a, c, e, _ in others if c > c0 and a > a0}
            notes[f'{ds} {scope}'] = dict(dominated=len(dominated), of=len(others), dominating=dominating, breakeven_vs_cheaper=cheaper, breakeven_vs_dearer=dearer)
    (HERE / 'data/eci_notes.json').write_text(json.dumps(notes, indent=1)); print('wrote data/eci_notes.json')

# ------------------------------------------------------------------------------------------------------------------
# System 1: Jev against LLM judges on the same items.
def system1():
    S, C = R['system1_summary'], R['system1_calls']
    lines = []
    for name, label in (('JEV (pipeline)', '\\jev, recorded in the run'), ('JEV', '\\jev, called again'), ('DeepSeek', 'DeepSeek (no thinking)'), ('gpt-4.1-mini', 'gpt-4.1-mini')):
        a = S['all'][name]; c = C['per_judge'].get(name.replace(' (pipeline)', ''), {}) if name != 'JEV (pipeline)' else {}
        lat = f"{c['latency_p50_s']:.2f}" if c else '--'; cost = f"{1e3 * c['cost_per_call']:.2f}" if c else '--'
        rho = f"{a['spearman_vs_jev']:.2f}" if 'spearman_vs_jev' in a else '--'
        lines.append(f"{label} & {a['auc_pooled']:.3f} & {S['locomo'][name]['auc_pooled']:.3f} & {S['lme'][name]['auc_pooled']:.3f} & {a['precision@0.5']:.2f} / {a['recall@0.5']:.2f} & "
                     f"{a['recall_top4']:.2f} / {a['recall_top8']:.2f} / {a['recall_top16']:.2f} & {lat} & {cost} & {rho} \\\\")
    write('system1', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{\jev{} against LLM judges on the same records} (''' + f"{C['questions']}" + r''' questions, ''' + f"{C['items']:,}" + r''' records, ''' + f"{C['gold']:,}" + r''' of them gold evidence). AUC for separating gold evidence, pooled over records (overall, LoCoMo, \lme); precision and recall at 0.5; share of gold evidence within each question's top 4 / 8 / 16; median latency and price per call of 24 records; Spearman correlation with the recorded \jev{} scores.}
\label{tab:system1}
\setlength{\tabcolsep}{3.3pt}
\begin{tabular}{@{}l ccc c c cc c@{}}
\toprule
& \multicolumn{3}{c}{AUC} & P / R & recall in top & p50 & $10^{-3}$\,\$ & \\
\cmidrule(lr){2-4}
judge & all & LoCoMo & \lme & at 0.5 & 4 / 8 / 16 & (s) & per call & $\rho$ \\
\midrule
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')

# ------------------------------------------------------------------------------------------------------------------
# Appendix: LoCoMo under both label sets and without open-domain, both judges.
def label_variants():
    lines = []
    m = R['gpt41mini_chain']['locomo']
    lines.append('\\multicolumn{9}{@{}l}{\\textit{Standard setting (gpt-4.1-mini answers), ' + f"{m['questions']:,}" + ' questions; revised labels keep ' + f"{m['revised_questions']:,}" + '}} \\\\')
    KEYS = ('original', 'revised', 'original_no_open_domain', 'revised_no_open_domain')
    for r in [x for x in ('S0', 'S4h', 'S6', 'fast', 'simple', 'simple-fast', 'final') if x in m['label_variants']]:
        v = m['label_variants'][r]
        cells = [v[j][k] for j in ('mini', 'deepseek') for k in KEYS]
        lines.append(NAMES[r] + ' & ' + ' & '.join(f1(x) for x in cells) + ' \\\\')
    d = R['deepseek_chain']['locomo']
    lines.append('\\midrule\n\\multicolumn{9}{@{}l}{\\textit{Reasoning setting (DeepSeek answers), ' + f"{d['questions']:,}" + ' questions; revised labels keep ' + f"{d['revised_questions']:,}" + '}} \\\\')
    for r in ('S0', 'S4h', 'S5h', 'S6', 'simple', 'final'):
        v = d['label_variants'].get(r)
        if not v: continue
        cells = ['--'] * 4 + [f1(v[k]) for k in KEYS]
        lines.append(NAMES[r] + ' & ' + ' & '.join(cells) + ' \\\\')
    write('label_variants', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{LoCoMo under the original and revised labels, with and without open-domain questions}, for each judge. The revised labels drop 44 questions whose gold answer is unusable and correct 25 gold answers (the corrected questions are regraded by each judge). Configurations without revised-label grades are omitted.}
\label{tab:label-variants}
\setlength{\tabcolsep}{4pt}
\begin{tabular}{@{}l cccc cccc@{}}
\toprule
& \multicolumn{4}{c}{gpt-4.1-mini judge} & \multicolumn{4}{c}{DeepSeek judge} \\
\cmidrule(lr){2-5}\cmidrule(l){6-9}
& original & revised & orig.\ no OD & rev.\ no OD & original & revised & orig.\ no OD & rev.\ no OD \\
\midrule
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')

# Appendix: accuracy by type in the reasoning setting.
def deepseek_types():
    L, M = R['deepseek_chain']['locomo']['runs'], R['deepseek_chain']['lme']['runs']
    runs = ['S0', 'S4h', 'S5h', 'S6', 'S6 (rerun)', 'simple'] + (['final'] if 'final' in L and 'final' in M else [])
    lines = []
    for r in runs:
        l, m = L[r]['deepseek']['per_type'], M[r]['deepseek']['per_type']
        lines.append(NAMES[r] + ' & ' + ' & '.join(f1(l[t]) for t in LOCOMO_TYPES) + ' & ' + ' & '.join(f1(m[t]) for t in LME_TYPES) + ' \\\\')
    write('deepseek_types', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{Accuracy by question type in the reasoning setting} (DeepSeek answers, plans and judges; same questions as \cref{tab:deepseek}).}
\label{tab:deepseek-types}
\setlength{\tabcolsep}{3.4pt}
\begin{tabular}{@{}l cccc cccccc@{}}
\toprule
& \multicolumn{4}{c}{LoCoMo} & \multicolumn{6}{c}{\lme} \\
\cmidrule(lr){2-5}\cmidrule(l){6-11}
& single & multi & temp. & open & SS-user & SS-asst. & SS-pref. & temp. & multi-s. & KU \\
\midrule
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')

# Appendix: planner or not, thinking or not (DeepSeek answering), and planning without an LLM (offline).
def reader_combos():
    c = P['reader_combinations']
    lines = []
    for ds, label, n in (('lme', '\\lme', 230), ('locomo', 'LoCoMo', 583)):
        lines.append(f'\\midrule\n\\multicolumn{{5}}{{@{{}}l}}{{\\textit{{{label}, {n} questions}}}} \\\\')
        for k, v in c[ds].items():
            lines.append(f'{k} & {v[0]:.1f} & {v[1]:.1f} / {v[2]:.1f} & {v[3]:.1f} & {v[4] / 1000 * 1000:.2f} \\\\')
    cues = P['no_llm_cues']
    crow = [f"{k} & {v[0]:.1f} & {v[1]:.1f} & {v[2]} \\\\" for k, v in cues.items() if not k.startswith('_')]
    write('reader_combos', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{Planner and thinking.} Top: the four combinations of planner or no planner (S6) with the answering model's thinking on or off, DeepSeek answering and judging, run side by side on stratified subsets. Cost per question in thousandths of a dollar (off-peak). Bottom: share of questions whose gold evidence reaches the 48-record pool, by the source of the searches, computed offline without any model call.}
\label{tab:reader-combos}
\begin{tabular}{@{}lcccc@{}}
\toprule
& accuracy & latency p50 / p90 (s) & View p50 (s) & cost ($10^{-3}$\,\$) \\
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}

\vspace{6pt}
\begin{tabular}{@{}lccc@{}}
\toprule
searches from & LoCoMo (1,530) & \lme{} (470) & searches per question \\
\midrule
''' + '\n'.join(crow) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')

# ------------------------------------------------------------------------------------------------------------------
# Held-out benchmarks (amendments 12-14).
def heldout():
    H = R.get('heldout', {})
    om = P['omnimemeval']
    halu = {k: v for k, v in om['halumem'].items() if not k.startswith('_')}
    beam = {k: v for k, v in om['beam'].items() if not k.startswith('_')}
    def span(values):
        best = max(values, key=lambda kv: kv[1])
        return f"{min(v for _, v in values):.1f}--{best[1]:.1f} ({best[0]})"
    def cell(run, judge, key):
        v = (H.get(run) or {}).get(judge, {})
        return '--' if not v else f"{v[key]:.1f}"
    def hal(run):
        m, d = (H.get(run) or {}).get('mini'), (H.get(run) or {}).get('deepseek')
        if not m and not d: return '-- & -- & --'
        base = m or d
        return f"{base['Correct']:.1f} ({d['Correct']:.1f})" if m and d else f"{base['Correct']:.1f}", f"{base['Hallucination']:.1f}", f"{base['Omission']:.1f}"
    def row_h(label, run):
        x = hal(run)
        parts = x if isinstance(x, tuple) else tuple(x.split(' & '))
        extra = H.get(run) or {}
        cost = f"{1e3 * extra['cost_per_question']:.2f}" if 'cost_per_question' in extra else '--'
        n = (extra.get('mini') or extra.get('deepseek') or {}).get('n', extra.get('answered', 0))
        return f"{label} & {n:,} & {parts[0]} & {parts[1]} & {parts[2]} & {cost} \\\\"
    def row_b(label, run):
        extra = H.get(run) or {}
        m, d = extra.get('mini'), extra.get('deepseek')
        score = '--' if not (m or d) else (f"{m['score']:.1f} ({d['score']:.1f})" if m and d else f"{(m or d)['score']:.1f}")
        cost = f"{1e3 * extra['cost_per_question']:.2f}" if 'cost_per_question' in extra else '--'
        n = (m or d or {}).get('n', extra.get('answered', 0))
        return f"{label} & {n:,} & {score} & & & {cost} \\\\"
    lines = ['\\multicolumn{6}{@{}l}{\\textit{HaluMem-Medium: share of answers judged correct / hallucinated / omitted; OmniMemEval, correct: ' + span(list(halu.items())) + '}} \\\\',
             row_h('registered run (\\lme{} answer prompt)', 'halumem'),
             '\\midrule',
             '\\multicolumn{6}{@{}l}{\\textit{BEAM: rubric (nugget) score; OmniMemEval 100K: ' + span([(k, v[0]) for k, v in beam.items()]) + '; 10M: ' + span([(k, v[1]) for k, v in beam.items()]) + '}} \\\\',
             row_b('100K tier, hybrid retrieval', 'beam128k'),
             row_b('100K tier, BM25 only (control)', 'beam128k-bm25')]
    # The 10M tier could not be written into the journal Source (amendment 22); its rows appear only if it has run.
    tenm = [row_b(label, run) for label, run in (('10M tier, BM25 only', 'beam10m-bm25'), ('10M tier, hybrid retrieval', 'beam10m'))
            if (H.get(run) or {}).get('answered')]
    lines += tenm or ['\\multicolumn{6}{@{}l}{10M tier: not run; its conversations exceed the record store of the reference Source (\\cref{sec:limitations})} \\\\']
    write('heldout', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{Held-out benchmarks}, run once with the simple mode frozen and gpt-4.1-mini answering and planning. Scores under the gpt-4.1-mini judge, with DeepSeek in parentheses; both judges use each benchmark's official grading prompt. Cost per question in thousandths of a dollar. OmniMemEval ranges are for the systems it re-evaluated with the same answering model and a gpt-4o-mini judge.}
\label{tab:heldout}
\setlength{\tabcolsep}{4pt}
\resizebox{\linewidth}{!}{%
\begin{tabular}{@{}l r c c c c@{}}
\toprule
& questions & correct / score & hallucinated & omitted & cost ($10^{-3}$\,\$) \\
\midrule
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}}
\end{gentable}''')
    # HaluMem by type: registered run against the short-answer replay, gpt-4.1-mini judge (DeepSeek when absent).
    reg, rep = H.get('halumem') or {}, H.get('halumem-short-official') or {}
    judge = 'mini' if reg.get('mini') and rep.get('mini') else 'deepseek'
    if reg.get(judge) and rep.get(judge):
        types = sorted(reg[judge]['per_type'])
        body = []
        for t in types:
            a, b = reg[judge]['per_type'][t], rep[judge]['per_type'].get(t)
            if not b: continue
            body.append(f"{t} & {a['Correct']:.1f} & {a['Hallucination']:.1f} & {a['Omission']:.1f} & {b['Correct']:.1f} & {b['Hallucination']:.1f} & {b['Omission']:.1f} \\\\")
        write('halumem_types', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{HaluMem by question type}: the registered run and the same Views answered with HaluMem's own answer prompt (''' + ('gpt-4.1-mini' if judge == 'mini' else 'DeepSeek') + r''' judge; \% correct, hallucinated, omitted).}
\label{tab:halumem-types}
\begin{tabular}{@{}l ccc ccc@{}}
\toprule
& \multicolumn{3}{c}{registered run} & \multicolumn{3}{c}{HaluMem's answer prompt} \\
\cmidrule(lr){2-4}\cmidrule(l){5-7}
type & correct & halluc. & omitted & correct & halluc. & omitted \\
\midrule
''' + '\n'.join(body) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')

# HaluMem: why answers were not judged correct (causes.jsonl from the audit script, one cause per wrong answer).
CAUSE_ROWS = [
    ('memory', 'no_view', 'View did not arrive within the 30\\,s wait'),
    ('memory', 'not_retrieved', 'needed information not in the View'),
    ('reader', 'extra_details', 'reference answer given, plus details beyond the key memory points'),
    ('reader', 'unanswerable_answered', "reference is ``unknown'', a specific answer given"),
    ('reader', 'incomplete', 'required elements missing, although in the View'),
    ('reader', 'outdated_or_conflicting', 'an older or conflicting value used'),
    ('reader', 'wrong_inference', 'evidence in the View misread or wrongly inferred'),
    ('grading', 'grading_disagreement', 'answer equivalent to the reference'),
]
def halumem_causes():
    C = R.get('halumem_causes')
    if not C: return
    count, answered, wrong = C['counts'], C['answers'], C['wrong']
    inview = C['info_in_view']
    shown = 100 * (inview.get('yes', 0) + inview.get('partly', 0)) / max(1, wrong)
    scope = 'all questions' if C['source'] == 'halumem' else f'the first {answered:,} questions answered'
    lines, last = [], None
    for group, key, text in CAUSE_ROWS:
        if group != last:
            lines.append(('\\midrule\n' if last else '') + '\\multicolumn{3}{@{}l}{\\textit{' + {'memory': 'Memory side', 'reader': 'Reading side', 'grading': 'Grading'}[group] + '}} \\\\')
            last = group
        n = count.get(key, 0)
        lines.append(f"{text} & {n} & {100 * n / answered:.1f} \\\\")
    write('halumem_causes', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{Why HaluMem answers were not judged correct} (registered answers to ''' + scope + r''', gpt-4.1-mini judge; ''' + f"{wrong}" + r''' of ''' + f"{answered:,}" + r''' answers). One main cause per answer, assigned by DeepSeek from the question, the reference answer and its key memory points, the View, the answer and the judge's label. For ''' + f"{shown:.0f}" + r'''\% of these answers the information needed was in the View, fully or in part.}
\label{tab:halumem-causes}
\begin{tabular}{@{}lrr@{}}
\toprule
cause & answers & points of accuracy \\
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')

# HaluMem answered in other ways from the same Views: official judge (DeepSeek graded every set), gpt-4.1-mini, lenient.
def halumem_variants_table():
    V = R.get('halumem_variants', {})
    if 'deepseek' not in V: return
    order = [('gpt-4.1-mini', 'ours'), ('gpt-4.1-mini', 'HaluMem'), ('gpt-4.1-mini', 'combined'), ('DeepSeek', 'ours'), ('DeepSeek', 'HaluMem'), ('DeepSeek', 'combined')]
    names = {'ours': 'our answer prompt', 'HaluMem': "HaluMem's short-answer prompt", 'combined': 'combined prompt'}
    def judged(judge, key, registered):
        d = V.get(judge, {}).get('sets', {}).get(key)
        if not d: return '-- & -- & -- & --'
        vs = d.get('vs_registered')
        return f"{d['Correct']:.1f} & {d['Hallucination']:.1f} & {d['Omission']:.1f} & {'registered' if registered else '--' if not vs else flip(vs)}"
    lines = []
    for r, p in order:
        key = f'{r} / {p}'
        if key not in V['deepseek']['sets'] and key not in V.get('mini', {}).get('sets', {}): continue
        lenient = V.get('lenient', {}).get('sets', {}).get(key)
        registered = (r, p) == ('gpt-4.1-mini', 'ours')
        lines.append(f"{r}, {names[p]} & {judged('mini', key, registered)} & {judged('deepseek', key, registered)} & {'--' if not lenient else format(lenient['Correct'], '.1f')} \\\\")
    questions = V.get('mini', V['deepseek'])['questions']
    write('halumem_variants', r"""
\begin{gentable}
\centering
\small
\caption{\textbf{HaluMem answered in other ways from the same Views} (""" + f"{questions}" + r""" questions), graded by both judges under HaluMem's official rules: \% correct, hallucinated and omitted, and the paired change against the registered answers. Last column: correct under a lenient judge that accepts details beyond the reference unless they contradict it (DeepSeek as judge).}
\label{tab:halumem-variants}
\setlength{\tabcolsep}{3.5pt}
\resizebox{\linewidth}{!}{%
\begin{tabular}{@{}l cccl cccl c@{}}
\toprule
& \multicolumn{4}{c}{gpt-4.1-mini judge (primary)} & \multicolumn{4}{c}{DeepSeek judge} & lenient \\
\cmidrule(lr){2-5}\cmidrule(lr){6-9}
reader, answer prompt & correct & halluc. & omitted & vs registered & correct & halluc. & omitted & vs registered & correct \\
\midrule
""" + '\n'.join(lines) + r"""
\bottomrule
\end{tabular}}
\end{gentable}""")

# ------------------------------------------------------------------------------------------------------------------
# Numbers quoted in the text, as LaTeX macros, so that the prose follows the data.
def numbers():
    std, ds = R['gpt41mini_chain'], R['deepseek_chain']
    macros = {'mainConfig': 'the simple mode' if MAIN[0] == 'simple' else 'S6'}
    for key, r in (('main', MAIN[0]), ('fast', MAIN[1])):
        for d, D in (('locomo', 'LoCoMo'), ('lme', 'LME')):
            x = std[d]['runs'][r]
            macros[f'{key}{D}'] = f"{x['mini']['accuracy']:.1f}"
            macros[f'{key}{D}DS'] = f"{x['deepseek']['accuracy']:.1f}"
            macros[f'{key}Ctx{D}'] = f"{x['mini']['answer_input_tokens'] / 1000:.1f}k"
            macros[f'{key}Cost{D}'] = f"{x['mini']['cost_per_question']['total']:.4f}"
            macros[f'{key}Lat{D}'] = f"{x['mini']['latency_p50_s']:.1f}"
            macros[f'{key}View{D}'] = f"{x['mini']['view_items']:.1f}"
    # Ranges over the two benchmarks, for sentences that speak of both at once.
    span = lambda lo, hi, unit='': f'{lo}{unit}' if lo == hi else f'{lo}--{hi}{unit}'
    ctx = sorted(std[d]['runs'][MAIN[0]]['mini']['answer_input_tokens'] / 1000 for d in ('locomo', 'lme'))
    macros['mainCtxRange'] = span(f'{ctx[0]:.1f}', f'{ctx[1]:.1f}', 'k')
    for key, r in (('main', MAIN[0]), ('fast', MAIN[1])):
        lat = sorted(std[d]['runs'][r]['mini']['latency_p50_s'] for d in ('locomo', 'lme'))
        macros[f'{key}LatRange'] = span(f'{lat[0]:.1f}', f'{lat[1]:.1f}')
    memos = P['omnimemeval']['systems']['MemOS']
    share = sum(std[d]['runs'][MAIN[0]]['mini']['answer_input_tokens'] / memos['ctx_' + d] for d in ('locomo', 'lme')) / 2
    macros['ctxShareMemOS'] = f'{100 * share:.0f}'
    for d, D in (('locomo', 'LoCoMo'), ('lme', 'LME')):
        rows = sorted(eci_rows(d), key=lambda x: x[3])
        ours_a = next(x for x in rows if x[0] == MAIN_LABEL[MAIN[0]])
        others = [x for x in rows if not x[4]]
        macros[f'eci{D}A'] = f'{ours_a[3]:.3f}'
        rank = 1 + sum(x[3] < ours_a[3] for x in others)
        macros[f'eci{D}Rank'] = str(rank)
        macros[f'eci{D}RankWord'] = ['first', 'second', 'third', 'fourth', 'fifth'][rank - 1] if rank <= 5 else f'{rank}th'
        memos = next(x for x in others if x[0] == 'MemOS')
        macros[f'eciMemOS{D}'] = f'{memos[3]:.3f}'
        macros[f'accGapMemOS{D}'] = f'{100 * abs(ours_a[1] - memos[1]):.1f}'
        macros[f'dom{D}A'] = str(sum(x[1] <= ours_a[1] and x[2] >= ours_a[2] for x in others))
        macros[f'systems{D}'] = str(len(others))
        # How much less accurate the systems with less context are; what an error must cost before the most accurate
        # system with more context is preferable.
        for scope, ours in (('A', ours_a),):
            gaps = [100 * (ours[1] - x[1]) for x in others if x[2] < ours[2]]
            macros[f'cheaperGap{D}{scope}'] = f'{min(gaps):.0f}--{max(gaps):.0f}' if gaps else '--'
            macros[f'cheaper{D}{scope}'] = str(len(gaps))
        dearer = [x for x in others if x[2] > ours_a[2] and x[1] > ours_a[1]]
        if dearer:
            top = max(dearer, key=lambda x: x[1])
            macros[f'breakEven{D}'] = f'{(top[2] - ours_a[2]) / FULL[d] / (top[1] - ours_a[1]):.2f}'
        macros[f'ds{D}'] = f"{ds[d]['runs']['simple']['deepseek']['accuracy']:.1f}"
        macros[f'dsLat{D}'] = f"{ds[d]['runs']['simple']['deepseek']['latency_p50_s']:.1f}"
        split = std[d]['runs'][MAIN[0]]['mini']['cost_per_question']
        for part in ('answer', 'planner', 'jev'):
            macros[f'costShare{part.capitalize()}{D}'] = f"{100 * split[part] / split['total']:.0f}"
        macros[f'ds{D}Best'] = f"{max(v['deepseek']['accuracy'] for v in ds[d]['runs'].values()):.1f}"
        # The reasoning reader's gain over gpt-4.1-mini, both graded by DeepSeek; the fast mode's loss and saving.
        macros[f'dsGain{D}'] = f"{ds[d]['runs']['simple']['deepseek']['accuracy'] - std[d]['runs'][MAIN[0]]['deepseek']['accuracy']:.1f}"
        main_run, fast_run = std[d]['runs'][MAIN[0]]['mini'], std[d]['runs'][MAIN[1]]['mini']
        macros[f'fastGap{D}'] = f"{main_run['accuracy'] - fast_run['accuracy']:.1f}"
        macros[f'fastSaving{D}'] = f"{100 * (1 - fast_run['cost_per_question']['total'] / main_run['cost_per_question']['total']):.0f}"
    # By type against MemOS, the strongest re-evaluated system: our margin per LoCoMo type (points), and each LongMemEval-S
    # type's share of the overall distance (points of the total, weighted by the type's questions).
    cats = P['omnimemeval']
    for d, types, names, key in (('locomo', LOCOMO_TYPES, ('SingleHop', 'MultiHop', 'Temporal', 'OpenDomain'), 'locomo_categories'),
                                 ('lme', LME_TYPES, ('User', 'Asst', 'Pref', 'Temporal', 'Multi', 'Update'), 'lme_categories')):
        order, memos_by_type = cats[key]['_order'], cats[key]['MemOS']
        ours = std[d]['runs'][MAIN[0]]['mini']
        counts = ours.get('per_type_n') or {}
        for t, name in zip(types, names):
            theirs = memos_by_type[order.index(t)]
            if d == 'locomo':
                macros[f'vsMemOS{name}'] = signed(ours['per_type'][t] - theirs)
                if counts.get(t): macros[f'vsMemOS{name}Q'] = f"{abs(ours['per_type'][t] - theirs) * counts[t] / 100:.0f}"
            elif counts.get(t):
                macros[f'gapMemOS{name}'] = f"{(theirs - ours['per_type'][t]) * counts[t] / sum(counts.values()):.1f}"
    # HaluMem, the registered run: shares under both judges and the rank among OmniMemEval's re-evaluated systems.
    halu = R.get('heldout', {}).get('halumem') or {}
    if halu.get('mini'):
        m = halu['mini']
        macros.update(haluN=f"{m['n']:,}", haluCorrect=f"{m['Correct']:.1f}", haluHalluc=f"{m['Hallucination']:.1f}", haluOmit=f"{m['Omission']:.1f}")
        if halu.get('deepseek'): macros['haluCorrectDS'] = f"{halu['deepseek']['Correct']:.1f}"
        others = [v for k, v in P['omnimemeval']['halumem'].items() if not k.startswith('_')]
        rank = 1 + sum(v > m['Correct'] for v in others)
        words = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth']
        macros.update(haluRankWord=words[rank - 1], haluSystems=str(len(others) + 1))
    short = R.get('heldout', {}).get('halumem-short-official') or {}
    if short.get('mini'): macros.update(haluShortN=f"{short['mini']['n']:,}", haluShortMini=f"{short['mini']['Correct']:.1f}", haluShortOmit=f"{short['mini']['Omission']:.1f}")
    if short.get('deepseek'): macros['haluShortDS'] = f"{short['deepseek']['Correct']:.1f}"
    before = R.get('heldout', {}).get('halumem-before-retry') or {}
    if before.get('mini'): macros['haluCorrectBefore'] = f"{before['mini']['Correct']:.1f}"
    # BEAM-100K: the registered hybrid run and the BM25 control, both judges, and the hybrid run's rank.
    words = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth']
    beam = {k: v[0] for k, v in P['omnimemeval']['beam'].items() if not k.startswith('_')}
    for key, run in (('beamHybrid', 'beam128k'), ('beamBM', 'beam128k-bm25')):
        x = R.get('heldout', {}).get(run) or {}
        if x.get('mini'):
            macros[key] = f"{x['mini']['score']:.1f}"
            macros[key + 'Rank'] = words[sum(v > x['mini']['score'] for v in beam.values())]
        if x.get('deepseek'): macros[key + 'DS'] = f"{x['deepseek']['score']:.1f}"
    macros['beamSystems'] = str(len(beam) + 1)
    final_numbers(macros)
    lines = ['% Generated by scripts/tables.py from data/results.json; do not edit.'] + [f'\\newcommand{{\\{k}}}{{{v}}}' for k, v in macros.items()]
    (OUT / 'numbers.tex').write_text('\n'.join(lines) + '\n'); print('wrote', OUT / 'numbers.tex')

# Cost and latency of the two main configurations.
def main_costs():
    lines = []
    for d, label in (('locomo', 'LoCoMo'), ('lme', '\\lme{}')):
        for r in MAIN:
            x = R['gpt41mini_chain'][d]['runs'][r]['mini']; c = x['cost_per_question']; sp = R['gpt41mini_chain'][d]['latency_split'][r]
            lines.append(f"{label} & {MAIN_LABEL[r]} & {x['latency_p50_s']:.1f} / {x['latency_p90_s']:.1f} & {sp['view_p50_s']:.1f} & {sp['answer_p50_s']:.1f} & "
                         f"{x['view_items']:.1f} & {x['answer_input_tokens']:,} & {x['jev_tokens'] / 1000:.1f} & {1e3 * c['answer']:.2f} & {1e3 * c['planner']:.2f} & {1e3 * c['jev']:.2f} & \\textbf{{{1e3 * c['total']:.2f}}} \\\\")
        if d == 'locomo': lines.append('\\addlinespace[2pt]')
    write('main_costs', r'''
\begin{gentable}
\centering
\caption{\textbf{Cost and latency} of \sys{} in the standard setting (gpt-4.1-mini). Latency per question (median / 90th percentile), split into building the View (planner, retrieval and \jev) and answering, both medians; records in the View; input tokens of the answering call; \jev{} input tokens; cost per question in thousandths of a dollar at list prices.}
\label{tab:main-costs}
\resizebox{\linewidth}{!}{%
\begin{tabular}{@{}ll ccc ccc cccc@{}}
\toprule
& & \multicolumn{3}{c}{latency (s)} & View & answer & \jev{} & \multicolumn{4}{c}{cost ($10^{-3}$\,\$)} \\
\cmidrule(lr){3-5}\cmidrule(l){9-12}
& & p50 / p90 & View & answer & records & input tok. & k tok. & answer & planner & \jev & total \\
\midrule
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}}
\end{gentable}''')

# What each component adds: paired differences with 95% intervals (the forest figure draws the same data).
def ablation_rows():
    """(component, reader, benchmark, paired dict) for every component comparison we ran."""
    std, ds = R['gpt41mini_chain'], R['deepseek_chain']
    out = []
    for d in ('locomo', 'lme'):
        P_ds, P_std = ds[d]['paired_deepseek_judge'], std[d]['paired_mini_judge']
        out.append(('hybrid retrieval', 'DeepSeek', d, P_ds['S4h vs S0']['all']))
        out.append(('hybrid retrieval', 'gpt-4.1-mini', d, P_std['S4h vs S0']['all']))
        out.append(('judge--act loop', 'DeepSeek', d, P_ds['S5h vs S4h']['all']))
        out.append(('unsure fill', 'DeepSeek', d, P_ds['S6 vs S5h']['all']))
        out.append(('loop and unsure fill', 'gpt-4.1-mini', d, P_std['S6 vs S4h']['all']))
        out.append(('budgets for rules', 'DeepSeek', d, R['simple_vs_s6'][d]['paired']['all']))
        if 'simple vs S6' in P_std: out.append(('budgets for rules', 'gpt-4.1-mini', d, P_std['simple vs S6']['all']))
        # Consolidation (exploratory): the final version against the read-time core, each reader graded by its own judge.
        for reader, setting, judge in (('gpt-4.1-mini', 'standard', 'mini'), ('DeepSeek', 'reasoning', 'deepseek')):
            x = done(setting, d) or (done(setting, 'lme-180') if (setting, d) == ('standard', 'lme') else None)
            if x and judge in x['paired']:
                q = x['paired'][judge]
                out.append(('consolidation', reader, d, dict(n=q['n'], up=q['up'], down=q['down'], diff=q['diff'], ci95=q['ci95'], p=mcnemar_p(q['up'], q['down']))))
        # All together: the final version against cue recall over BM25 (S0) once both are graded; until then the core.
        together = F.get('all_together', {})
        out.append(('all together', 'DeepSeek', d, together.get(f'DeepSeek {d}', {}).get('all') or P_ds['simple vs S0']['all']))
        out.append(('all together', 'gpt-4.1-mini', d, together.get(f'gpt-4.1-mini {d}', {}).get('all') or P_std[('simple' if 'simple vs S0' in P_std else 'S6') + ' vs S0']['all']))
        fast_key = 'simple-fast vs simple' if 'simple-fast vs simple' in P_std else 'fast vs S6'
        out.append(('no planner', 'gpt-4.1-mini', d, P_std[fast_key]['all']))
        # With DeepSeek the fast mode was compared with S6 side by side on stratified subsets (230 LME, 583 LoCoMo).
        f = P['fast_vs_planner_deepseek'][d]
        up, down = map(int, f['flips'].split(',')[0].replace('+', '').split('/-'))
        n = 583 if d == 'locomo' else 230
        half = 1.96 * math.sqrt(up + down - (up - down) ** 2 / n) / n
        out.append(('no planner', 'DeepSeek', d, dict(n=n, up=up, down=down, diff=100 * (up - down) / n, p=float(f['flips'].split('p=')[1]),
                                                                 ci95=[100 * ((up - down) / n - half), 100 * ((up - down) / n + half)])))
    return out

def ablation():
    rows = ablation_rows()
    (HERE / 'data/ablation.json').write_text(json.dumps([dict(component=c, reader=r, benchmark=d, **{k: p[k] for k in ('n', 'up', 'down', 'diff', 'p', 'ci95')})
                                                        for c, r, d, p in rows], indent=1))
    comps = ['hybrid retrieval', 'judge--act loop', 'unsure fill', 'loop and unsure fill', 'budgets for rules', 'consolidation', 'no planner', 'all together']
    def cell(c, reader, d):
        x = next((p for cc, rr, dd, p in rows if cc == c and rr == reader and dd == d), None)
        return '--' if x is None else f"{signed(x['diff'])} [{signed(x['ci95'][0])}, {signed(x['ci95'][1])}]" + ('$^{*}$' if x['p'] < 0.05 else '')
    lines = [f"{c} & {cell(c, 'DeepSeek', 'locomo')} & {cell(c, 'DeepSeek', 'lme')} & {cell(c, 'gpt-4.1-mini', 'locomo')} & {cell(c, 'gpt-4.1-mini', 'lme')} \\\\" for c in comps]
    write('ablation', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{What each component adds}: paired difference in accuracy (points) with its 95\% interval, each component against the configuration without it, on the same questions; $^{*}$ exact McNemar $p<0.05$. With gpt-4.1-mini the loop and the unsure fill were added in one step. Consolidation compares \sys{} with \sys{} w/o consolidation (exploratory); ``no planner'' removes the planner from \sys{} w/o consolidation; ``all together'' compares \sys{} with cue recall over BM25 (S0).}
\label{tab:ablation}
\resizebox{\linewidth}{!}{%
\begin{tabular}{@{}l cc cc@{}}
\toprule
& \multicolumn{2}{c}{DeepSeek reader} & \multicolumn{2}{c}{gpt-4.1-mini reader} \\
\cmidrule(lr){2-3}\cmidrule(l){4-5}
component & LoCoMo & \lme & LoCoMo & \lme \\
\midrule
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}}
\end{gentable}''')

# All five benchmarks side by side: every system OmniMemEval re-evaluated with gpt-4.1-mini answering, and ours with
# its rank among the systems that have a score.
def cross_benchmark():
    om, H, m = P['omnimemeval'], R.get('heldout', {}), R['gpt41mini_chain']
    keys = ['locomo', 'lme', 'halumem', 'beam100k', 'beam10m']
    table = {name: {'locomo': s['locomo'], 'lme': s['lme']} for name, s in om['systems'].items()}
    for name, v in om['halumem'].items():
        if not name.startswith('_'): table.setdefault(name, {})['halumem'] = v
    for name, v in om['beam'].items():
        if not name.startswith('_'): table.setdefault(name, {}).update(beam100k=v[0], beam10m=v[1])
    # Our two rows: the final version (consolidation on; exploratory) and its read-time core (registered; the held-out
    # runs frozen), each ranked among the re-evaluated systems. BEAM-10M: run C and run B of amendments 32-33.
    S = F.get('scale', {})
    mini_of = lambda acc: acc.get('mini') if acc else None
    fin_of = lambda key: mini_of((done('standard', key) or {}).get('final', {}).get('accuracy'))
    final_row = {'locomo': fin_of('locomo'), 'lme': fin_of('lme'), 'halumem': fin_of('halumem'),
                 'beam100k': mini_of((S.get('100k-final') or {}).get('accuracy')), 'beam10m': mini_of((S.get('10m-C') or {}).get('accuracy'))}
    core_row = {d: m[d]['runs'][MAIN[0]]['mini']['accuracy'] for d in ('locomo', 'lme')}
    core_row.update(halumem=(H.get('halumem') or {}).get('mini', {}).get('Correct'), beam100k=mini_of((S.get('100k-core') or {}).get('accuracy')),
                    beam10m=mini_of((S.get('10m-B') or {}).get('accuracy')))
    ours_all = [v for row in (final_row, core_row) for v in row.values() if v is not None]
    top = {k: max([x[k] for x in table.values() if x.get(k) is not None] + [r[k] for r in (final_row, core_row) if r.get(k) is not None]) for k in keys}
    fmt = lambda v, k: '--' if v is None else ('\\best{%.1f}' % v if v == top[k] else '%.1f' % v)
    def ranked(row, k):
        if row.get(k) is None: return PENDING
        others = [x[k] for x in table.values() if x.get(k) is not None]
        return f"{fmt(row[k], k)} ({1 + sum(o > row[k] for o in others)}/{len(others) + 1})"
    rows = ['\\sys{} & ' + ' & '.join(ranked(final_row, k) for k in keys) + ' \\\\',
            '\\quad w/o consolidation & ' + ' & '.join(ranked(core_row, k) for k in keys) + ' \\\\', '\\midrule']
    for name in sorted(table, key=lambda n: -(table[n].get('locomo') or 0)):
        rows.append(name + ' & ' + ' & '.join(fmt(table[name].get(k), k) for k in keys) + ' \\\\')
    write('cross_benchmark', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{All five benchmarks}, for the systems OmniMemEval re-evaluated with gpt-4.1-mini answering (its numbers, gpt-4o-mini judge) and for \sys{} with and without consolidation (our runs, gpt-4.1-mini answering and judging; in parentheses, the rank among the systems with a score). LoCoMo and \lme{} were used in our design; \sys{} w/o consolidation was run once on HaluMem and BEAM with its configuration frozen, and \sys{}, whose consolidation was designed after those runs, is exploratory there. HaluMem: share of answers judged correct; BEAM: rubric score. Best per column in bold.}
\label{tab:cross}
\setlength{\tabcolsep}{5pt}
\begin{tabular}{@{}l ccccc@{}}
\toprule
& \multicolumn{2}{c}{design benchmarks} & \multicolumn{3}{c}{held-out benchmarks} \\
\cmidrule(lr){2-3}\cmidrule(l){4-6}
System & LoCoMo & \lme & HaluMem & BEAM-100K & BEAM-10M \\
\midrule
''' + '\n'.join(rows) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')

# BEAM-100K by ability: the registered hybrid run and the BM25 control.
BEAM_ABILITIES = {'abstention': 'abstention', 'contradiction_resolution': 'contradiction resolution', 'event_ordering': 'event ordering',
                  'information_extraction': 'information extraction', 'instruction_following': 'instruction following',
                  'knowledge_update': 'knowledge update', 'multi_session_reasoning': 'multi-session reasoning',
                  'preference_following': 'preference following', 'summarization': 'summarization', 'temporal_reasoning': 'temporal reasoning'}
def beam_abilities():
    """BEAM-100K by ability: scores of the registered run and the control, and where the gold evidence went
    (data/beam_evidence.json, from beam_evidence.py)."""
    H = R.get('heldout', {})
    h, b = (H.get('beam128k') or {}).get('mini'), (H.get('beam128k-bm25') or {}).get('mini')
    path = HERE / 'data/beam_evidence.json'
    if not h or not b or not path.exists(): return
    ev = json.load(open(path))['beam128k']
    pct = lambda v: '--' if v is None else f'{v:.0f}'
    order = sorted(h['per_type'], key=lambda t: -h['per_type'][t])
    # The final version (amendment 29), all 400 questions.
    fin = (F.get('scale', {}).get('100k-final') or {})
    fin_type, fin_all = (fin.get('by_type') or {}).get('mini', {}), (fin.get('accuracy') or {}).get('mini')
    rows = []
    for t in order:
        e = ev.get(t)
        cells = [f1(fin_type.get(t)), f"{h['per_type'][t]:.1f}", f"{b['per_type'][t]:.1f}"]
        if e:
            cells += [pct(e['all_shown']), pct(e['shown']), pct(e['judged']), pct(e['missed']),
                      '--' if e['score_all_shown'] is None else f"{e['score_all_shown']:.1f}"]
        else:
            cells += ['--'] * 5
        rows.append(BEAM_ABILITIES.get(t, t) + ' & ' + ' & '.join(cells) + ' \\\\')
    a = ev['all']
    total = (f"all & {f1(fin_all)} & {h['score']:.1f} & {b['score']:.1f} & {pct(a['all_shown'])} & {pct(a['shown'])} & {pct(a['judged'])} & "
             f"{pct(a['missed'])} & {a['score_all_shown']:.1f} \\\\")
    write('beam_abilities', r"""
\begin{gentable}
\centering
\small
\caption{\textbf{BEAM-100K by ability, and where the gold evidence went} (gpt-4.1-mini judge; 40 questions per ability). Scores of \sys{} (exploratory), \sys{} w/o consolidation (registered) and the same with BM25 only (registered control); then, for the registered run w/o consolidation, the share of questions whose evidence messages all appear in the View, what became of each evidence message (in the View; judged by \jev{} but left out; never retrieved), and the score of the questions whose evidence is all in the View. Evidence is the dataset's \texttt{source\_chat\_ids}; abstention questions have none. Message shares use the """ + f"{ev['_traced_questions']}" + r""" questions whose replica traces were kept.}
\label{tab:beam-abilities}
\setlength{\tabcolsep}{4pt}
\resizebox{\linewidth}{!}{%
\begin{tabular}{@{}l ccc c ccc c@{}}
\toprule
& \multicolumn{3}{c}{score} & \multicolumn{5}{c}{w/o consolidation (registered run)} \\
\cmidrule(lr){2-4}\cmidrule(l){5-9}
& & w/o & w/o cons., & questions with & \multicolumn{3}{c}{evidence messages (\%)} & score with \\
\cmidrule(lr){6-8}
ability & \sys{} & cons. & BM25 only & all evidence (\%) & in View & judged, left out & not retrieved & all evidence \\
\midrule
""" + '\n'.join(rows) + '\n\\midrule\n' + total + r"""
\bottomrule
\end{tabular}}
\end{gentable}""")

# ------------------------------------------------------------------------------------------------------------------
# The final version: what consolidation adds on each benchmark, BEAM-10M against BEAM-100K, and the text's macros.
ci_text = lambda p: f"{signed(p['diff'])} [{signed(p['ci95'][0])}, {signed(p['ci95'][1])}]"
CONS_ROWS = (('standard', 'locomo', 'LoCoMo', 'conversation'), ('standard', 'lme', '\\lme', 'history'), ('standard', 'halumem', 'HaluMem', 'user'),
             ('standard', 'beam100k', 'BEAM-100K', 'conversation'), ('standard', 'beam10m', 'BEAM-10M', 'conversation'),
             ('reasoning', 'locomo', 'LoCoMo', 'conversation'), ('reasoning', 'lme', '\\lme', 'history'))
def consolidation_table():
    lines, notes = [], []
    for setting, key, label, unit in CONS_ROWS:
        if (setting, key) == ('standard', 'locomo'): lines.append('\\multicolumn{8}{@{}l}{\\textit{Standard setting: gpt-4.1-mini answers and plans}} \\\\')
        if (setting, key) == ('reasoning', 'locomo'): lines.append('\\midrule\n\\multicolumn{8}{@{}l}{\\textit{Reasoning setting: DeepSeek-V4.1-Flash answers with thinking}} \\\\')
        x = done(setting, key)
        if not x and (setting, key) == ('standard', 'lme') and done('standard', 'lme-180'):
            x = done('standard', 'lme-180'); label += '$^\\dagger$'; notes.append('$^\\dagger$180 questions, 30 per type; the full run is pending.')
        if not x:
            lines.append(f"{label} & \\multicolumn{{7}}{{c}}{{{PENDING}}} \\\\"); continue
        c, f, pr = x['core'], x['final'], x['paired']
        acc = lambda s: ' / '.join('--' if s['accuracy'].get(j) is None else f"{s['accuracy'][j]:.1f}" for j in ('mini', 'deepseek'))
        diff = lambda j: ci_text(pr[j]) if j in pr else '--'
        w = x.get('write')
        lines.append(f"{label} & {c['n']:,} & {acc(c)} & {acc(f)} & {diff('mini')} & {diff('deepseek')} & {x['cost_ratio']:.2f} & "
                     + (f"{w['per_memory']:.3f}" if w else '--') + ' \\\\')
    write('consolidation', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{What consolidation adds}, paired on the same questions: accuracy (\%; BEAM: rubric score) of \sys{} without and with consolidation under the gpt-4.1-mini / DeepSeek judges, the paired difference with its 95\% interval under each judge, cost per question relative to the version without consolidation, and consolidation's one-time cost per memory in dollars (a conversation, a \lme{} history, a HaluMem user). The runs without consolidation are the registered ones. ''' + ' '.join(notes) + r'''}
\label{tab:consolidation}
\setlength{\tabcolsep}{3.4pt}
\resizebox{\linewidth}{!}{%
\begin{tabular}{@{}l r cc cc cc@{}}
\toprule
& & \multicolumn{2}{c}{accuracy (mini / DeepSeek)} & \multicolumn{2}{c}{paired difference [95\% interval]} & cost & write \\
\cmidrule(lr){3-4}\cmidrule(lr){5-6}
benchmark & $n$ & w/o cons. & \sys{} & gpt-4.1-mini judge & DeepSeek judge & $\times$ & \$/memory \\
\midrule
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}}
\end{gentable}''')

SCALE_ROWS = (('100k-bm25', 'BEAM-100K', 'w/o consolidation, BM25 only'), ('100k-core', 'BEAM-100K', 'w/o consolidation'), ('100k-final', 'BEAM-100K', '\\sys{}'),
              ('10m-A', 'BEAM-10M', 'w/o consolidation, BM25 only'), ('10m-B', 'BEAM-10M', 'w/o consolidation'), ('10m-C', 'BEAM-10M', '\\sys{}'))
def beam10m_table():
    S = F.get('scale', {})
    lines = []
    for key, tier, config in SCALE_ROWS:
        if key == '10m-A': lines.append('\\midrule')
        x = S.get(key)
        if not x or not x['accuracy']:
            lines.append(f"{tier} & {config} & \\multicolumn{{4}}{{c}}{{{PENDING}}} \\\\"); continue
        acc = ' / '.join('--' if x['accuracy'].get(j) is None else f"{x['accuracy'][j]:.1f}" for j in ('mini', 'deepseek'))
        lines.append(f"{tier} & {config} & {acc} & {1e3 * x['cost_per_question']:.2f} & {x['latency_p50_s']:.1f} & {x['jev_tokens_median'] / 1000:.0f}k \\\\")
    write('beam10m', r'''
\begin{gentable}
\centering
\small
\caption{\textbf{From a hundred thousand to ten million tokens.} BEAM-100K (20 conversations, 400 questions) and BEAM-10M (10 conversations of about 90,000 records each, 200 questions): rubric score under the gpt-4.1-mini / DeepSeek judges, cost per question (answer, planner and \jev, thousandths of a dollar at the reader's list prices), median latency, and median \jev{} input tokens per question. gpt-4.1-mini answers and plans in every row. Scores cover every question each run answered; \cref{tab:consolidation} pairs the questions both judges graded in both runs.}
\label{tab:beam10m}
\setlength{\tabcolsep}{4pt}
\begin{tabular}{@{}l l c c c c@{}}
\toprule
& configuration & score & $10^{-3}$\,\$/q & p50 (s) & \jev{} tok. \\
\midrule
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')

# Accuracy by question type: Mnemon with gpt-4.1-mini and with the reasoning reader (both graded by gpt-4.1-mini),
# against the two strongest systems OmniMemEval re-evaluated (its numbers, gpt-4o-mini judge).
TYPE_NAMES = {'single-hop': 'single-hop', 'multi-hop': 'multi-hop', 'temporal': 'temporal', 'open-domain': 'open-domain',
              'single-session-user': 'single-session, user', 'single-session-assistant': 'single-session, assistant',
              'single-session-preference': 'single-session, preference', 'temporal-reasoning': 'temporal reasoning',
              'multi-session': 'multi-session', 'knowledge-update': 'knowledge update'}
def by_type_table():
    lines = []
    for d, label, key, types in (('locomo', 'LoCoMo', 'locomo_categories', LOCOMO_TYPES), ('lme', '\\lme', 'lme_categories', LME_TYPES)):
        cats = P['omnimemeval'][key]
        order = cats['_order']
        std, rsn = done('standard', d), done('reasoning', d)
        counts = R['gpt41mini_chain'][d]['runs'][MAIN[0]]['mini'].get('per_type_n') or {}
        lines.append(f"\\multicolumn{{6}}{{@{{}}l}}{{\\textit{{{label}}}}} \\\\")
        for t in types:
            vals = [get_type(std, t), get_type(rsn, t), cats['MemOS'][order.index(t)], cats['EverOS'][order.index(t)]]
            top = max(v for v in vals if v is not None)
            cell = lambda v, pub=False: '--' if v is None else (lambda s: '\\best{' + s + '}' if v == top else s)(given(v) if pub else f'{v:.1f}')
            lines.append(f"\\quad {TYPE_NAMES[t]} & {counts.get(t, 0):,} & {cell(vals[0])} & {cell(vals[1])} & {cell(vals[2], True)} & {cell(vals[3], True)} \\\\")
    write('by_type', r'''
\begin{gentable}[!htb]
\centering
\small
\caption{Accuracy (\%) by question type. \sys{} is graded by gpt-4.1-mini with gpt-4.1-mini or DeepSeek-V4.1-Flash (thinking) answering; MemOS and EverOS, the strongest systems OmniMemEval re-evaluated, are its numbers with gpt-4.1-mini answering and gpt-4o-mini grading. Best per row in bold.}
\label{tab:by-type}
\setlength{\tabcolsep}{5pt}
\begin{tabular}{@{}l r cc cc@{}}
\toprule
& & \multicolumn{2}{c}{\sys} & & \\
\cmidrule(lr){3-4}
question type & questions & gpt-4.1-mini & reasoning reader & MemOS & EverOS \\
\midrule
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')

def get_type(x, t):
    """The final version's accuracy on one question type under the gpt-4.1-mini judge, or None."""
    return None if not x else x['final'].get('by_type', {}).get('mini', {}).get(t)

# Mnemon on every benchmark in the standard setting: score under both judges, rank among the systems
# OmniMemEval re-evaluated, answer-stage context, full cost per question, latency, and consolidation's one-time cost.
OURS_ROWS = (('locomo', 'LoCoMo'), ('lme', '\\lme'), ('halumem', 'HaluMem'), ('beam100k', 'BEAM-100K'), ('beam10m', 'BEAM-10M'))
def ours_table():
    S, om = F.get('scale', {}), P['omnimemeval']
    published = {'locomo': [s['locomo'] for s in om['systems'].values()], 'lme': [s['lme'] for s in om['systems'].values()],
                 'halumem': [v for k, v in om['halumem'].items() if not k.startswith('_')],
                 'beam100k': [v[0] for k, v in om['beam'].items() if not k.startswith('_')],
                 'beam10m': [v[1] for k, v in om['beam'].items() if not k.startswith('_')]}
    lines = []
    for key, label in OURS_ROWS:
        x = done('standard', key)
        # BEAM: every question answered; the paired comparisons keep only those both judges graded in both runs.
        run = S.get({'beam100k': '100k-final', 'beam10m': '10m-C'}[key]) if key.startswith('beam') else (x or {}).get('final')
        if not run or not run.get('accuracy'):
            lines.append(f"{label} & \\multicolumn{{7}}{{c}}{{{PENDING}}} \\\\"); continue
        acc, others = run['accuracy'], [v for v in published[key] if v is not None]
        w = (x or {}).get('write')
        write_cell = '--' if not w else f"{w['per_memory']:.3f}" if w['per_memory'] < 1 else f"{w['per_memory']:.2f}"
        lines.append(f"{label} & {run['n']:,} & {acc['mini']:.1f} / {acc['deepseek']:.1f} & {1 + sum(v > acc['mini'] for v in others)}/{len(others) + 1} & "
                     f"{run['answer_input_tokens'] / 1000:.1f}k & {1e3 * run['cost_per_question']:.2f} & {run['latency_p50_s']:.1f} & {write_cell} \\\\")
    write('ours', r'''
\begin{gentable}[!htb]
\centering
\small
\caption{\sys{} on five benchmarks with gpt-4.1-mini answering: score under the gpt-4.1-mini / DeepSeek judges (accuracy; HaluMem: share of answers judged correct; BEAM: rubric score), rank among the systems OmniMemEval re-evaluated, context per question, cost per question in thousandths of a dollar (answer, planner and \jev{} at list prices), median latency, and consolidation's one-time cost in dollars per memory (a conversation, a \lme{} history, a HaluMem user).}
\label{tab:ours}
\setlength{\tabcolsep}{4.5pt}
\begin{tabular}{@{}l r c c c c c c@{}}
\toprule
benchmark & questions & score & rank & context & $10^{-3}$\,\$/question & p50 (s) & \$/memory \\
\midrule
''' + '\n'.join(lines) + r'''
\bottomrule
\end{tabular}
\end{gentable}''')

def final_numbers(macros):
    """Macros for the final version; a run still in progress prints as \\pending."""
    std, rsn, S = F.get('standard', {}), F.get('reasoning', {}), F.get('scale', {})
    get = lambda x, *path: None if x is None else (x if not path else get(x.get(path[0]) if isinstance(x, dict) else None, *path[1:]))
    one = lambda v: PENDING if v is None else f'{v:.1f}'
    ci = lambda p: PENDING if p is None else f"{signed(p['ci95'][0])} to {signed(p['ci95'][1])}"
    for D, key in (('LoCoMo', 'locomo'), ('LME', 'lme')):
        x = done('standard', key)
        macros[f'fin{D}'] = one(get(x, 'final', 'accuracy', 'mini')); macros[f'fin{D}DS'] = one(get(x, 'final', 'accuracy', 'deepseek'))
        tok = get(x, 'final', 'answer_input_tokens'); macros[f'finCtx{D}'] = PENDING if tok is None else f'{tok / 1000:.1f}k'
        p = get(x, 'paired', 'mini')
        if p is None and key == 'lme' and done('standard', 'lme-180'):
            p180 = done('standard', 'lme-180')['paired']['mini']
            macros['consLME'] = f"{signed(p180['diff'])} (on a 180-question subset)"
        else: macros[f'cons{D}'] = PENDING if p is None else signed(p['diff'])
        macros[f'cons{D}Abs'] = PENDING if p is None else f"{abs(p['diff']):.1f}"
        macros[f'cons{D}CI'] = ci(p)
        w = get(x, 'write') or get(done('standard', 'lme-180'), 'write') if key == 'lme' else get(x, 'write')
        macros[f'write{D}'] = PENDING if not w else f"{w['per_memory']:.3f}"
        y = done('reasoning', key)
        macros[f'dsFin{D}'] = one(get(y, 'final', 'accuracy', 'deepseek')); macros[f'dsFin{D}Mini'] = one(get(y, 'final', 'accuracy', 'mini'))
        q = get(y, 'paired', 'deepseek'); macros[f'dsCons{D}'] = PENDING if q is None else signed(q['diff']); macros[f'dsCons{D}CI'] = ci(q)
        # ECI of the final version (answer-stage context), and the lowest of the other systems'.
        rows, name = {n: e for n, a, c, e, _ in eci_rows(key)}, '\\sys{}'
        macros[f'finEci{D}'] = f'{rows[name]:.3f}' if name in rows else PENDING
        e, n = min((e, n) for n, a, c, e, ours in eci_rows(key, core=False) if not ours)
        macros[f'eciOther{D}'], macros[f'eciOtherName{D}'] = f'{e:.3f}', n
        # The reasoning reader: absolute consolidation gain (DeepSeek judge) and cost per question at off-peak prices.
        macros[f'dsCons{D}Abs'] = PENDING if q is None else f"{abs(q['diff']):.1f}"
        c = get(y, 'final', 'cost_per_question'); macros[f'dsCost{D}'] = PENDING if c is None else f'{c:.4f}'
    macros['dsFinLoCoMoRev'] = one(get(done('reasoning', 'locomo'), 'final', 'labels', 'deepseek', 'revised'))
    # What the reasoning reader adds to the final version on LongMemEval-S (same memory, gpt-4.1-mini judge).
    g = get(rsn, 'lme-reader', 'paired', 'mini')
    macros['readerGainLME'] = PENDING if g is None else f"{g['diff']:.1f}"; macros['readerGainLMECI'] = ci(g)
    b = done('standard', 'beam100k')
    macros['coreBeam'] = one(get(b, 'core', 'accuracy', 'mini')); macros['finBeam'] = one(get(b, 'final', 'accuracy', 'mini'))
    macros['consBeam'] = PENDING if not b else signed(b['paired']['mini']['diff']); macros['consBeamCI'] = ci(get(b, 'paired', 'mini'))
    macros['consBeamAbs'] = PENDING if not b else f"{abs(b['paired']['mini']['diff']):.1f}"
    macros['consBeamN'] = PENDING if not b else f"{b['paired']['mini']['n']:,}"
    ratios = [x['cost_ratio'] for k, x in std.items() if k in ('locomo', 'lme', 'lme-180', 'halumem', 'beam100k') and x and x.get('paired')]
    macros['consCostRange'] = f'{min(ratios):.2f}--{max(ratios):.2f}' if ratios else PENDING
    halu = [v for k, v in P['omnimemeval']['halumem'].items() if not k.startswith('_')]
    beam = {k: v for k, v in P['omnimemeval']['beam'].items() if not k.startswith('_')}
    h = get(done('standard', 'halumem'), 'final', 'accuracy', 'mini')
    macros['finHalu'] = one(h); macros['finHaluRankWord'] = PENDING if h is None else WORDS[sum(v > h for v in halu)]
    fb = get(S, '100k-final', 'accuracy', 'mini')
    macros['finBeamRankWord'] = PENDING if fb is None else WORDS[sum(v[0] > fb for v in beam.values())]
    # BEAM-10M.
    for run in 'ABC':
        macros[f'beamTen{run}'] = one(get(S, f'10m-{run}', 'accuracy', 'mini')); macros[f'beamTen{run}DS'] = one(get(S, f'10m-{run}', 'accuracy', 'deepseek'))
    for run, ref in (('A', '100k-bm25'), ('B', '100k-core'), ('C', '100k-final')):
        x, r = S.get(f'10m-{run}'), S.get(ref)
        macros[f'beamTenCostRatio{run}'] = PENDING if not x or not r else f"{x['cost_per_question'] / r['cost_per_question']:.2f}"
        macros[f'beamTenLat{run}'] = PENDING if not x or not r else f"{x['latency_p50_s'] - r['latency_p50_s']:.1f}"
    t = done('standard', 'beam10m')
    macros['consBeamTen'] = PENDING if not t else signed(t['paired']['mini']['diff']); macros['consBeamTenCI'] = ci(get(t, 'paired', 'mini'))
    macros['consBeamTenAbs'] = PENDING if not t else f"{abs(t['paired']['mini']['diff']):.1f}"
    w = get(std, 'beam10m', 'write')
    macros.update(beamTenBatches=PENDING if not w else f"{w['batches']:,}", beamTenWrite=PENDING if not w else f"{w['total']:.2f}",
                  beamTenWritePer=PENDING if not w else f"{w['per_memory']:.2f}", beamTenWriteQ=PENDING if not w else f"{w['per_question']:.3f}",
                  beamTenTopics=PENDING if not w else f"{w['topics'] / w['memories']:,.0f}", beamTenValues=PENDING if not w else f"{w['values'] / w['memories']:,.0f}")
    c = get(S, '10m-C', 'accuracy', 'mini')
    macros['beamTenRankWord'] = PENDING if c is None else WORDS[sum(v[1] > c for v in beam.values())]
    # Temporal reasoning on LongMemEval-S in the reasoning setting, core and final (DeepSeek judge, paired questions).
    y = done('reasoning', 'lme')
    macros['dsTemporalCore'] = one(get(y, 'core', 'by_type', 'deepseek', 'temporal-reasoning'))
    macros['dsTemporalFinal'] = one(get(y, 'final', 'by_type', 'deepseek', 'temporal-reasoning'))

if __name__ == '__main__':
    consolidation_table(); beam10m_table(); ours_table(); by_type_table()
    main_standard(); paired_standard(); costs_standard(); deepseek_ladder(); simple_table(); cross_benchmark(); beam_abilities()
    omnimemeval(); self_reported(); best_reported(); eci(); system1()
    label_variants(); deepseek_types(); reader_combos(); heldout(); halumem_causes(); halumem_variants_table()
    numbers(); main_costs(); ablation()
