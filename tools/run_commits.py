#!/usr/bin/env python3
"""List, for each packaged run directory, the code commit and models its run configs recorded.

    python3 tools/run_commits.py --runs /path/to/runs > docs/run-commits.json

A run directory is the parent of a packaged rows.jsonl. The bench writes config-<arm>-<time>.json there with the
git state (commit, dirty flag) and the models used; every such config in that directory is summarized. The output
lets each number in the paper be traced to the commit it ran on.
"""
import argparse, glob, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--runs', required=True)
    args = parser.parse_args()
    manifest = json.load(open(os.path.join(ROOT, 'runs', 'MANIFEST.json')))
    directories = sorted({os.path.dirname(path) for path in manifest['files'] if os.path.basename(path) == 'rows.jsonl'})
    report = {}
    for directory in directories:
        configs = []
        for path in sorted(glob.glob(os.path.join(args.runs, directory, 'config-*.json'))):
            config = json.load(open(path))
            git = config.get('git') or {}
            configs.append({'config': os.path.basename(path), 'startedAt': config.get('startedAt'),
                            'commit': git.get('commit') if isinstance(git, dict) else git,
                            'dirty': git.get('dirty') if isinstance(git, dict) else None,
                            'arms': config.get('arms'), 'models': config.get('models')})
        report[directory] = configs
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
