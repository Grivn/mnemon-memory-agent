"""Collect the paper's numbers from the run records into data/results.json.

Every table and figure in the paper that reports our own runs is computed here, from the rows, grades, contexts and
traces the bench harness writes. Runs live outside the repository; point MNEMON_RUNS at them (default: ../runs next to
the repository). Prices are list prices per million tokens.

    python3 docs/paper/scripts/collect.py
"""
import collections, glob, json, math, os, re, statistics
from pathlib import Path

HERE = Path(__file__).resolve()
RUNS = Path(os.environ.get('MNEMON_RUNS', HERE.parents[4] / 'runs'))
P3 = RUNS / 'phase03-20260925'
OUT = HERE.parents[1] / 'data' / 'results.json'
ARM = 'replica-cuefill:raw-records'

MINI = {'miss': 0.40, 'hit': 0.10, 'output': 1.60}          # gpt-4.1-mini, $ per million tokens
DEEPSEEK = {'miss': 0.15, 'hit': 0.003, 'output': 0.60}     # DeepSeek off-peak
JEV = 0.042                                                 # JEV input; output is free

squash = lambda t: re.sub(r'\s+', ' ', t).strip()
def load(path): return [json.loads(l) for l in open(path) if l.strip()] if os.path.exists(path) else []
def mcnemar(b, c):
    n = b + c
    return 1.0 if n == 0 else min(1.0, 2 * sum(math.comb(n, i) for i in range(min(b, c) + 1)) / 2 ** n)
def priced(usage, price): return sum(usage.get(k, 0) * price[k] for k in price) / 1e6

lme = {i['question_id']: i for i in json.load(open(RUNS / 'benchmarks/longmemeval_s_cleaned.json'))}
locomo = {s['sample_id']: s for s in json.load(open(RUNS / 'benchmarks/locomo10.json'))}
turn_text = {(sid, t['dia_id']): t['text'] for sid, s in locomo.items() for k, v in s['conversation'].items()
             if k.startswith('session_') and isinstance(v, list) for t in v}

def evidence_heads(ds, qid):
    """The first 60 characters of every gold evidence turn (LME: has_answer turns; LoCoMo: evidence dia_ids)."""
    if ds == 'lme':
        return [squash(t['content'])[:60] for s in lme[qid]['haystack_sessions'] for t in s if t.get('has_answer')]
    sid, idx = qid.rsplit('-q', 1)
    qa = [x for x in locomo[sid]['qa'] if x.get('category') != 5][int(idx)]
    return [squash(turn_text.get((sid, e.strip()), ''))[:60] for e in qa.get('evidence', []) for e in e.split(';')
            if e.strip() and turn_text.get((sid, e.strip()))]

TYPES = {
    'locomo': {'single-hop': {'single-hop'}, 'multi-hop': {'multi-hop'}, 'temporal': {'temporal'}, 'open-domain': {'open-domain'}},
    'lme': {'single-session-user': {'single-session-user'}, 'single-session-assistant': {'single-session-assistant'},
            'single-session-preference': {'single-session-preference'}, 'temporal-reasoning': {'temporal-reasoning'},
            'multi-session': {'multi-session'}, 'knowledge-update': {'knowledge-update'}},
}

def run(path, ds, reader):
    """One run directory: rows, the two judges' grades (and the revised LoCoMo labels), Views, loop traces."""
    d = Path(path)
    rows = {r['id']: r for r in load(d / 'rows.jsonl') if r['arm'] == ARM}
    grades = {judge: {g['id']: bool(g['correct']) for g in load(d / name) if g['arm'] == ARM}
              for judge, name in (('mini', 'grades-gpt-4.1-mini.jsonl'), ('deepseek', 'grades.jsonl'),
                                  ('mini-refined', 'grades-gpt-4.1-mini-refined.jsonl'), ('deepseek-refined', 'grades-refined.jsonl'))}
    views = {c['id']: squash('\n'.join(c.get('view', []))) for c in load(d / 'contexts.jsonl') if c['arm'] == ARM}
    return dict(ds=ds, reader=reader, rows=rows, grades=grades, views=views, dir=d)

REFINED = json.load(open(RUNS / 'bench-full-20260924/locomo-refine/locomo-refined.json'))
DROP, FIX = set(REFINED['drop']), set(REFINED['fix'])
def revised(r, ids, judge, no_open_domain=False):
    """LoCoMo under the revised labels: 44 questions dropped, 25 fixed gold answers regraded (the `-refined` grade files
    hold only those), every other question as graded."""
    g, fixed = r['grades'][judge], r['grades'][judge + '-refined']
    kept = [i for i in ids if i not in DROP and not (no_open_domain and r['rows'][i]['type'] == 'open-domain')]
    return round(100 * sum((fixed.get(i, g[i]) if i in FIX else g[i]) for i in kept) / len(kept), 1), len(kept)

def evidence_shown(r, qid):
    heads = [h for h in evidence_heads(r['ds'], qid) if h]
    if not heads or qid.endswith('_abs'): return None
    return sum(h in r['views'].get(qid, '') for h in heads) / len(heads)

def describe(r, ids, judge):
    """Accuracy overall and per type on `ids`, plus process measures and cost per question."""
    g, rows = r['grades'][judge], r['rows']
    acc = lambda sel: round(100 * sum(g[i] for i in sel) / len(sel), 1) if sel else None
    per_type = {t: acc([i for i in ids if rows[i]['type'] in ts]) for t, ts in TYPES[r['ds']].items()}
    rs = [rows[i] for i in ids]
    reader = MINI if r['reader'] == 'gpt-4.1-mini' else DEEPSEEK
    answer = [sum(priced(u, reader) for u in x.get('main', [])) for x in rs]
    planner = [sum(priced(u, reader) for u in x.get('replica', {}).get('recall', [])) for x in rs]
    jev = [x.get('replica', {}).get('jev', 0) * JEV / 1e6 for x in rs]
    shown = [s for s in (evidence_shown(r, i) for i in ids) if s is not None]
    return dict(
        n=len(ids), correct=sum(g[i] for i in ids), accuracy=acc(ids), per_type=per_type,
        per_type_n={t: sum(rows[i]['type'] in ts for i in ids) for t, ts in TYPES[r['ds']].items()},
        evidence_all_shown=round(100 * sum(s == 1 for s in shown) / len(shown), 1),
        evidence_turns_shown=round(100 * statistics.mean(shown), 1),
        view_items=round(statistics.mean(x.get('replica', {}).get('items', 0) for x in rs), 1),
        answer_input_tokens=round(statistics.mean(sum(u.get('miss', 0) + u.get('hit', 0) for u in x.get('main', [])) for x in rs)),
        jev_tokens=round(statistics.mean(x.get('replica', {}).get('jev', 0) for x in rs)),
        jev_calls=round(statistics.mean(x.get('replica', {}).get('calls', 0) for x in rs), 2),
        latency_p50_s=round(statistics.median(x['elapsedMs'] for x in rs) / 1000, 1),
        latency_p90_s=round(statistics.quantiles([x['elapsedMs'] for x in rs], n=10)[-1] / 1000, 1),
        cost_per_question=dict(answer=round(statistics.mean(answer), 6), planner=round(statistics.mean(planner), 6),
                               jev=round(statistics.mean(jev), 6), total=round(statistics.mean(a + p + j for a, p, j in zip(answer, planner, jev)), 6)))

def paired(a, b, ids, judge):
    """b against a on the same questions: net points, flips, the exact McNemar p and the 95% interval of the paired
    difference, overall and per type."""
    ga, gb = a['grades'][judge], b['grades'][judge]
    def one(sel):
        up, down = sum(gb[i] and not ga[i] for i in sel), sum(ga[i] and not gb[i] for i in sel)
        n = len(sel); half = 1.96 * math.sqrt(max(0.0, up + down - (up - down) ** 2 / n)) / n
        return dict(n=n, diff=round(100 * (up - down) / n, 1), up=up, down=down, p=round(mcnemar(up, down), 4),
                    ci95=[round(100 * ((up - down) / n - half), 2), round(100 * ((up - down) / n + half), 2)])
    out = {'all': one(ids)}
    for t, ts in TYPES[a['ds']].items():
        sel = [i for i in ids if a['rows'][i]['type'] in ts]
        if sel: out[t] = one(sel)
    return out

def chain(named, ds, judges):
    """Several runs of one benchmark, compared on the questions every run answered and every listed judge graded."""
    common = set.intersection(*[set(r['rows']) & set.intersection(*[set(r['grades'][j]) for j in judges]) for r in named.values()])
    ids = sorted(common)
    return ids, {name: {judge: describe(r, ids, judge) for judge in judges} for name, r in named.items()}

results = {'prices_per_million': {'gpt-4.1-mini': MINI, 'deepseek_offpeak': DEEPSEEK, 'jev_input': JEV}}

# 1. gpt-4.1-mini answering and planning (preregistration amendment 9): S0 -> S4h -> S6, and fast mode.
mini = {}
for ds, sub in (('locomo', 'locomo'), ('lme', 'lme')):
    named = {'S0': run(P3 / 'full' / sub, ds, 'gpt-4.1-mini'), 'S4h': run(P3 / 'steps/s4h' / sub, ds, 'gpt-4.1-mini'),
             'S6': run(P3 / 'steps/s6' / sub, ds, 'gpt-4.1-mini'), 'fast': run(P3 / 'steps/fast' / sub, ds, 'gpt-4.1-mini')}
    # Amendment 15: the adopted simple mode and its fast variant, once both are answered and graded by both judges.
    extra = {'simple': run(P3 / 'steps/mini-simple' / sub, ds, 'gpt-4.1-mini'), 'simple-fast': run(P3 / 'steps/mini-simple-fast' / sub, ds, 'gpt-4.1-mini'),
             # The final version, consolidation on: amendment 30 (LoCoMo) and amendment 34 (all of LongMemEval-S).
             'final': run(P3 / ('steps/mini-simple-consolidated/locomo' if ds == 'locomo' else 'steps/mini-simple-consolidated-full/lme'), ds, 'gpt-4.1-mini')}
    complete = {'locomo': 1540, 'lme': 500}[ds]
    for name, r in extra.items():
        if all(len(set(r['rows']) & set(r['grades'][j])) >= complete - 5 for j in ('mini', 'deepseek')): named[name] = r
    ids, table = chain(named, ds, ['mini', 'deepseek'])
    comparisons = [('S0', 'S4h'), ('S4h', 'S6'), ('S0', 'S6'), ('S6', 'fast')] + ([('S6', 'simple'), ('S0', 'simple')] if 'simple' in named else []) + \
                  ([('simple', 'final'), ('S0', 'final')] if 'simple' in named and 'final' in named else []) + \
                  ([('simple', 'simple-fast'), ('fast', 'simple-fast')] if 'simple' in named and 'simple-fast' in named else [])
    pairs = {f'{b} vs {a}': paired(named[a], named[b], ids, 'mini') for a, b in comparisons}
    entry = dict(questions=len(ids), runs=table, paired_mini_judge=pairs)
    if ds == 'locomo':
        no_od = [i for i in ids if named['S0']['rows'][i]['type'] != 'open-domain']
        entry['label_variants'] = {name: {judge: dict(
            original=describe(r, ids, judge)['accuracy'], revised=revised(r, ids, judge)[0],
            original_no_open_domain=round(100 * sum(r['grades'][judge][i] for i in no_od) / len(no_od), 1),
            revised_no_open_domain=revised(r, ids, judge, True)[0]) for judge in ('mini', 'deepseek')} for name, r in named.items()}
        entry['revised_questions'] = revised(named['S0'], ids, 'mini')[1]
    # Latency split per question: building the View (the replica's job, planner included) and the rest (answering).
    entry['latency_split'] = {name: dict(view_p50_s=round(statistics.median(r['rows'][i].get('replica', {}).get('ms', 0) for i in ids) / 1000, 2),
                                         answer_p50_s=round(statistics.median(max(0, r['rows'][i]['elapsedMs'] - r['rows'][i].get('replica', {}).get('ms', 0)) for i in ids) / 1000, 2))
                              for name, r in named.items()}
    mini[ds] = entry
results['gpt41mini_chain'] = mini

# 2. DeepSeek (thinking) answering, planning and judging: S0 -> S4h -> S5h -> S6, and the simple-mode comparison
#    (S6 and simple run side by side, amendments 10-11).
ds_chain = {}
for ds, sub in (('locomo', 'locomo'), ('lme', 'lme')):
    named = {'S0': run(P3 / 'steps/s0-ds' / sub, ds, 'deepseek'), 'S4h': run(P3 / 'steps/s4h-ds' / sub, ds, 'deepseek'),
             'S5h': run(P3 / 'steps/s5h-ds' / sub, ds, 'deepseek'), 'S6': run(P3 / 'steps/s6-ds' / sub, ds, 'deepseek'),
             'S6 (rerun)': run(P3 / 'steps/simple-cmp/s6' / sub, ds, 'deepseek'), 'simple': run(P3 / 'steps/simple-cmp/simple' / sub, ds, 'deepseek')}
    # The final version with the reasoning reader (amendment 31), once graded.
    final_ds = run(P3 / 'steps/simple-consolidated-ds' / sub, ds, 'deepseek')
    if len(final_ds['grades']['deepseek']) >= {'locomo': 1535, 'lme': 495}[ds]: named['final'] = final_ds
    ids, table = chain(named, ds, ['deepseek'])
    pairs = {f'{b} vs {a}': paired(named[a], named[b], ids, 'deepseek') for a, b in
             (('S0', 'S4h'), ('S4h', 'S5h'), ('S5h', 'S6'), ('S0', 'S5h'), ('S6 (rerun)', 'simple'), ('S6', 'S6 (rerun)'), ('S0', 'simple'))
             + ((('simple', 'final'), ('S0', 'final')) if 'final' in named else ())}
    entry = dict(questions=len(ids), runs=table, paired_deepseek_judge=pairs)
    if ds == 'locomo':
        no_od = [i for i in ids if named['S0']['rows'][i]['type'] != 'open-domain']
        entry['label_variants'] = {name: dict(
            original=describe(r, ids, 'deepseek')['accuracy'], revised=revised(r, ids, 'deepseek')[0],
            original_no_open_domain=round(100 * sum(r['grades']['deepseek'][i] for i in no_od) / len(no_od), 1),
            revised_no_open_domain=revised(r, ids, 'deepseek', True)[0]) for name, r in named.items() if r['grades']['deepseek-refined'] or not FIX & set(ids)}
        entry['revised_questions'] = revised(named['S0'], ids, 'deepseek')[1]
    ds_chain[ds] = entry
results['deepseek_chain'] = ds_chain

# 3. Simple mode vs S6, run side by side, on the questions both answered (as registered in amendment 10): pooled
#    non-inferiority with a -2 point margin on the 95% interval of the paired difference, per-benchmark tests, cost and latency.
b = c = n = 0
side = {}
for ds, sub in (('locomo', 'locomo'), ('lme', 'lme')):
    pair = {'S6': run(P3 / 'steps/simple-cmp/s6' / sub, ds, 'deepseek'), 'simple': run(P3 / 'steps/simple-cmp/simple' / sub, ds, 'deepseek')}
    ids, table = chain(pair, ds, ['deepseek'])
    test = paired(pair['S6'], pair['simple'], ids, 'deepseek')
    side[ds] = dict(questions=len(ids), runs=table, paired=test)
    b += test['all']['up']; c += test['all']['down']; n += len(ids)
half = 1.96 * math.sqrt(b + c - (b - c) ** 2 / n) / n
results['simple_vs_s6'] = side
results['simple_noninferiority'] = dict(n=n, up=b, down=c, diff=round(100 * (b - c) / n, 2),
                                        ci95=[round(100 * ((b - c) / n - half), 2), round(100 * ((b - c) / n + half), 2)], margin=-2.0)

# 4. System 1 comparison (amendment 12B): per-item scores of JEV and two LLM judges on the same items; ROC points.
sys1 = P3 / 'sys1'
if (sys1 / 'summary.json').exists():
    results['system1_summary'] = json.load(open(sys1 / 'summary.json'))
    requests = {(r['dataset'], r['id']): r for r in load(sys1 / 'requests.jsonl')}
    def roc(scores, labels):
        pairs = sorted(zip(scores, labels), key=lambda x: -x[0]); P = sum(labels); N = len(labels) - P
        tp = fp = 0; pts = [(0.0, 0.0)]; last = None
        for s, y in pairs:
            if last is not None and s != last: pts.append((fp / N, tp / P))
            tp += y; fp += 1 - y; last = s
        pts.append((fp / N, tp / P))
        step = max(1, len(pts) // 400)
        return [[round(x, 4), round(y, 4)] for x, y in pts[::step]] + [[1.0, 1.0]]
    # Per call: price from the usage each call returned, and wall-clock latency.
    calls = {}
    for name, file, price in (('JEV', 'scores-jev.jsonl', None), ('DeepSeek', 'scores-deepseek.jsonl', DEEPSEEK), ('gpt-4.1-mini', 'scores-gpt-4.1-mini.jsonl', MINI)):
        rows = [r for r in load(sys1 / file) if r.get('scores')]
        cost = [(r['usage'].get('input_tokens', 0) * JEV / 1e6) if price is None else priced(r['usage'], price) for r in rows]
        ms = sorted(r['ms'] for r in rows)
        calls[name] = dict(calls=len(rows), items=sum(len(r['scores']) for r in rows), cost_per_call=round(statistics.mean(cost), 7),
                           latency_p50_s=round(statistics.median(ms) / 1000, 3), latency_p90_s=round(statistics.quantiles(ms, n=10)[-1] / 1000, 3),
                           input_tokens=round(statistics.mean(r['usage'].get('input_tokens', r['usage'].get('miss', 0) + r['usage'].get('hit', 0)) for r in rows)))
    common = set.intersection(*[{(r['dataset'], r['id']) for r in load(sys1 / f) if r.get('scores')} for f in ('scores-jev.jsonl', 'scores-deepseek.jsonl', 'scores-gpt-4.1-mini.jsonl')])
    results['system1_calls'] = dict(per_judge=calls, questions=len(common), items=sum(len(requests[k]['items']) for k in common),
                                    gold=sum(bool(i['gold']) for k in common for i in requests[k]['items']))
    curves = {}
    for name, file in (('JEV', 'scores-jev.jsonl'), ('DeepSeek', 'scores-deepseek.jsonl'), ('gpt-4.1-mini', 'scores-gpt-4.1-mini.jsonl')):
        rows = load(sys1 / file)
        if not rows or not requests: continue
        scores, labels = [], []
        for row in rows:
            req = requests.get((row['dataset'], row['id']))
            if not req or not row.get('scores'): continue
            for s, item in zip(row['scores'], req['items']):
                scores.append(float(s) if s is not None and s == s else 0.0); labels.append(int(bool(item['gold'])))
        curves[name] = roc(scores, labels)
    results['system1_roc'] = curves

# 5. Held-out benchmarks (amendments 12-14), graded with each benchmark's own judge prompt by gpt-4.1-mini and DeepSeek.
HELD = P3 / 'heldout'
def heldout_summary(run, rows_file='rows.jsonl', arm=ARM, ext='.jsonl'):
    rows = {r['id']: r for r in load(run / rows_file) if r.get('arm') == arm}
    if not rows: return None
    out = dict(answered=len(rows))
    for judge, name in (('mini', 'grades-heldout-gpt-4.1-mini'), ('deepseek', 'grades-heldout')):
        grades = {g['id']: g for g in load(run / f'{name}{ext}') if g.get('arm') == arm and g['id'] in rows}
        if not grades: continue
        types = sorted({rows[i]['type'] for i in grades})
        if 'score' in next(iter(grades.values())):          # BEAM: mean nugget score
            mean = lambda sel: round(100 * statistics.mean(grades[i]['score'] for i in sel), 1)
            out[judge] = dict(n=len(grades), score=mean(list(grades)), per_type={t: mean([i for i in grades if rows[i]['type'] == t]) for t in types})
        else:                                               # HaluMem: correct / hallucination / omission
            share = lambda sel: {k: round(100 * sum(grades[i]['label'] == k for i in sel) / len(sel), 1) for k in ('Correct', 'Hallucination', 'Omission')}
            out[judge] = dict(n=len(grades), **share(list(grades)), per_type={t: share([i for i in grades if rows[i]['type'] == t]) for t in types})
    rs = list(rows.values())
    if 'main' in rs[0]:
        out['cost_per_question'] = round(statistics.mean(sum(priced(u, MINI) for u in r['main']) + sum(priced(u, MINI) for u in r.get('replica', {}).get('recall', []))
                                                         + r.get('replica', {}).get('jev', 0) * JEV / 1e6 for r in rs), 6)
        out['latency_p50_s'] = round(statistics.median(r['elapsedMs'] for r in rs) / 1000, 1)
        out['view_items'] = round(statistics.mean(r.get('replica', {}).get('items', 0) for r in rs), 1)
        out['empty_view'] = sum(not r.get('replica', {}).get('items') for r in rs)
    return out
held = {}
for name in ('halumem', 'beam128k', 'beam128k-bm25', 'beam10m', 'beam10m-bm25'):
    if (HELD / name / 'rows.jsonl').exists(): held[name] = heldout_summary(HELD / name)
if (HELD / 'halumem' / 'rows.jsonl.before-retry').exists():
    held['halumem-before-retry'] = heldout_summary(HELD / 'halumem', 'rows.jsonl.before-retry', ext='.jsonl.before-retry')
short = HELD / 'halumem-short'
if (short / 'rows.jsonl').exists():
    held['halumem-short-official'] = heldout_summary(short, arm='official-prompt')
    held['halumem-short-original-subset'] = heldout_summary(short, arm='original-prompt')
results['heldout'] = held

# HaluMem answered in other ways on the same recorded Views (amendments 14, 16-19): reader x answer prompt, graded by the
# official judge (both judges) and by a lenient judge, on the questions every set has; the late-View question excluded.
VARIANTS = [('gpt-4.1-mini', 'ours', 'halumem-short-registered', ARM), ('gpt-4.1-mini', 'HaluMem', 'halumem-short', 'official-prompt'),
            ('gpt-4.1-mini', 'combined', 'halumem-combined-mini', 'mini-combined'), ('DeepSeek', 'ours', 'halumem-reader-ds', 'deepseek-reader'),
            ('DeepSeek', 'HaluMem', 'halumem-reader-ds-short', 'deepseek-reader-short'), ('DeepSeek', 'combined', 'halumem-combined-ds', 'deepseek-combined')]
excluded_ids = set(json.load(open(HELD / 'replay-excluded.json'))) if (HELD / 'replay-excluded.json').exists() else set()
def labels(d, arm, name):
    return {g['id']: g['label'] if 'label' in g else ('Correct' if g['correct'] else 'Wrong') for g in load(HELD / d / name) if g.get('arm') == arm and g['id'] not in excluded_ids}
variants = {}
types_of = {r['id']: r['type'] for r in load(HELD / 'halumem-short-registered' / 'rows.jsonl')}
for judge, name in (('deepseek', 'grades-heldout.jsonl'), ('mini', 'grades-heldout-gpt-4.1-mini.jsonl'), ('lenient', 'grades-lenient.jsonl')):
    sets = {(reader, prompt): labels(d, arm, name) for reader, prompt, d, arm in VARIANTS}
    sets = {k: v for k, v in sets.items() if len(v) >= 900}
    if len(sets) < 2: continue
    ids = set.intersection(*[set(v) for v in sets.values()])
    if judge == 'lenient' and 'deepseek' in variants: ids &= variants['deepseek']['_ids']   # the lenient judge on the official set's questions
    kinds = sorted({types_of[i] for i in ids if i in types_of})
    def summary(v):
        out = {k: round(100 * sum(v[i] == k for i in ids) / len(ids), 1) for k in ('Correct', 'Hallucination', 'Omission', 'Wrong')}
        out['per_type'] = {t: round(100 * sum(v[i] == 'Correct' for i in ids if types_of.get(i) == t) / max(1, sum(types_of.get(i) == t for i in ids)), 1) for t in kinds}
        return out
    variants[judge] = dict(questions=len(ids), sets={f'{r} / {p}': summary(v) for (r, p), v in sets.items()}, _ids=ids)
    # paired tests against the registered answers
    base = sets.get(('gpt-4.1-mini', 'ours'))
    if base:
        for (r, p), v in sets.items():
            if (r, p) == ('gpt-4.1-mini', 'ours'): continue
            up = sum(v[i] == 'Correct' and base[i] != 'Correct' for i in ids); down = sum(base[i] == 'Correct' and v[i] != 'Correct' for i in ids)
            variants[judge]['sets'][f'{r} / {p}']['vs_registered'] = dict(up=up, down=down, diff=round(100 * (up - down) / len(ids), 1), p=round(mcnemar(up, down), 6))
for v in variants.values(): v.pop('_ids', None)
results['halumem_variants'] = variants

# Why the registered HaluMem answers were not judged correct (one main cause each; amendment 13 audit, primary judge).
causes_file = next((f for f in (HELD / 'halumem' / 'causes-gpt-4.1-mini.jsonl', HELD / 'halumem-short-registered' / 'causes-gpt-4.1-mini.jsonl') if f.exists()), None)
if causes_file:
    causes = load(causes_file)
    graded = load(causes_file.parent / 'grades-heldout-gpt-4.1-mini.jsonl')
    results['halumem_causes'] = dict(source=causes_file.parent.name, answers=len(graded), wrong=len(causes),
                                     counts=dict(collections.Counter(c['cause'] for c in causes)),
                                     info_in_view=dict(collections.Counter(c.get('info_in_view', '') for c in causes)))

# 6. The final version: the core above with consolidation on (amendments 29-34), paired on each benchmark with the same
#    configuration without it, in both settings; its write cost from the consolidation states it left.
def state_files(run_dir):
    """Each memory's newest consolidation state (a HaluMem user carries one state through its cases; a shared BEAM-10M
    workspace keeps the state its offline pass wrote in the copy archived when the first run started)."""
    out = []
    for root in sorted(glob.glob(str(run_dir / 'replica-cuefill-raw-records' / '*'))):
        if '.attempt-' in root or not os.path.isdir(root): continue
        archived = sorted(glob.glob(root + '/cases/runs/*/replica/natural/consolidation-*.json'))
        files = archived[:1] or sorted(glob.glob(root + '/**/consolidation-*.json', recursive=True), key=os.path.getmtime, reverse=True)[:1]
        if files: out.append(json.load(open(files[0])))
    return out
def write_cost(run_dir, questions):
    states = state_files(run_dir)
    if not states: return None
    cost = [priced(s['usage'], DEEPSEEK) for s in states]
    mem = [s['memory'] for s in states]
    return dict(memories=len(states), batches=sum(s['batches'] for s in states), failed=sum(s['failed'] for s in states),
                pending=sum(len(s['pending']) for s in states), total=round(sum(cost), 4), per_memory=round(statistics.mean(cost), 5),
                per_question=round(sum(cost) / questions, 6) if questions else None,
                topics=sum(len(m['threads']) for m in mem), events=sum(len(m['events']) for m in mem),
                values=sum(len(m['facts']) for m in mem), instructions=sum(len(m['directives']) for m in mem))
def per_question_cost(rows, reader):
    price = MINI if reader == 'gpt-4.1-mini' else DEEPSEEK
    return statistics.mean(sum(priced(u, price) for u in r.get('main', [])) + sum(priced(u, price) for u in r.get('replica', {}).get('recall', []))
                           + r.get('replica', {}).get('jev', 0) * JEV / 1e6 for r in rows)
def process(rows):
    return dict(latency_p50_s=round(statistics.median(r['elapsedMs'] for r in rows) / 1000, 1),
                answer_input_tokens=round(statistics.mean(sum(u.get('miss', 0) + u.get('hit', 0) for u in r.get('main', [])) for r in rows)),
                jev_tokens=round(statistics.mean(r.get('replica', {}).get('jev', 0) for r in rows)),
                view_items=round(statistics.mean(r.get('replica', {}).get('items', 0) for r in rows), 1),
                empty_views=sum(not r.get('replica', {}).get('items') for r in rows))
def mean_diff(d):
    """Mean of paired differences with its 95% interval (normal approximation), in points."""
    m = statistics.mean(d); h = 1.96 * statistics.stdev(d) / math.sqrt(len(d))
    return dict(n=len(d), diff=round(100 * m, 1), ci95=[round(100 * (m - h), 1), round(100 * (m + h), 1)],
                up=sum(x > 0 for x in d), down=sum(x < 0 for x in d))
def graded(run_dir, kind):
    """Per-question score under each judge: 1/0 for LoCoMo and LME, 1/0 for HaluMem (Correct), the rubric mean for BEAM."""
    out = {}
    names = {'qa': (('mini', 'grades-gpt-4.1-mini.jsonl'), ('deepseek', 'grades.jsonl')),
             'heldout': (('mini', 'grades-heldout-gpt-4.1-mini.jsonl'), ('deepseek', 'grades-heldout.jsonl'))}[kind]
    for judge, name in names:
        g = {}
        for x in load(run_dir / name):
            if x.get('arm', ARM) != ARM: continue
            g[x['id']] = float(x['correct']) if 'correct' in x else float(x['score']) if 'score' in x else float(x.get('label') == 'Correct')
        if g: out[judge] = g
    return out
def side(run_dir, kind, reader, ids=None):
    rows = {r['id']: r for r in load(run_dir / 'rows.jsonl') if r.get('arm') == ARM}
    if not rows: return None
    g = graded(run_dir, kind)
    keep = sorted(set(rows) if ids is None else set(ids) & set(rows))
    acc = {j: round(100 * statistics.mean(v[i] for i in keep if i in v), 1) for j, v in g.items() if any(i in v for i in keep)}
    types = sorted({rows[i].get('type') for i in keep if rows[i].get('type')})
    by_type = {j: {t: round(100 * statistics.mean(v[i] for i in keep if i in v and rows[i].get('type') == t), 1) for t in types
                   if any(i in v and rows[i].get('type') == t for i in keep)} for j, v in g.items()}
    return dict(dir=str(run_dir.relative_to(P3)), answered=len(rows), n=len(keep), accuracy=acc, by_type=by_type,
                cost_per_question=round(per_question_cost([rows[i] for i in keep], reader), 6), **process([rows[i] for i in keep])), g, rows
def compare(core_dir, final_dir, kind, reader, questions=None, subset=None, final_reader=None):
    """The final version against the core on the questions both answered and each judge graded; `final_reader` when the
    two sides are read by different models (prices follow the reader)."""
    final_reader = final_reader or reader
    a, b = side(core_dir, kind, reader), side(final_dir, kind, final_reader)
    if not a or not b: return dict(core=a and a[0], final=b and b[0])
    # Questions both sides answered and every judge that graded both sides graded on both.
    judges = [j for j in ('mini', 'deepseek') if j in a[1] and j in b[1]]
    ids = set(a[2]) & set(b[2]) & set.intersection(*[set(a[1][j]) & set(b[1][j]) for j in judges]) if judges else set()
    ids = sorted(ids if subset is None else ids & set(subset))
    if not ids: return dict(core=a[0], final=b[0])
    core, final = side(core_dir, kind, reader, ids)[0], side(final_dir, kind, final_reader, ids)[0]
    paired_by_judge, paired_by_type = {}, {}
    for judge in ('mini', 'deepseek'):
        ga, gb = a[1].get(judge, {}), b[1].get(judge, {})
        both = [i for i in ids if i in ga and i in gb]
        if len(both) < 2: continue
        paired_by_judge[judge] = mean_diff([gb[i] - ga[i] for i in both])
        types = sorted({a[2][i].get('type') for i in both if a[2][i].get('type')})
        paired_by_type[judge] = {t: mean_diff(sel) for t in types if len(sel := [gb[i] - ga[i] for i in both if a[2][i].get('type') == t]) > 1}
    out = dict(core=core, final=final, paired=paired_by_judge, paired_by_type=paired_by_type,
               cost_ratio=round(final['cost_per_question'] / core['cost_per_question'], 2))
    out['write'] = write_cost(final_dir, questions)
    return out
final = {'standard': {}, 'reasoning': {}}
# Standard setting (gpt-4.1-mini answers and plans). The core runs: amendment 15 (LoCoMo, LME), the registered held-out
# runs (HaluMem, BEAM-100K) and run B of amendment 32 (BEAM-10M).
lme_full = P3 / 'steps/mini-simple-consolidated-full/lme'
final['standard']['locomo'] = compare(P3 / 'steps/mini-simple/locomo', P3 / 'steps/mini-simple-consolidated/locomo', 'qa', 'gpt-4.1-mini', 1540)
final['standard']['lme'] = compare(P3 / 'steps/mini-simple/lme', lme_full, 'qa', 'gpt-4.1-mini', 500) if (lme_full / 'grades.jsonl').exists() else None
if final['standard']['lme'] and not final['standard']['lme'].get('write'):
    # Amendment 34 reused amendment 31's consolidated memories from its own workspaces directory.
    final['standard']['lme']['write'] = write_cost(P3 / 'steps/lme-final-workspaces', 500)
final['standard']['lme-180'] = compare(P3 / 'steps/mini-simple/lme', P3 / 'steps/mini-simple-consolidated/lme', 'qa', 'gpt-4.1-mini', 180)
final['standard']['halumem'] = compare(HELD / 'halumem', HELD / 'halumem-consolidated', 'heldout', 'gpt-4.1-mini', 3467)
final['standard']['beam100k'] = compare(HELD / 'beam128k', HELD / 'beam128k-consolidated', 'heldout', 'gpt-4.1-mini', 400)
final['standard']['beam10m'] = compare(HELD / 'beam10m-hybrid-a32', HELD / 'beam10m-full-a33', 'heldout', 'gpt-4.1-mini')
final['standard']['beam10m-bm25-vs-hybrid'] = compare(HELD / 'beam10m-bm25-a32', HELD / 'beam10m-hybrid-a32', 'heldout', 'gpt-4.1-mini')
bw = write_cost(HELD / 'beam10m-workspaces', 200)
if bw: final['standard']['beam10m']['write'] = bw
# Reasoning setting (DeepSeek-V4.1-Flash answers with thinking and plans without): the simple mode of amendment 11 for
# LoCoMo and LME (amendment 31), and run C of amendment 33 as the core of run D on BEAM-10M (the reader changes, not the memory).
final['reasoning']['locomo'] = compare(P3 / 'steps/simple-cmp/simple/locomo', P3 / 'steps/simple-consolidated-ds/locomo', 'qa', 'deepseek', 1540)
final['reasoning']['lme'] = compare(P3 / 'steps/simple-cmp/simple/lme', P3 / 'steps/simple-consolidated-ds/lme', 'qa', 'deepseek', 500)
final['reasoning']['beam10m-reader'] = compare(HELD / 'beam10m-full-a33', HELD / 'beam10m-full-ds-a33', 'heldout', 'gpt-4.1-mini', final_reader='deepseek')
if final['standard']['lme'] and (P3 / 'steps/simple-consolidated-ds/lme/grades.jsonl').exists():
    # The same consolidated LME memories read by the two readers (amendment 34 reuses amendment 31's).
    final['reasoning']['lme-reader'] = compare(lme_full, P3 / 'steps/simple-consolidated-ds/lme', 'qa', 'gpt-4.1-mini', final_reader='deepseek')
# LoCoMo under the revised labels (and without open-domain), for both sides of each LoCoMo comparison, on its questions.
for setting, core_dir, final_dir, reader in (('standard', P3 / 'steps/mini-simple/locomo', P3 / 'steps/mini-simple-consolidated/locomo', 'gpt-4.1-mini'),
                                             ('reasoning', P3 / 'steps/simple-cmp/simple/locomo', P3 / 'steps/simple-consolidated-ds/locomo', 'deepseek')):
    x = final[setting].get('locomo')
    if not x or not x.get('paired'): continue
    sides = {'core': run(core_dir, 'locomo', reader), 'final': run(final_dir, 'locomo', reader)}
    judges = [j for j in ('mini', 'deepseek') if all(s['grades'][j] for s in sides.values())]
    ids = sorted(set.intersection(*[set(s['rows']) & set.intersection(*[set(s['grades'][j]) for j in judges]) for s in sides.values()]))
    no_od = [i for i in ids if sides['core']['rows'][i]['type'] != 'open-domain']
    for name, r in sides.items():
        x[name]['labels'] = {j: dict(original=round(100 * sum(r['grades'][j][i] for i in ids) / len(ids), 1), revised=revised(r, ids, j)[0],
                                     original_no_open_domain=round(100 * sum(r['grades'][j][i] for i in no_od) / len(no_od), 1),
                                     revised_no_open_domain=revised(r, ids, j, True)[0], refined_graded=bool(r['grades'][j + '-refined'])) for j in judges}
# Scale: BEAM-100K (BM25 control, registered core, final version) and BEAM-10M (A: BM25 core; B: hybrid core; C: final
# version; D: C read by DeepSeek), each run on all its questions.
scale = {}
for key, name, reader in (('100k-bm25', 'beam128k-bm25', 'gpt-4.1-mini'), ('100k-core', 'beam128k', 'gpt-4.1-mini'), ('100k-final', 'beam128k-consolidated', 'gpt-4.1-mini'),
                          ('10m-A', 'beam10m-bm25-a32', 'gpt-4.1-mini'), ('10m-B', 'beam10m-hybrid-a32', 'gpt-4.1-mini'),
                          ('10m-C', 'beam10m-full-a33', 'gpt-4.1-mini'), ('10m-D', 'beam10m-full-ds-a33', 'deepseek')):
    s = side(HELD / name, 'heldout', reader)
    if s:
        summary, _, rows = s
        summary['set_aside_empty_views'] = len(load(HELD / name / 'empty-view-rows.jsonl'))
        summary['jev_tokens_median'] = round(statistics.median(r.get('replica', {}).get('jev', 0) for r in rows.values()))
        scale[key] = summary
final['scale'] = scale
# All together: the final version against cue recall over BM25 (S0), each reader graded by its own judge.
together = {}
for label, s0, fin, ds_, reader, judge in (('gpt-4.1-mini', P3 / 'full/locomo', P3 / 'steps/mini-simple-consolidated/locomo', 'locomo', 'gpt-4.1-mini', 'mini'),
                                           ('gpt-4.1-mini', P3 / 'full/lme', lme_full, 'lme', 'gpt-4.1-mini', 'mini'),
                                           ('DeepSeek', P3 / 'steps/s0-ds/locomo', P3 / 'steps/simple-consolidated-ds/locomo', 'locomo', 'deepseek', 'deepseek'),
                                           ('DeepSeek', P3 / 'steps/s0-ds/lme', P3 / 'steps/simple-consolidated-ds/lme', 'lme', 'deepseek', 'deepseek')):
    a, b = run(s0, ds_, reader), run(fin, ds_, reader)
    ids = sorted(set(a['rows']) & set(b['rows']) & set(a['grades'][judge]) & set(b['grades'][judge]))
    if len(ids) >= (1500 if ds_ == 'locomo' else 490): together[f'{label} {ds_}'] = paired(a, b, ids, judge)
final['all_together'] = together
results['final'] = final

# 7. Jev-Mem (arXiv 2609.23986), concurrent work that also uses Jev as System 1, run from its released code under our
# protocol by scripts/jevmem_locomo.py: the same 1,540 LoCoMo questions, gpt-4.1-mini answering once per question given
# only the question ('blind'; 'labels' also passes each question's LoCoMo category, which its own runner uses), and the
# same two graders; paired with the final version of Mnemon on the questions both graders graded on both sides.
JEVMEM = RUNS / 'jevmem-locomo-20260928'
def jevmem_side(variant):
    arm = {'blind': 'jev-mem', 'labels': 'jev-mem-labels'}[variant]
    d = JEVMEM / variant
    rows = {r['id']: r for r in load(d / 'rows.jsonl') if r['arm'] == arm}
    grades = {judge: {g['id']: bool(g['correct']) for g in load(d / name) if g['arm'] == arm}
              for judge, name in (('mini', 'grades-gpt-4.1-mini.jsonl'), ('deepseek', 'grades.jsonl'),
                                  ('mini-refined', 'grades-gpt-4.1-mini-refined.jsonl'), ('deepseek-refined', 'grades-refined.jsonl'))}
    return dict(ds='locomo', reader='gpt-4.1-mini', rows=rows, grades=grades)
def jevmem():
    records = [json.load(open(p)) for p in sorted((JEVMEM / 'construction').glob('*.json'))]
    if not records: return None
    mnemon = run(P3 / 'steps/mini-simple-consolidated/locomo', 'locomo', 'gpt-4.1-mini')
    # Write time: Jev's decisions (typing and relations) for every turn, and any LLM call, per conversation.
    write = [r['jev']['input'] * JEV / 1e6 + sum(priced(u, MINI) for u in r.get('main', [])) for r in records]
    out = dict(construction=dict(histories=len(records), turns=sum(r['turns'] for r in records),
                                 seconds=round(sum(r['seconds'] for r in records)), jev_calls=sum(r['jev']['calls'] for r in records),
                                 fallbacks=sum(len(r['fallbacks']) for r in records), llm_calls=sum(len(r.get('main', [])) for r in records),
                                 per_history=round(statistics.mean(write), 4)))
    acc = lambda g, sel: round(100 * sum(g[i] for i in sel) / len(sel), 1)
    for variant in ('blind', 'labels'):
        side = jevmem_side(variant)
        rows, g = side['rows'], side['grades']
        if not rows: continue
        v = dict(answered=len(rows), errors=sum(bool(r.get('error')) for r in rows.values()),
                 fallback_questions=sum(bool(r.get('fallbacks')) for r in rows.values()),
                 served=sorted({u.get('served') for r in rows.values() for u in r.get('main', [])}),
                 jev_models=sorted({m for r in rows.values() for m in r['jev'].get('models', [])}))
        for judge in ('mini', 'deepseek'):
            m = mnemon['grades'][judge]
            ids = sorted(set(rows) & set(mnemon['rows']) & set(g[judge]) & set(m))
            if len(ids) < 1500: continue
            diff = lambda sel: (lambda d: {**d, 'p': round(mcnemar(d['up'], d['down']), 6)})(mean_diff([m[i] - g[judge][i] for i in sel]))
            v[judge] = dict(n=len(ids), mnemon=acc(m, ids), jevmem=acc(g[judge], ids), paired=diff(ids),
                            by_type={t: dict(n=len(sel), mnemon=acc(m, sel), jevmem=acc(g[judge], sel), paired=diff(sel))
                                     for t in TYPES['locomo'] if (sel := [i for i in ids if rows[i]['type'] == t])},
                            revised=dict(mnemon=revised(mnemon, ids, judge)[0], jevmem=revised(side, ids, judge)[0]))
        rs = list(rows.values())
        v['process'] = dict(
            answer_input_tokens=round(statistics.mean(sum(u.get('miss', 0) + u.get('hit', 0) for u in r['main']) for r in rs)),
            jev_tokens=round(statistics.mean(r['jev']['input'] for r in rs)), jev_calls=round(statistics.mean(r['jev']['calls'] for r in rs), 2),
            cost_per_question=round(statistics.mean(sum(priced(u, MINI) for u in r['main']) + r['jev']['input'] * JEV / 1e6 for r in rs), 6),
            latency_p50_s=round(statistics.median(r['elapsedMs'] for r in rs) / 1000, 2))
        out[variant] = v
    return out
results['jevmem'] = jevmem()

# HaluMem's run records are not redistributed: its license (CC BY-NC-ND 4.0) lets no adapted material be shared. Without
# them, the HaluMem entries of the existing results.json are kept as they are, in place, and the rest is recomputed.
def carry_halumem(new, old):
    merged = {}
    for key, value in old.items():
        if 'halumem' in key.lower(): merged[key] = value
        elif key in new: merged[key] = carry_halumem(new[key], value) if isinstance(value, dict) and isinstance(new[key], dict) else new[key]
    return {**merged, **{key: value for key, value in new.items() if key not in merged}}
if not (HELD / 'halumem').exists() and OUT.exists():
    results = carry_halumem(results, json.load(open(OUT)))
    print('HaluMem run records absent: kept the HaluMem entries of', OUT)

OUT.parent.mkdir(parents=True, exist_ok=True)
json.dump(results, open(OUT, 'w'), indent=1)
print('wrote', OUT)
for ds in ('locomo', 'lme'):
    m = results['gpt41mini_chain'][ds]
    print(ds, 'gpt-4.1-mini', m['questions'], {k: (v['mini']['accuracy'], v['deepseek']['accuracy'], v['mini']['cost_per_question']['total']) for k, v in m['runs'].items()})
    d = results['deepseek_chain'][ds]
    print(ds, 'deepseek', d['questions'], {k: (v['deepseek']['accuracy'], v['deepseek']['cost_per_question']['total']) for k, v in d['runs'].items()})
print('simple', results['simple_noninferiority'])
