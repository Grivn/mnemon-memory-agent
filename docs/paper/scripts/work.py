"""Count the work on the critical path of one question in the final runs (data/work.json), from the replica's traces:
one input job per question. The counts follow the order in which a job runs (natural.ts in the JEV strategy plugin):

  planning  System 2 calls in sequence: the planning round (cues and needs, two calls in parallel) and one more call for
            every loop round that rewrote searches; the answer is one further call on the main side
  Jev       calls in all, and the waves they run in, one after another: the screen of the pool (its chunks in
            parallel), the need table (when a question has several needs or a need for every instance), the screen and
            table of every loop round that found new records, the judgement of the short list (parts of 40 in
            parallel), and the consolidated layer's topics and values (40 per call) and, when it reads them, the
            records they link to
  reads     reads of the memory's Source (the journal), one after another: its head, the searches (a cue or the next
            page of one) and reads by id

The benchmark harness mounts eight more Sources, empty in these runs, whose heads the counts leave out. The judge
stage's measured time (one wave) is kept as a check on the per-wave time. Runs live outside the repository; point
MNEMON_RUNS at them:

    python3 docs/paper/scripts/work.py
"""
import glob, json, math, os, statistics
from pathlib import Path

HERE = Path(__file__).resolve()
RUNS = Path(os.environ.get('MNEMON_RUNS', HERE.parents[4] / 'runs'))
P3 = RUNS / 'phase03-20260925'
OUT = HERE.parents[1] / 'data' / 'work.json'
# The final version's replica workspaces. The BEAM-10M workspaces also hold the earlier run without consolidation,
# whose jobs have no consolidated layer.
FINAL = {'locomo': P3 / 'steps/mini-simple-consolidated/locomo', 'lme': P3 / 'steps/lme-final-workspaces',
         'halumem': P3 / 'heldout/halumem-consolidated', 'beam100k': P3 / 'heldout/beam128k-consolidated',
         'beam10m': P3 / 'heldout/beam10m-workspaces'}
SEARCHES, BY_ID = ('cue', 'page'), ('expand', 'verify', 'layer', 'reread')

def job_work(e):
    log = e.get('log') or []
    journal = [r for r in log if r.get('source') == 'journal']
    count = lambda reads, kinds: sum(r['why'] in kinds for r in reads)
    loop = (e.get('cues') or {}).get('loop') or {}
    needs, rounds = loop.get('needs') or [], loop.get('rounds') or []
    tabled = len(needs) > 1 or any(n.get('all') for n in needs)
    layer = e.get('layer') or {}
    candidates = sum((layer.get('candidates') or {}).get(k, 0) for k in ('topics', 'values'))
    waves = ((1 if e.get('recall') else 0) + (1 if tabled else 0)
             + sum(1 for r in rounds if (r.get('fresh') or 0) > 0) * (2 if tabled else 1)
             + (1 if e.get('judged') else 0) + math.ceil(candidates / 40)
             + (1 if layer and (layer.get('expanded') or count(journal, ('layer',))) else 0))
    t = e['timing']
    return {'planning': 1 + sum(1 for r in rounds if r.get('rewritten')), 'jev_calls': e.get('decisions', 0), 'jev_waves': waves,
            'reads': len(journal), 'searches': count(journal, SEARCHES), 'id_reads': count(journal, BY_ID),
            'judge_wave_s': (t['judge'] - t['search']) / 1000}

def summary(values):
    s = sorted(values)
    return {'p50': s[len(s) // 2] if len(s) % 2 else (s[len(s) // 2 - 1] + s[len(s) // 2]) / 2, 'mean': round(statistics.mean(s), 3),
            'p90': s[min(len(s) - 1, round(0.9 * (len(s) - 1)))]}

out = {}
for key, root in FINAL.items():
    jobs = []
    for path in glob.glob(str(root / '**/replica/natural/traces/*.jsonl'), recursive=True):
        for line in open(path):
            e = json.loads(line)
            if e.get('trigger') != 'input' or 'judge' not in (e.get('timing') or {}): continue
            if key == 'beam10m' and not e.get('layer'): continue
            jobs.append(job_work(e))
    out[key] = {'jobs': len(jobs), **{k: summary([j[k] for j in jobs]) for k in jobs[0]},
                'replanned_share': round(sum(j['planning'] > 1 for j in jobs) / len(jobs), 3)}
    print(key, len(jobs), {k: out[key][k]['p50'] for k in jobs[0]})
OUT.write_text(json.dumps(out, indent=1) + '\n')
