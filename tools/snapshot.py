#!/usr/bin/env python3
"""Refresh this repository's snapshot from the research branch of the dsh-mnemon repository.

    python3 tools/snapshot.py --source /path/to/dsh-mnemon --commit <commit>

The snapshot is the part of that branch the paper depends on, copied byte for byte from the commit:
- the dsh-mnemon kernel (src/) and the root build files, including the lockfile;
- the plugins the evaluation scripts import, found by following imports from the scripts to a fixed point;
- the evaluation, launcher and paper scripts, and the data files they read by path;
- the paper (docs/paper), the reports it cites (docs/reports), the plans those reports link to, and the report
  assets they link to (docs/pr-assets, only the linked files).

PROVENANCE.json records the commit and, for every file, its git blob id and SHA-256. A later run first removes the
files the previous PROVENANCE.json lists, so files that left the snapshot do not linger. No git history is copied.
"""
import argparse, hashlib, io, json, os, posixpath, re, subprocess, tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT_FILES = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.types.json',
              'tsdown.config.ts', 'vitest.config.ts', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'cordis.patch.yml']
SCRIPT_SEEDS = ['scripts/jev-replica-worker.ts', 'scripts/serve-jev-replica.mjs', 'scripts/seed-jev-profile.ts',
                'scripts/inspect-jev-latency.mjs', 'scripts/build-plugin-packages.mjs', 'scripts/link-bundle-declarations.mjs']
SCRIPT_DIRS = ('scripts/bench/', 'docs/paper/scripts/')
IMPORT = re.compile(r"""(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]""")
DATA_URL = re.compile(r"""new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url""")
LINK = re.compile(r'\]\(([^)\s]+)\)|\\(?:href|url|input|includegraphics)(?:\[[^\]]*\])?\{([^}\s]+)\}')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--source', required=True, help='a clone of the dsh-mnemon repository that has the commit')
    parser.add_argument('--commit', required=True, help='the research branch commit to snapshot')
    args = parser.parse_args()

    def git(*command, binary=False):
        result = subprocess.run(['git', '-C', args.source, *command], capture_output=True, check=True)
        return result.stdout if binary else result.stdout.decode()

    commit = git('rev-parse', args.commit).strip()
    blobs = {}
    for line in git('ls-tree', '-r', commit).splitlines():
        meta, path = line.split('\t', 1)
        blobs[path] = meta.split()[2]
    files = set(blobs)
    dirs = set()
    for path in files:
        parent = posixpath.dirname(path)
        while parent and parent not in dirs:
            dirs.add(parent); parent = posixpath.dirname(parent)
    plugins = {path.split('/')[1] for path in files if path.startswith('plugins/') and path.count('/') >= 2}

    def show(path):
        return git('show', f'{commit}:{path}')

    def resolve(base, spec):
        path = posixpath.normpath(posixpath.join(posixpath.dirname(base), spec))
        for candidate in (path, path + '.ts', path + '.mjs', path + '.js', path + '/index.ts'):
            if candidate in files:
                return candidate
        return None

    # Scripts: seeds plus everything they import, relative imports only (src/ and plugins/ are copied whole).
    scripts, needed, queue = set(), set(), [f for f in files if f.startswith(SCRIPT_DIRS) and re.search(r'\.(m?[jt]s|py)$', f)]
    queue += SCRIPT_SEEDS
    data = set()
    while queue:
        path = queue.pop()
        if path in scripts or path not in files:
            continue
        scripts.add(path)
        text = show(path)
        for spec in IMPORT.findall(text):
            if spec.startswith('.'):
                target = resolve(path, spec)
                if target and target.startswith('plugins/'):
                    needed.add(target.split('/')[1])
                elif target and not target.startswith('src/'):
                    queue.append(target)
            elif spec.split('/')[0] in plugins:
                needed.add(spec.split('/')[0])
        needed |= {name for name in re.findall(r"['\"](dsh-mnemon-[a-z0-9-]+)['\"]", text) if name in plugins}
        for spec in DATA_URL.findall(text):
            target = posixpath.normpath(posixpath.join(posixpath.dirname(path), spec))
            if target in files and not target.startswith(('src/', 'plugins/')):
                data.add(target)

    # Plugins: the scripts' plugins plus their own plugin dependencies; then the plugins the kernel and its build
    # config import (the client bundles their presentation). Those build-only plugins ship without their tests,
    # which exercise product components (Memory Spaces providers and the like) outside the snapshot.
    def close(names):
        queue = list(names)
        while queue:
            name = queue.pop()
            manifest = json.loads(show(f'plugins/{name}/package.json'))
            refs = {dep for dep in {**manifest.get('dependencies', {}), **manifest.get('peerDependencies', {})} if dep in plugins}
            for path in (f for f in files if f.startswith(f'plugins/{name}/src/')):
                refs |= {spec.split('/')[0] for spec in IMPORT.findall(show(path)) if spec.split('/')[0] in plugins}
            for dep in refs - names:
                names.add(dep); queue.append(dep)
        return names
    needed = close(needed)
    kernel = set()
    for path in [f for f in files if f.startswith('src/') or f == 'tsdown.config.ts']:
        kernel |= {spec.split('/')[0] for spec in IMPORT.findall(show(path)) if spec.split('/')[0] in plugins}
    build_only = close(kernel - needed) - needed
    needed |= build_only

    # Documents: the paper, all reports, and what they link to (plans and report assets).
    documents = {f for f in files if f.startswith(('docs/paper/', 'docs/reports/'))}
    linked = set()
    for path in [f for f in documents if f.endswith(('.md', '.tex'))]:
        for groups in LINK.findall(show(path)):
            target = next(group for group in groups if group).split('#')[0]
            if re.match(r'^[a-z]+:', target) or not target:
                continue
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
            if not resolved.startswith(('docs/pr-assets/', 'docs/plans/')):
                continue
            if resolved in files:
                linked.add(resolved)
            elif resolved in dirs:
                linked |= {f for f in files if f.startswith(resolved + '/')}

    root_bins = json.loads(show('package.json')).get('bin', {})
    root_bins = [root_bins] if isinstance(root_bins, str) else list(root_bins.values())
    selected = set(ROOT_FILES) | {posixpath.normpath(path) for path in root_bins}
    selected |= {f for f in files if f.startswith('src/')} | scripts | data | documents | linked
    selected |= {f for f in files for name in needed if f.startswith(f'plugins/{name}/')
                 and not (name in build_only and f.startswith(f'plugins/{name}/tests/'))}
    selected &= files

    # Remove the previous snapshot's files, then write this one.
    provenance_path = os.path.join(ROOT, 'PROVENANCE.json')
    if os.path.exists(provenance_path):
        for path in json.load(open(provenance_path))['files']:
            target = os.path.join(ROOT, path)
            if os.path.isfile(target):
                os.remove(target)
            parent = os.path.dirname(target)
            while parent != ROOT and os.path.isdir(parent) and not os.listdir(parent):
                os.rmdir(parent); parent = os.path.dirname(parent)
    archive = git('archive', '--format=tar', commit, '--', *sorted(selected), binary=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        # The 'data' filter exists from Python 3.12 (and some backports); the archive is git's own output either way.
        tar.extractall(ROOT, **({'filter': 'data'} if hasattr(tarfile, 'data_filter') else {}))

    entries = {}
    for path in sorted(selected):
        digest = hashlib.sha256(open(os.path.join(ROOT, path), 'rb').read()).hexdigest()
        entries[path] = {'blob': blobs[path], 'sha256': digest}
    json.dump({'source': {'repository': 'dsh-mnemon (research branch codex/jev-replica-practice)', 'commit': commit,
                          'date': git('show', '-s', '--format=%cI', commit).strip()},
               'plugins': sorted(needed), 'build_only_plugins': sorted(build_only), 'modified': {}, 'files': entries},
              open(provenance_path, 'w'), indent=1, ensure_ascii=False)
    print(f'{commit[:8]}: {len(entries)} files, {len(needed)} plugins, {len(scripts)} scripts, {len(linked)} linked documents')


if __name__ == '__main__':
    main()
