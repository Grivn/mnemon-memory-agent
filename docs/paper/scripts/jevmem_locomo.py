"""Run the public Jev-Mem code (arXiv 2609.23986; github.com/libingzheren/Jev-Mem at 7ab0c73) on LoCoMo under the
paper's protocol, for its section on judging raw records or organizing them.

    python jevmem_locomo.py build  --jevmem PATH --out RUN [--samples 0 1 ...]   # construct and save each conversation's memory
    python jevmem_locomo.py answer --jevmem PATH --out RUN --variant blind|labels [--workers 3] [--samples ...] [--limit N]

PATH is a clone of Jev-Mem with its dependencies installed (Python 3.11 or later, its requirements.txt); RUN is a run
directory under MNEMON_RUNS, which also holds benchmarks/locomo10.json. The keys come from the environment:
OPENAI_API_KEY (and OPENAI_BASE_URL if set) for the answering model, TYPESAFE_API_KEY for Jev.

Protocol, as for Mnemon: gpt-4.1-mini answers at temperature 0, once per question, on the 1,540 non-adversarial
questions with the paper's ids (<sample_id>-q<i> over the non-adversarial questions in file order); the answers are
graded afterwards by scripts/bench/judge.ts, and scripts/collect.py compares them with Mnemon's. Jev-Mem runs as released:
its default profile (config/jev_mem.json), its default local embeddings (all-MiniLM-L6-v2), jev-latest and its own answer
prompts. What its LoCoMo runner does differently is left out: best-of-three selection against the gold answer, its own
grader, and the adversarial category. `blind` gives the system only the question; `labels` also passes each question's
LoCoMo category, which the runner uses to choose the answer prompt and the retrieval size.

Rows go to RUN/<variant>/rows.jsonl in the format of scripts/bench (arm, dataset, case, id, type, question, gold,
answer), with the answering model's token usage ("main"), Jev's usage and fallbacks, and timings; contexts.jsonl keeps
the context of each answer prompt, and RUN/construction/ one record per conversation.
"""
import argparse, json, os, sys, threading, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['build', 'answer'])
parser.add_argument('--jevmem', required=True, help='a clone of Jev-Mem with its dependencies installed')
parser.add_argument('--out', required=True)
parser.add_argument('--samples', type=int, nargs='+', default=list(range(10)))
parser.add_argument('--variant', choices=['blind', 'labels'], default='blind')
parser.add_argument('--workers', type=int, default=3)
parser.add_argument('--limit', type=int, default=0)
args = parser.parse_args()

REPO = Path(args.jevmem).resolve()
DATASET = Path(os.environ.get('MNEMON_RUNS', Path(__file__).resolve().parents[4] / 'runs')) / 'benchmarks' / 'locomo10.json'
MODEL = 'gpt-4.1-mini'
CATEGORIES = {1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop'}
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
os.chdir(REPO)
sys.path.insert(0, str(REPO))

from dataclasses import replace  # noqa: E402
from jev_mem.datasets.locomo import load_locomo_dataset  # noqa: E402
from memory.jev_client import JevClient  # noqa: E402
from memory.jev_mem_config import JevMemConfig  # noqa: E402
from memory.memory_builder import MemoryBuilder  # noqa: E402
from memory.query_engine import QueryEngine  # noqa: E402
from memory.test_harness import TestHarness  # noqa: E402
from utils.memory_layer import OpenAIController  # noqa: E402

# ---- Per-thread recording of every model call ------------------------------------------------------------------
LOCAL = threading.local()


def recording():
    return getattr(LOCAL, 'rec', None)


def get_completion(self, prompt, response_format, temperature=0.7):
    """OpenAIController.get_completion as released, plus the usage and served model of each reply."""
    messages = []
    if response_format.get('type') in ['json_object', 'json_schema']:
        messages.append({'role': 'system', 'content': 'You must respond with a JSON object.'})
    messages.append({'role': 'user', 'content': prompt})
    response = self.client.chat.completions.create(model=self.model, messages=messages, response_format=response_format,
                                                   temperature=temperature, max_tokens=2000)
    rec = recording()
    if rec is not None and getattr(response, 'usage', None):
        usage = response.usage
        cached = getattr(getattr(usage, 'prompt_tokens_details', None), 'cached_tokens', 0) or 0
        rec['main'].append({'miss': usage.prompt_tokens - cached, 'hit': cached, 'output': usage.completion_tokens,
                            'served': response.model})
    return response.choices[0].message.content


OpenAIController.get_completion = get_completion
_log, _failure = JevClient._log, JevClient._failure


def log(self, operation, result):
    rec = recording()
    if rec is not None:
        rec['jev'].append({'op': operation, 'source': result.source, 'model': result.model, 'usage': dict(result.usage or {})})
    return _log(self, operation, result)


def failure(self, operation, reason, budget):
    rec = recording()
    if rec is not None:
        rec['fallbacks'].append({'op': operation, 'reason': reason})
    return _failure(self, operation, reason, budget)


JevClient._log, JevClient._failure = log, failure


def summary(rec):
    jev = [c for c in rec['jev'] if c['source'] != 'cache']
    return {'main': rec['main'],
            'jev': {'calls': len(jev), 'cached': len(rec['jev']) - len(jev),
                    'input': sum(c['usage'].get('input_tokens', 0) for c in jev),
                    'output': sum(c['usage'].get('output_tokens', 0) for c in jev),
                    'models': sorted({c['model'] for c in jev if c['model']})},
            'fallbacks': rec['fallbacks']}


# ---- Setup -------------------------------------------------------------------------------------------------------
def config():
    return JevMemConfig.load(str(REPO / 'config' / 'jev_mem.json'))


def builder_for(out, sample, audit):
    cache = out / 'cache' / sample.sample_id
    return MemoryBuilder(cache_dir=str(cache), llm_model=MODEL, use_episodes=False, embedding_model='minilm',
                         jev_config=replace(config(), audit_path=str(audit)))


def questions(sample_index):
    """Our question list for one conversation: the non-adversarial questions in file order, with our ids."""
    data = json.loads(DATASET.read_text())[sample_index]
    items = [qa for qa in data['qa'] if qa.get('category') != 5]
    return [{'id': f"{data['sample_id']}-q{i}", 'case': data['sample_id'], 'category': qa['category'],
             'type': CATEGORIES.get(qa['category'], str(qa['category'])), 'question': qa['question'],
             'gold': str(qa.get('answer', qa.get('adversarial_answer', '')))} for i, qa in enumerate(items)]


# ---- Build -------------------------------------------------------------------------------------------------------
def build(args):
    out = Path(args.out)
    samples = load_locomo_dataset(DATASET)
    for index in args.samples:
        sample = samples[index]
        record = out / 'construction' / f'{sample.sample_id}.json'
        if record.exists():
            print('built already', sample.sample_id, flush=True)
            continue
        record.parent.mkdir(parents=True, exist_ok=True)
        builder = builder_for(out, sample, out / 'construction' / f'{sample.sample_id}-decisions.jsonl')
        LOCAL.rec = {'main': [], 'jev': [], 'fallbacks': []}
        turns = sum(len(s.turns) for s in sample.conversation.sessions.values())
        started = time.perf_counter()
        stats = builder.build_memory(sample)
        seconds = time.perf_counter() - started
        builder.save()
        rec, LOCAL.rec = LOCAL.rec, None
        record.write_text(json.dumps({'case': sample.sample_id, 'turns': turns, 'seconds': round(seconds, 2),
                                      'stats': {k: v for k, v in stats.items() if isinstance(v, (int, float, str, dict))},
                                      **summary(rec)}, default=str) + '\n')
        print(f'built {sample.sample_id}: {turns} turns in {seconds:.0f} s, {len(rec["jev"])} Jev decisions, '
              f'{len(rec["fallbacks"])} fallbacks', flush=True)


# ---- Answer ------------------------------------------------------------------------------------------------------
def answer(args):
    out = Path(args.out)
    target = out / args.variant
    target.mkdir(parents=True, exist_ok=True)
    rows_path, contexts_path = target / 'rows.jsonl', target / 'contexts.jsonl'
    done = {json.loads(line)['id'] for line in rows_path.read_text().splitlines()} if rows_path.exists() else set()
    write = threading.Lock()
    samples = load_locomo_dataset(DATASET)
    arm = 'jev-mem' if args.variant == 'blind' else 'jev-mem-labels'
    for index in args.samples:
        sample = samples[index]
        todo = [q for q in questions(index) if q['id'] not in done][:args.limit or None]
        if not todo:
            continue
        builder = builder_for(out, sample, target / f'{sample.sample_id}-decisions.jsonl')
        builder.load()
        engine = QueryEngine(builder.trg, builder.node_index, entity_session_map=None, entity_dia_map=None,
                             ablation_config={}, jev_config=builder.jev_config, jev_client=builder.jev)
        harness = TestHarness(builder, engine, evaluator=None)

        def one(q):
            category = q['category'] if args.variant == 'labels' else None
            for attempt in range(2):
                LOCAL.rec = {'main': [], 'jev': [], 'fallbacks': []}
                try:
                    started = time.perf_counter()
                    _, context = engine.query(q['question'], top_k=harness.retrieval_top_k(category))
                    retrieved = time.perf_counter()
                    reply = harness.answer_question(q['question'], context, category=category, expected=None)
                    finished = time.perf_counter()
                    error = None if reply != 'Error generating answer' else 'answer'
                except Exception as exc:  # a transient failure is asked once more, as for our own runs
                    reply, context, error = '', '', type(exc).__name__
                    started = retrieved = finished = time.perf_counter()
                if not error:
                    break
            rec, LOCAL.rec = LOCAL.rec, None
            row = {'arm': arm, 'dataset': 'locomo', 'case': q['case'], 'id': q['id'], 'type': q['type'],
                   'abstention': False, 'question': q['question'], 'gold': q['gold'], 'answer': reply, 'model': MODEL,
                   'elapsedMs': round(1000 * (finished - started), 1), 'retrievalMs': round(1000 * (retrieved - started), 1),
                   'contextChars': len(context or ''), **summary(rec), **({'error': error} if error else {})}
            with write:
                with rows_path.open('a') as f:
                    f.write(json.dumps(row) + '\n')
                with contexts_path.open('a') as f:
                    f.write(json.dumps({'id': q['id'], 'context': context}) + '\n')
            return row

        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(one, q) for q in todo]
            for n, future in enumerate(as_completed(futures), 1):
                row = future.result()
                if n % 25 == 0 or n == len(todo):
                    print(f'{sample.sample_id} {n}/{len(todo)} last {row["elapsedMs"]:.0f} ms', flush=True)
        builder.jev.close()


if __name__ == '__main__':
    build(args) if args.mode == 'build' else answer(args)
