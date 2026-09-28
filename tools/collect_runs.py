#!/usr/bin/env python3
"""Package the run records the paper's numbers are computed from.

    python3 tools/collect_runs.py --runs /path/to/runs [--work /tmp/dir]

Runs docs/paper/scripts/collect.py on a temporary copy of docs/paper with MNEMON_RUNS pointing at the full run
records, and records every file it opens there. Those files, except the public datasets under benchmarks/, are copied
into runs/ with the same relative paths and gzip-compressed (tools/restore_runs.py expands them). Machine-specific
absolute paths are replaced by the rules in tools/scrub.py first. runs/MANIFEST.json lists each file's size and
SHA-256 as packaged, and the source SHA-256 of any file that was rewritten. The script also reports whether the
recomputed results.json equals the one in docs/paper/data, which shows the packaged records reproduce the paper's numbers.
"""
import argparse, gzip, hashlib, json, os, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scrub import rewrite  # noqa: E402
DATASETS = 'benchmarks/'
TRACER = r'''
import json, os, runpy, sys
runs = os.path.realpath(os.environ["MNEMON_RUNS"]) + os.sep
opened = set()
def hook(event, args):
    if event == "open" and isinstance(args[0], (str, bytes, os.PathLike)):
        path = os.path.realpath(os.fsdecode(args[0]))
        if path.startswith(runs) and os.path.isfile(path):
            opened.add(os.path.relpath(path, runs))
sys.addaudithook(hook)
try:
    runpy.run_path(sys.argv[1], run_name="__main__")
finally:
    json.dump(sorted(opened), open(sys.argv[2], "w"), indent=1)
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--runs', required=True, help='the complete run records (MNEMON_RUNS of the research workspace)')
    parser.add_argument('--work', help='a scratch directory (default: a new temporary directory)')
    args = parser.parse_args()
    work = args.work or tempfile.mkdtemp(prefix='collect-runs-')
    paper = os.path.join(work, 'docs', 'paper')
    shutil.rmtree(paper, ignore_errors=True)
    shutil.copytree(os.path.join(ROOT, 'docs', 'paper'), paper)
    tracer, opened_list = os.path.join(work, 'tracer.py'), os.path.join(work, 'opened.json')
    open(tracer, 'w').write(TRACER)
    subprocess.run([sys.executable, tracer, os.path.join(paper, 'scripts', 'collect.py'), opened_list], check=True,
                   env={**os.environ, 'MNEMON_RUNS': args.runs}, stdout=subprocess.DEVNULL)

    recomputed = json.load(open(os.path.join(paper, 'data', 'results.json')))
    committed = json.load(open(os.path.join(ROOT, 'docs', 'paper', 'data', 'results.json')))
    if recomputed == committed:
        print('results.json recomputed from the run records equals docs/paper/data/results.json')
    else:
        differing = sorted(key for key in set(recomputed) | set(committed) if recomputed.get(key) != committed.get(key))
        print('results.json differs from docs/paper/data/results.json in:', ', '.join(differing))

    opened = json.load(open(opened_list))
    packaged = [path for path in opened if not path.startswith(DATASETS)]
    target = os.path.join(ROOT, 'runs')
    shutil.rmtree(target, ignore_errors=True)
    manifest = {'datasets': [path for path in opened if path.startswith(DATASETS)], 'files': {}}
    for relative in packaged:
        source = open(os.path.join(args.runs, relative), 'rb').read()
        data = rewrite(source)
        manifest['files'][relative] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        if data != source:
            manifest['files'][relative]['source_sha256'] = hashlib.sha256(source).hexdigest()
        destination = os.path.join(target, relative + '.gz')
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        open(destination, 'wb').write(gzip.compress(data, compresslevel=9, mtime=0))
    json.dump(manifest, open(os.path.join(target, 'MANIFEST.json'), 'w'), indent=1)
    raw = sum(entry['bytes'] for entry in manifest['files'].values())
    stored = sum(os.path.getsize(os.path.join(target, path + '.gz')) for path in packaged)
    print(f'{len(packaged)} run files packaged: {raw / 1e6:.1f} MB raw, {stored / 1e6:.1f} MB compressed; '
          f'datasets left out: {", ".join(manifest["datasets"]) or "none"}')


if __name__ == '__main__':
    main()
