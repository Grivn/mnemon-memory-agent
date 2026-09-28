"""Draw the paper's figures from data/results.json (our runs, see collect.py) and data/reported.json (earlier reports
and published numbers). Writes vector PDFs into figures/.

    python3 docs/paper/scripts/figures.py        (needs matplotlib)
"""
import json, math
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

HERE = Path(__file__).resolve().parents[1]
R = json.load(open(HERE / 'data/results.json'))
P = json.load(open(HERE / 'data/reported.json'))
OUT = HERE / 'figures'
OUT.mkdir(exist_ok=True)

# Validated categorical slots (light mode), gray for context, text inks.
BLUE, ORANGE, AQUA, NAVY = '#2a78d6', '#eb6834', '#1baf7a', '#123f7a'
GRAY, INK, INK2, GRID = '#8f8e89', '#0b0b0b', '#52514e', '#e4e3df'
plt.rcParams.update({
    'font.family': 'serif', 'font.serif': ['Times New Roman', 'STIXGeneral', 'DejaVu Serif'], 'mathtext.fontset': 'stix',
    'font.size': 8.5, 'axes.titlesize': 9, 'axes.labelsize': 8.5, 'xtick.labelsize': 7.5, 'ytick.labelsize': 7.5, 'legend.fontsize': 7.5,
    'axes.edgecolor': INK2, 'axes.linewidth': 0.6, 'axes.labelcolor': INK, 'xtick.color': INK2, 'ytick.color': INK2,
    'xtick.major.width': 0.6, 'ytick.major.width': 0.6, 'axes.spines.top': False, 'axes.spines.right': False,
    'axes.grid': True, 'grid.color': GRID, 'grid.linewidth': 0.5, 'axes.axisbelow': True,
    'legend.frameon': False, 'pdf.fonttype': 42, 'ps.fonttype': 42, 'savefig.bbox': 'tight', 'savefig.pad_inches': 0.02,
})
W = 6.5  # text width in inches

import sys
PREVIEW = Path(sys.argv[sys.argv.index('--png') + 1]) if '--png' in sys.argv else None
ONLY = [a for a in sys.argv[1:] if not a.startswith('--') and (PREVIEW is None or Path(a) != PREVIEW)]

def save(fig, name):
    fig.savefig(OUT / f'{name}.pdf')
    if PREVIEW: PREVIEW.mkdir(parents=True, exist_ok=True); fig.savefig(PREVIEW / f'{name}.png', dpi=220)
    plt.close(fig); print('wrote', OUT / f'{name}.pdf')

# ---------------------------------------------------------------------------------------------------------------
# Figure: accuracy against the context each question sends to the answering model (OmniMemEval, gpt-4.1-mini), with
# lines of equal effective cost index ECI = (1 - a) + c / c_full.
def tradeoff():
    fig, axes = plt.subplots(1, 2, figsize=(W, 2.9))
    systems = P['omnimemeval']['systems']
    # Label offsets (points) chosen per benchmark so that no two labels collide.
    offsets = {
        'locomo': {'MemOS': (4, 0), 'EverOS': (-4, 3), 'Cognee': (4, 0), 'Hindsight': (-4, 0), 'Mem0': (4, 0), 'Letta': (-4, -5),
                   'Supermemory': (4, -2), 'MemoryLake': (4, -1), 'Viking Memory': (4, -2), 'MemMachine': (0, 5), 'mem9': (-4, 0),
                   'Zep': (4, 0), 'Memori': (4, 0), 'Backboard.io': (4, 0)},
        'lme': {'MemOS': (4, 0), 'mem9': (4, -5), 'EverOS': (4, 0), 'Zep': (-3, 5), 'Letta': (0, 5), 'Hindsight': (4, 0),
                'Supermemory': (4, 0), 'MemMachine': (4, 0), 'Viking Memory': (4, -6), 'Mem0': (4, -6), 'Cognee': (4, 0), 'Memori': (4, 0)},
    }
    # Crowded systems get their labels in a column at the right, joined to their points by thin leader lines.
    callouts = {'locomo': ['Cognee', 'MemOS', 'EverOS', 'Hindsight', 'Mem0', 'Letta', 'Supermemory', 'MemoryLake', 'Viking Memory'], 'lme': []}
    for ax, ds, title in ((axes[0], 'locomo', 'LoCoMo (1,540 questions)'), (axes[1], 'lme', 'LongMemEval-S (500 questions)')):
        full = P['full_context_tokens'][ds]
        lo, hi = 700, 1.6e5
        bottom = 15 if ds == 'lme' else 18
        for e in (0.2, 0.4, 0.6, 1.0):
            cs = [10 ** (math.log10(lo) + i * (math.log10(hi) - math.log10(lo)) / 300) for i in range(301)]
            pts = [(c, 100 * (1 - e + c / full)) for c in cs if 0 <= 100 * (1 - e + c / full) <= 100]
            if not pts: continue
            ax.plot([p[0] for p in pts], [p[1] for p in pts], color=GRAY, lw=0.6, ls=(0, (3, 2)), zorder=1)
            # The index's value is written where its line leaves the top of the plot (accuracy 100% at c = ECI x c_full).
            if lo < e * full < hi:
                ax.annotate(f'{e:g}', (e * full, 100), xytext=(0, 2), textcoords='offset points', fontsize=6.3, color=INK2, ha='center', va='bottom', annotation_clip=False)
        ax.annotate('ECI', (lo, 100), xytext=(0, 2), textcoords='offset points', fontsize=6.3, color=INK2, ha='left', va='bottom', annotation_clip=False)
        placed = [n for n in callouts[ds] if systems[n][ds] is not None]
        slots = {n: 91 - 3.6 * k for k, n in enumerate(sorted(placed, key=lambda n: -systems[n][ds]))}
        for name, s in systems.items():
            if s[ds] is None: continue
            x, y = s['ctx_' + ds], s[ds]
            ax.scatter(x, y, s=14, color=GRAY, edgecolor='white', linewidth=0.5, zorder=3)
            if name in slots:
                ax.annotate(name, (x, y), xytext=(4.6e4, slots[name]), textcoords='data', fontsize=6.3, color=INK2, ha='left', va='center',
                            arrowprops=dict(arrowstyle='-', color='#c3c2b7', lw=0.5, shrinkA=0, shrinkB=2))
                continue
            off = offsets[ds].get(name, (4, 0))
            ha = 'right' if off[0] < 0 else 'center' if off[0] == 0 else 'left'
            ax.annotate(name, (x, y), xytext=off, textcoords='offset points', fontsize=6.3, color=INK2, ha=ha, va='center')
        # Which way is better: less context, more accuracy.
        ax.annotate('better', xy=(1.5e4 if ds == 'locomo' else 2.2e4, 38 if ds == 'locomo' else 33), xytext=(5.6e4 if ds == 'locomo' else 8.5e4, 27 if ds == 'locomo' else 22),
                    fontsize=6.5, color=INK2, ha='center', va='center', arrowprops=dict(arrowstyle='-|>', color=INK2, lw=0.7))
        # Mnemon at the answer stage, the quantity reported for the other systems.
        fin = (R.get('final', {}).get('standard', {}).get(ds) or {})
        if fin.get('paired'):
            f = fin['final']
            a_ctx, acc = f['answer_input_tokens'], f['accuracy']['mini']
            ax.scatter([a_ctx], [acc], s=70, color=NAVY, marker='*', edgecolor='white', linewidth=0.5, zorder=6)
            ax.annotate('Mnemon', (a_ctx, acc), xytext=(-5, 5), textcoords='offset points', fontsize=7.5, color=NAVY, ha='right', va='bottom', fontweight='bold')
        ax.set_xscale('log'); ax.set_xlim(lo, hi); ax.set_ylim(15 if ds == 'lme' else 18, 100)
        ax.set_xlabel('tokens per question (log scale)'); ax.set_title(title, loc='left', pad=13)
    axes[0].set_ylabel('accuracy (%)')
    handles = [Line2D([], [], marker='*', ls='', color=NAVY, markersize=8, label='Mnemon'),
               Line2D([], [], marker='o', ls='', color=GRAY, markersize=4, label='systems re-evaluated by OmniMemEval'),
               Line2D([], [], color=GRAY, lw=0.6, ls=(0, (3, 2)), label='equal effective cost index (value at top)')]
    fig.legend(handles=handles, loc='upper center', ncol=3, bbox_to_anchor=(0.5, 0.06), handletextpad=0.3, columnspacing=1.6)
    fig.subplots_adjust(bottom=0.24, wspace=0.18)
    save(fig, 'tradeoff')

# ---------------------------------------------------------------------------------------------------------------
# Figure: the configuration ladder for both answering models.
def ladder():
    fig, axes = plt.subplots(1, 2, figsize=(W, 2.45), sharey=False)
    steps = ['S0', 'S4h', 'S5h', 'S6', 'simple']
    names = ['S0\ncue\nrecall', 'S4h\n+hybrid', 'S5h\n+loop', 'S6\n+unsure\nfill', 'simple\nbudgets\nonly']
    for ax, ds, title in ((axes[0], 'locomo', 'LoCoMo'), (axes[1], 'lme', 'LongMemEval-S')):
        mini = R['gpt41mini_chain'][ds]['runs']; deep = R['deepseek_chain'][ds]['runs']
        yd = {x: deep[s]['deepseek']['accuracy'] for x, s in enumerate(steps)}
        ym = {x: mini[s]['mini']['accuracy'] for x, s in ((0, 'S0'), (1, 'S4h'), (3, 'S6'))}
        ax.plot(list(yd), list(yd.values()), color=ORANGE, lw=1.4, marker='o', markersize=4, markeredgecolor='white', markeredgewidth=0.6, zorder=3)
        ax.plot(list(ym), list(ym.values()), color=BLUE, lw=1.4, marker='o', markersize=4, markeredgecolor='white', markeredgewidth=0.6, zorder=3)
        fast = mini['fast']['mini']['accuracy']
        ax.scatter([3.3], [fast], marker='s', s=16, color=BLUE, edgecolor='white', linewidth=0.5, zorder=4)
        ax.annotate(f'fast {fast:.1f}', (3.3, fast), xytext=(4, 0), textcoords='offset points', fontsize=6.3, color=INK2, va='center')
        # The higher of the two readers at a step is labelled above its point, the lower one below.
        for x in range(5):
            here = [(yd[x], ORANGE)] + ([(ym[x], BLUE)] if x in ym else [])
            top = max(v for v, _ in here)
            for v, _ in here:
                ax.annotate(f'{v:.1f}', (x, v), xytext=(0, 5 if v == top else -9), textcoords='offset points', ha='center', fontsize=6.3, color=INK2)
        ax.set_xticks(range(5)); ax.set_xticklabels(names, fontsize=6.8); ax.set_title(title, loc='left')
        values = list(yd.values()) + list(ym.values()) + [fast]
        ax.set_ylim(math.floor(min(values) - 2), math.ceil(max(values) + 1.5)); ax.set_xlim(-0.4, 4.4); ax.grid(axis='x', visible=False)
    axes[0].set_ylabel('accuracy (%)')
    handles = [Line2D([], [], color=ORANGE, marker='o', lw=1.4, markersize=4, label='DeepSeek reader (thinking), DeepSeek judge'),
               Line2D([], [], color=BLUE, marker='o', lw=1.4, markersize=4, label='gpt-4.1-mini reader, gpt-4.1-mini judge')]
    fig.legend(handles=handles, loc='upper center', ncol=2, bbox_to_anchor=(0.5, 0.04))
    fig.subplots_adjust(bottom=0.27, wspace=0.18)
    save(fig, 'ladder')

# ---------------------------------------------------------------------------------------------------------------
# Figure: System 1 comparison. ROC curves on the same judged items; latency per call.
def system1():
    curves = R.get('system1_roc', {})
    summary = R['system1_summary']
    fig, axes = plt.subplots(1, 2, figsize=(W, 2.0), gridspec_kw={"width_ratios": [1, 1.25]})
    ax = axes[0]
    colors = {'JEV': BLUE, 'DeepSeek': ORANGE, 'gpt-4.1-mini': AQUA}
    both = lambda name: summary.get('all', {}).get(name, {})
    for name in ('JEV', 'DeepSeek', 'gpt-4.1-mini'):
        if name not in curves: continue
        xs, ys = zip(*curves[name])
        auc = both(name).get('auc_pooled')
        ax.plot(xs, ys, color=colors[name], lw=1.2, label=('Jev' if name == 'JEV' else name) + (f' (AUC {auc:.3f})' if auc else ''))
    ax.plot([0, 1], [0, 1], color=GRAY, lw=0.6, ls=(0, (3, 2)))
    ax.set_xlim(0, 1); ax.set_ylim(0, 1.01); ax.set_xlabel('false positive rate'); ax.set_ylabel('true positive rate')
    ax.set_title('(a) separating gold evidence', loc='left'); ax.legend(loc='lower right', handlelength=1.4, frameon=True, facecolor='white', edgecolor='none', framealpha=0.95, borderpad=0.3)
    ax = axes[1]
    rows = [(n, both(n)) for n in ('JEV', 'DeepSeek', 'gpt-4.1-mini')]
    for i, (name, s) in enumerate(rows):
        ax.barh(i, s['latency_p50_s'], height=0.5, color=colors[name])
        ax.annotate(f"{s['latency_p50_s']:.2f} s,  \\${s['cost_per_call'] * 1e3:.2f} per 1,000 calls",
                    (s['latency_p50_s'], i), xytext=(4, 0), textcoords='offset points', va='center', fontsize=6.5, color=INK2)
    ax.set_yticks(range(len(rows))); ax.set_yticklabels(['Jev' if n == 'JEV' else n for n, _ in rows]); ax.invert_yaxis()
    ax.set_xlim(0, 6.2); ax.set_xlabel('median latency per call of 24 items (s)'); ax.grid(axis='y', visible=False)
    ax.set_title('(b) latency and price of one call', loc='left')
    fig.subplots_adjust(wspace=0.42)
    save(fig, 'system1')

# ---------------------------------------------------------------------------------------------------------------
# Figure: what a stronger reader can use. (a) evidence all within the first k items of JEV's order; (b) where errors lie.
def reader():
    d = P['deepseek_vs_mini']
    fig, axes = plt.subplots(1, 2, figsize=(W, 2.3), gridspec_kw={'width_ratios': [1, 1.35]})
    ax = axes[0]; k = d['coverage_by_view_size']['_k']
    for ds, color, label in (('locomo', BLUE, 'LoCoMo'), ('lme', ORANGE, 'LongMemEval-S')):
        ys = d['coverage_by_view_size'][ds]
        ax.plot(k, ys, color=color, lw=1.4, marker='o', markersize=3.5, markeredgecolor='white', markeredgewidth=0.5)
        ax.annotate(label, (k[-1], ys[-1]), xytext=(4, 0), textcoords='offset points', va='center', fontsize=7, color=INK)
    ax.set_xticks(k); ax.set_xlim(2, 31); ax.set_ylim(60, 95)
    ax.set_xlabel('View size k (records, in Jev order)'); ax.set_ylabel('questions with all evidence in top k (%)')
    ax.set_title('(a) evidence coverage by View size', loc='left')
    ax = axes[1]
    e = d['error_decomposition_pct_of_all']
    bars = [('LongMemEval-S, gpt-4.1-mini', e['lme_mini']), ('LongMemEval-S, DeepSeek', e['lme_deepseek']),
            ('LoCoMo, gpt-4.1-mini', e['locomo_mini']), ('LoCoMo, DeepSeek', e['locomo_deepseek'])]
    segs = [('evidence all shown, answer wrong', BLUE), ('evidence partly missing', ORANGE), ('no evidence annotated', GRAY)]
    for i, (label, vals) in enumerate(bars):
        left = 0
        for (name, color), v in zip(segs, vals):
            ax.barh(i, v, left=left, height=0.55, color=color, edgecolor='white', linewidth=1.0)
            if v >= 2: ax.annotate(f'{v:.1f}', (left + v / 2, i), ha='center', va='center', fontsize=6.5, color='white')
            left += v
        ax.annotate(f'{left:.1f}', (left, i), xytext=(3, 0), textcoords='offset points', va='center', fontsize=6.5, color=INK2)
    ax.set_yticks(range(len(bars))); ax.set_yticklabels([b[0] for b in bars], fontsize=7); ax.invert_yaxis()
    ax.set_xlim(0, 21); ax.set_xlabel('wrong answers (% of all questions)'); ax.grid(axis='y', visible=False)
    ax.set_title('(b) where the errors are (S6, DeepSeek judge)', loc='left')
    ax.legend(handles=[Line2D([], [], color=c, lw=5, label=n) for n, c in segs], loc='upper center', bbox_to_anchor=(0.35, -0.24),
              ncol=3, fontsize=6.3, handlelength=0.9, columnspacing=0.8)
    save(fig, 'reader')

# ---------------------------------------------------------------------------------------------------------------
# Figure: what grows with the memory. (a) JEV input per question, cue recall vs a full JEV scan; (b) LongMemEval
# accuracy as the history is replicated 1x, 2x, 4x (60 questions), cue recall vs full context.
def scaling():
    c = P['cue_recall']
    fig, axes = plt.subplots(1, 2, figsize=(W, 2.3))
    ax = axes[0]
    labels = ['LoCoMo, one\nconversation', 'LongMemEval-S', 'LoCoMo, ten\nconversations']
    keys = ['locomo single', 'lme', 'locomo ten merged']
    x = range(len(keys))
    ax.bar([i - 0.18 for i in x], [c['jev_input_per_question']['cue'][k] / 1e3 for k in keys], width=0.34, color=BLUE, label='cue recall (pool of 48)')
    ax.bar([i + 0.18 for i in x], [c['jev_input_per_question']['full scan'][k] / 1e3 for k in keys], width=0.34, color=ORANGE, label='full Jev scan of memory')
    for i, k in enumerate(keys):
        for dx, v in ((-0.18, c['jev_input_per_question']['cue'][k]), (0.18, c['jev_input_per_question']['full scan'][k])):
            ax.annotate(f'{v / 1e3:.0f}k', (i + dx, v / 1e3), xytext=(0, 2), textcoords='offset points', ha='center', fontsize=6.5, color=INK2)
    ax.set_xticks(list(x)); ax.set_xticklabels(labels, fontsize=7); ax.set_ylabel('Jev input tokens per question (thousands)')
    ax.set_ylim(0, 200); ax.grid(axis='x', visible=False); ax.legend(loc='upper left')
    ax.set_title('(a) judging cost against memory size', loc='left')
    ax = axes[1]; h = c['history_scaling_lme60']
    ax.plot(h['_x'], h['full_context'], color=ORANGE, lw=1.4, marker='o', markersize=3.5, markeredgecolor='white', markeredgewidth=0.5)
    ax.plot(h['_x'], h['cue'], color=BLUE, lw=1.4, marker='o', markersize=3.5, markeredgecolor='white', markeredgewidth=0.5)
    ax.annotate('full context', (4, h['full_context'][-1]), xytext=(4, 0), textcoords='offset points', va='center', fontsize=7)
    ax.annotate('cue recall', (4, h['cue'][-1]), xytext=(4, 0), textcoords='offset points', va='center', fontsize=7)
    for xv, tok in zip(h['_x'], h['full_context_tokens']):
        ax.annotate(f'{tok / 1e3:.0f}k tok', (xv, h['full_context'][h['_x'].index(xv)]), xytext=(0, 5), textcoords='offset points', ha='center', fontsize=6, color=INK2)
    ax.set_xscale('log', base=2); ax.set_xticks(h['_x']); ax.set_xticklabels(['1×', '2×', '4×']); ax.set_xlim(0.8, 6.5); ax.set_ylim(70, 100)
    ax.set_xlabel('history length (LongMemEval-S replicated)'); ax.set_ylabel('accuracy (%), 60 questions')
    ax.set_title('(b) accuracy as history grows', loc='left')
    save(fig, 'scaling')

# ---------------------------------------------------------------------------------------------------------------
# The paper's main configurations (as in tables.py): the simple mode once measured with gpt-4.1-mini, else S6.
_std = [R['gpt41mini_chain'][d]['runs'] for d in ('locomo', 'lme')]
MAIN = ('simple', 'simple-fast') if all('simple' in runs and 'simple-fast' in runs for runs in _std) else ('S6', 'fast')

# Figure: what each component adds (forest plot of paired differences with 95% intervals).
def forest():
    rows = json.load(open(HERE / 'data/ablation.json'))
    comps = ['hybrid retrieval', 'judge--act loop', 'unsure fill', 'loop and unsure fill', 'budgets for rules', 'consolidation', 'no planner', 'all together']
    comps = [c for c in comps if any(r['component'] == c for r in rows)]
    fig, axes = plt.subplots(1, 2, figsize=(W, 2.9), sharey=True)
    for ax, d, title in ((axes[0], 'locomo', 'LoCoMo'), (axes[1], 'lme', 'LongMemEval-S')):
        ax.axvline(0, color=INK2, lw=0.7)
        for i, c in enumerate(comps):
            for reader, color, dy in (('DeepSeek', ORANGE, -0.15), ('gpt-4.1-mini', BLUE, 0.15)):
                x = next((r for r in rows if r['component'] == c and r['reader'] == reader and r['benchmark'] == d), None)
                if not x: continue
                ax.plot(x['ci95'], [i + dy] * 2, color=color, lw=1.4, solid_capstyle='butt')
                ax.scatter([x['diff']], [i + dy], s=22 if x['p'] < 0.05 else 16, color=color if x['p'] < 0.05 else 'white',
                           edgecolor=color, linewidth=1.1, zorder=3)
        ax.set_yticks(range(len(comps))); ax.set_yticklabels([c.replace('--', '–') for c in comps])
        ax.set_xlabel('paired difference in accuracy (points)'); ax.set_title(title, loc='left'); ax.grid(axis='y', visible=False)
        lo = min(min(r['ci95']) for r in rows if r['benchmark'] == d); hi = max(max(r['ci95']) for r in rows if r['benchmark'] == d)
        ax.set_xlim(math.floor(lo) - 0.5, math.ceil(hi) + 0.5)
    axes[0].invert_yaxis()   # the axes share y: invert once
    handles = [Line2D([], [], color=ORANGE, marker='o', lw=1.4, markersize=4.5, label='DeepSeek reader'),
               Line2D([], [], color=BLUE, marker='o', lw=1.4, markersize=4.5, label='gpt-4.1-mini reader'),
               Line2D([], [], color=GRAY, marker='o', lw=0, markerfacecolor='white', markersize=4.5, label='hollow: exact McNemar $p \\geq 0.05$')]
    fig.legend(handles=handles, loc='upper center', ncol=3, bbox_to_anchor=(0.55, 0.09))
    fig.subplots_adjust(bottom=0.27, wspace=0.08)
    save(fig, 'forest')

# Figure: accuracy by question type against the strongest re-evaluated systems (same answering model).
def categories():
    om = P['omnimemeval']
    std = R['gpt41mini_chain']
    specs = (('locomo', 'LoCoMo', ['single-hop', 'multi-hop', 'temporal', 'open-domain'], ['single-\nhop', 'multi-\nhop', 'temporal', 'open-\ndomain'], om['locomo_categories']),
             ('lme', 'LongMemEval-S', ['single-session-user', 'single-session-assistant', 'single-session-preference', 'temporal-reasoning', 'multi-session', 'knowledge-update'],
              ['SS-\nuser', 'SS-\nasst.', 'SS-\npref.', 'temp.', 'multi-\nsess.', 'know.\nupdate'], om['lme_categories']))
    fig, axes = plt.subplots(1, 2, figsize=(W, 2.35), gridspec_kw={'width_ratios': [5, 7]})
    from matplotlib.colors import LinearSegmentedColormap
    cmap = LinearSegmentedColormap.from_list('seq', ['#f3f7fc', '#9dc3ee', BLUE, '#123f7a'])
    for ax, (d, title, keys, labels, others) in zip(axes, specs):
        # Mnemon (the final version, once graded), its read-time core, then the re-evaluated systems.
        fin = (R.get('final', {}).get('standard', {}).get(d) or {})
        ours = []
        if fin.get('paired'):
            f = fin['final']
            ours.append(('Mnemon', [f['by_type']['mini'][k] for k in keys] + [f['accuracy']['mini']]))
        ours.append(('w/o consolidation', [std[d]['runs'][MAIN[0]]['mini']['per_type'][k] for k in keys] + [std[d]['runs'][MAIN[0]]['mini']['accuracy']]))
        names = [n for n, _ in ours] + [k for k in others if not k.startswith('_')]
        values = [v for _, v in ours] + [others[k] for k in names[len(ours):]]
        ax.imshow(values, cmap=cmap, vmin=40, vmax=100, aspect='auto')
        for i, row in enumerate(values):
            for j, v in enumerate(row):
                ax.text(j, i, f'{v:.1f}', ha='center', va='center', fontsize=6.6, color='white' if v >= 78 else INK)
        ax.set_xticks(range(len(keys) + 1)); ax.set_xticklabels(labels + ['overall'], fontsize=6.8)
        ax.set_yticks(range(len(names))); ax.set_yticklabels(names, fontsize=7)
        ax.tick_params(length=0); ax.grid(False)
        for s in ax.spines.values(): s.set_visible(False)
        ax.axhline(len(ours) - 0.5, color='white', lw=2.5)
        ax.set_title(title, loc='left')
    fig.subplots_adjust(wspace=0.35)
    save(fig, 'categories')

# Figure: where the time and the money go, full and fast modes (standard setting).
def breakdown():
    std = R['gpt41mini_chain']
    bars = [('LoCoMo', 'locomo', MAIN[0], 'Mnemon'), ('LoCoMo', 'locomo', MAIN[1], 'fast'),
            ('LongMemEval-S', 'lme', MAIN[0], 'Mnemon'), ('LongMemEval-S', 'lme', MAIN[1], 'fast')]
    fig, axes = plt.subplots(1, 2, figsize=(W, 2.1))
    ax = axes[0]
    for i, (_, d, r, _) in enumerate(bars):
        sp = std[d]['latency_split'][r]
        ax.barh(i, sp['view_p50_s'], color=BLUE, height=0.55, edgecolor='white', linewidth=1)
        ax.barh(i, sp['answer_p50_s'], left=sp['view_p50_s'], color=ORANGE, height=0.55, edgecolor='white', linewidth=1)
        whole = std[d]['runs'][r]['mini']['latency_p50_s']
        ax.annotate(f"{whole:.1f} s", (sp['view_p50_s'] + sp['answer_p50_s'], i), xytext=(3, 0), textcoords='offset points', va='center', fontsize=6.5, color=INK2)
    ax.set_yticks(range(len(bars))); ax.set_yticklabels([f'{b}, {n}' for b, _, _, n in bars], fontsize=7); ax.invert_yaxis()
    ax.set_xlabel('median seconds per question'); ax.set_title('(a) latency', loc='left'); ax.grid(axis='y', visible=False)
    ax.set_xlim(0, max(std[d]['latency_split'][r]['view_p50_s'] + std[d]['latency_split'][r]['answer_p50_s'] for _, d, r, _ in bars) * 1.25)
    ax.legend(handles=[Line2D([], [], color=BLUE, lw=5, label='building the View'), Line2D([], [], color=ORANGE, lw=5, label='answering')],
              loc='lower right', fontsize=6.5, handlelength=0.9)
    ax = axes[1]
    for i, (_, d, r, _) in enumerate(bars):
        c = std[d]['runs'][r]['mini']['cost_per_question']; left = 0
        for key, color in (('jev', BLUE), ('planner', AQUA), ('answer', ORANGE)):
            ax.barh(i, 1e3 * c[key], left=left, color=color, height=0.55, edgecolor='white', linewidth=1); left += 1e3 * c[key]
        ax.annotate(f"{1e3 * c['total']:.2f}", (left, i), xytext=(3, 0), textcoords='offset points', va='center', fontsize=6.5, color=INK2)
    ax.set_yticks(range(len(bars))); ax.set_yticklabels([]); ax.invert_yaxis()
    ax.set_xlabel('cost per question (thousandths of a dollar)'); ax.set_title('(b) cost', loc='left'); ax.grid(axis='y', visible=False)
    ax.set_xlim(0, max(1e3 * std[d]['runs'][r]['mini']['cost_per_question']['total'] for _, d, r, _ in bars) * 1.4)
    ax.legend(handles=[Line2D([], [], color=BLUE, lw=5, label='Jev'), Line2D([], [], color=AQUA, lw=5, label='planner'), Line2D([], [], color=ORANGE, lw=5, label='answer')],
              loc='lower right', fontsize=6.5, handlelength=0.9)
    fig.subplots_adjust(wspace=0.08)
    save(fig, 'breakdown')

# Figure: HaluMem answered in different ways on the same Views: official judge (correct / hallucinated / omitted) and
# lenient judge (correct), per reader and answer prompt.
def halumem_variants():
    V = R.get('halumem_variants', {})
    judges = [(j, t) for j, t in (('mini', 'gpt-4.1-mini judge (primary)'), ('deepseek', 'DeepSeek judge')) if j in V]
    if not judges: return
    order = [('gpt-4.1-mini', 'ours'), ('gpt-4.1-mini', 'HaluMem'), ('gpt-4.1-mini', 'combined'), ('DeepSeek', 'ours'), ('DeepSeek', 'HaluMem'), ('DeepSeek', 'combined')]
    names = {'ours': 'our prompt', 'HaluMem': "HaluMem's short prompt", 'combined': 'combined prompt'}
    rows = [(r, p) for r, p in order if all(f'{r} / {p}' in V[j]['sets'] for j, _ in judges)]
    lenient = V.get('lenient', {}).get('sets', {})
    fig, axes = plt.subplots(1, len(judges), figsize=(W, 0.36 * len(rows) + 1.3), sharey=True)
    axes = axes if len(judges) > 1 else [axes]
    for ax, (judge, title) in zip(axes, judges):
        for i, (r, p) in enumerate(rows):
            s = V[judge]['sets'][f'{r} / {p}']; left = 0
            for key, color in (('Correct', BLUE), ('Hallucination', ORANGE), ('Omission', GRAY)):
                ax.barh(i, s[key], left=left, height=0.62, color=color, edgecolor='white', linewidth=1)
                if s[key] >= 7: ax.annotate(f'{s[key]:.1f}', (left + s[key] / 2, i), ha='center', va='center', fontsize=6.3, color='white')
                left += s[key]
            # The lenient judge is DeepSeek: its ticks go on DeepSeek's panel.
            if judge == 'deepseek' and f'{r} / {p}' in lenient:
                x = lenient[f'{r} / {p}']['Correct']
                ax.plot([x, x], [i - 0.36, i + 0.36], color=INK, lw=1.3)
        ax.set_xlim(0, 100); ax.set_xlabel('share of answers (%)'); ax.grid(axis='y', visible=False); ax.set_title(title, loc='left', fontsize=8)
    axes[0].set_yticks(range(len(rows))); axes[0].set_yticklabels([f'{r}, {names[p]}' for r, p in rows], fontsize=7); axes[0].invert_yaxis()
    handles = [Line2D([], [], color=BLUE, lw=5, label='correct'), Line2D([], [], color=ORANGE, lw=5, label='hallucinated'),
               Line2D([], [], color=GRAY, lw=5, label='omitted')] + ([Line2D([], [], color=INK, lw=1.3, label='correct under a lenient judge')] if lenient else [])
    fig.legend(handles=handles, loc='lower center', bbox_to_anchor=(0.55, 0.0), ncol=4, fontsize=6.8, handlelength=1.1)
    fig.subplots_adjust(bottom=0.24, wspace=0.12)
    save(fig, 'halumem_variants')

if __name__ == '__main__':
    for figure in (tradeoff, ladder, system1, reader, scaling, forest, categories, breakdown, halumem_variants):
        if not ONLY or figure.__name__ in ONLY: figure()
