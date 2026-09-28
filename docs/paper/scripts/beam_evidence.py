"""Where BEAM-100K's gold evidence went (data/beam_evidence.json), for the registered hybrid run, the BM25 control and
auto mode (amendment 23).

The dataset names, for every question except abstention, the chat messages that hold its evidence (source_chat_ids).
Each message is checked against the question's View text (60-character samples every 150 characters, whitespace
squashed, so that a long message split over several records still counts when any part of it is shown). Messages not
shown are then looked up in the records JEV judged, as logged in the replica's traces: shown, judged but not shown,
or never retrieved. Questions whose traces were replaced when the run resumed (amendment 21) count only for the View
check. Needs pyarrow:

    python docs/paper/scripts/beam_evidence.py
"""
import ast, glob, json, os, re, statistics
from collections import defaultdict
from pathlib import Path
import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parents[1]
RUNS = HERE.parents[2] / 'runs'
BENCH = RUNS / 'benchmarks/beam/100K.parquet'
HELD = RUNS / 'phase03-20260925/heldout'
ARM = 'replica-cuefill:raw-records'
squash = lambda t: re.sub(r'\s+', ' ', t or '').strip()

def parse(s):
    try: return json.loads(s)
    except Exception: return ast.literal_eval(s)
def flat(x):
    if isinstance(x, dict): return [i for v in x.values() for i in flat(v)]
    if isinstance(x, list): return [i for v in x for i in flat(v)]
    return [x] if isinstance(x, int) else []
def samples(text):
    t = squash(text)
    return [t[i:i + 60] for i in range(0, max(1, len(t) - 59), 150)] or [t]

evidence = {}
for r in pq.read_table(BENCH).to_pylist():
    msgs = {m['id']: m for session in r['chat'] for m in session}
    for typ, qs in parse(r['probing_questions']).items():
        for k, q in enumerate(qs):
            evidence[f"beam128k-{r['conversation_id']}-{typ}-{k}"] = [msgs[i]['content'] for i in flat(q.get('source_chat_ids')) if i in msgs]

def analyse(run):
    d = HELD / run
    rows = {x['id']: x for x in map(json.loads, open(d / 'rows.jsonl')) if x.get('arm') == ARM}
    views = {}
    for c in map(json.loads, open(d / 'contexts.jsonl')):
        if c.get('arm') == ARM: views[c['id']] = squash('\n'.join(c.get('view', [])))   # the last entry per question wins
    score = {g['id']: g['score'] for g in map(json.loads, open(d / 'grades-heldout-gpt-4.1-mini.jsonl')) if g['id'] in rows}
    # Records JEV judged for each question, from the replica traces of every conversation.
    pooled, records = {}, {}
    for case_dir in sorted(glob.glob(str(d / ARM.replace(':', '-') / '*'))):
        case = os.path.basename(case_dir)
        files = glob.glob(f'{case_dir}/corpus/shared-plugin-data/sources/journal/*/records.json')
        if not files: continue
        records[case] = {x['id']: squash(x.get('content', '')) for x in json.load(open(files[0]))['records']}
        by_question = {squash(x['question'])[:80]: i for i, x in rows.items() if x['case'] == case}
        for p in glob.glob(f'{case_dir}/replica/natural/traces/*.jsonl'):
            entries = [json.loads(l) for l in open(p)]
            qid = next((by_question.get(squash(c.get('text'))[:80]) for e in entries for c in (e.get('cues') or {}).get('cues', [])
                        if c.get('kind') == 'message' and by_question.get(squash(c.get('text'))[:80])), None)
            if qid: pooled[qid] = {j['key'].split('\x00')[-1] for e in entries for j in e.get('judged') or []}
    per = defaultdict(lambda: dict(questions=0, all_shown=0, score_all=[], score_rest=[], messages=0, shown=0, judged=0, missed=0))
    for qid, row in rows.items():
        ev = evidence.get(qid)
        if not ev or qid not in score: continue
        view = views.get(qid, '')
        shown = [any(s in view for s in samples(m)) for m in ev]
        for key in (row['type'], 'all'):
            x = per[key]
            x['questions'] += 1; x['all_shown'] += all(shown)
            (x['score_all'] if all(shown) else x['score_rest']).append(score[qid])
            if qid in pooled:
                for m, s in zip(ev, shown):
                    ids = {rid for rid, text in records[row['case']].items() if any(p in text for p in samples(m))}
                    x['messages'] += 1
                    x['shown' if s else 'judged' if ids & pooled[qid] else 'missed'] += 1
    mean = lambda v: round(100 * statistics.mean(v), 1) if v else None
    out = {}
    for key, x in per.items():
        out[key] = dict(questions=x['questions'], all_shown=round(100 * x['all_shown'] / x['questions'], 1),
                        score_all_shown=mean(x['score_all']), score_otherwise=mean(x['score_rest']), traced_messages=x['messages'],
                        **{k: round(100 * x[k] / x['messages'], 1) if x['messages'] else None for k in ('shown', 'judged', 'missed')})
    out['_traced_questions'] = sum(1 for q in pooled if q in score and evidence.get(q))
    return out

result = {run: analyse(run) for run in ('beam128k', 'beam128k-bm25', 'beam128k-auto') if (HELD / run / 'rows.jsonl').exists()}
(HERE / 'data/beam_evidence.json').write_text(json.dumps(result, indent=1))
for run, x in result.items():
    a = x['all']
    print(run, f"all evidence shown for {a['all_shown']}% of {a['questions']} questions (score {a['score_all_shown']} vs {a['score_otherwise']});",
          f"of {a['traced_messages']} traced messages: shown {a['shown']}%, judged but not shown {a['judged']}%, never retrieved {a['missed']}%")
