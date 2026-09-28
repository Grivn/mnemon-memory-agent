#!/usr/bin/env python3
"""Expand the packaged run records into a directory that docs/paper/scripts/collect.py can read.

    python3 tools/restore_runs.py [--to runs-expanded]
    MNEMON_RUNS=$PWD/runs-expanded python3 docs/paper/scripts/collect.py

Each file is checked against runs/MANIFEST.json. The two public datasets collect.py also reads are not packaged; put
them at <target>/benchmarks/locomo10.json and <target>/benchmarks/longmemeval_s_cleaned.json (see README).
"""
import argparse, gzip, hashlib, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--to', default=os.path.join(ROOT, 'runs-expanded'), help='target directory')
    args = parser.parse_args()
    source = os.path.join(ROOT, 'runs')
    manifest = json.load(open(os.path.join(source, 'MANIFEST.json')))
    for relative, entry in manifest['files'].items():
        data = gzip.decompress(open(os.path.join(source, relative + '.gz'), 'rb').read())
        if hashlib.sha256(data).hexdigest() != entry['sha256']:
            sys.exit(f'checksum mismatch: {relative}')
        destination = os.path.join(args.to, relative)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        open(destination, 'wb').write(data)
    missing = [path for path in manifest['datasets'] if not os.path.exists(os.path.join(args.to, path))]
    print(f'{len(manifest["files"])} files restored into {args.to}')
    if missing:
        print('still needed before running collect.py:', ', '.join(missing))


if __name__ == '__main__':
    main()
