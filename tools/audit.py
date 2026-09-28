#!/usr/bin/env python3
"""Scan for content that must not be committed: credentials, local absolute paths, private endpoints, large files,
and run records of benchmarks whose license does not allow redistributing them. Prints file names and counts only,
never the matched text. Exit status 1 when anything is found.

    python3 tools/audit.py              # the working tree
    python3 tools/audit.py --history    # every file of every commit reachable from any ref

Words or hosts that must never appear, but that the repository should not name either, go into a local, git-ignored
`.audit-deny` at the repository root: one literal per line, matched without regard to case; `#` starts a comment.
"""
import gzip, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {'.git', 'node_modules', 'lib', 'dist', '.cache', 'runs-expanded', 'out'}
CHECKS = {
    'credential': re.compile(rb'(sk-[A-Za-z0-9_-]{20,}|gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|'
                             rb'(?i:api[_-]?key|secret|token)["\']?\s*[:=]\s*["\'][A-Za-z0-9_\-]{24,}["\'])'),
    'local path': re.compile(rb'/(Users|home)/[A-Za-z0-9_.-]+/|/private/(tmp|var)/'),
    # Loopback and wildcard addresses are fine; any other literal IP is not.
    'endpoint': re.compile(rb'https?://(?!127\.|0\.0\.0\.0)(\d{1,3}\.){3}\d{1,3}(?!\d)'),
}
DENY_FILE = os.path.join(ROOT, '.audit-deny')
if os.path.exists(DENY_FILE):
    words = [line.split('#', 1)[0].strip() for line in open(DENY_FILE, encoding='utf-8')]
    words = [w for w in words if w]
    if words: CHECKS['denied'] = re.compile(b'|'.join(re.escape(w.encode()) for w in words), re.I)
# HaluMem (CC BY-NC-ND 4.0) allows no adapted material to be shared: its run records stay out (DATA-LICENSES.md).
WITHHELD = re.compile(r'^runs/.*halumem', re.I)
LARGE = 50 * 1024 * 1024
# The audit and scrub tools describe the patterns they look for.
SELF = {'tools/audit.py', 'tools/scrub.py'}


def scan(relative, content, report):
    if WITHHELD.search(relative):
        report(f'withheld     {relative}')
    name = os.path.basename(relative)
    if name == '.env' or name.startswith('.env.') and name != '.env.example':
        report(f'env file     {relative}'); return
    if relative in SELF or relative == '.audit-deny':
        return
    if len(content) > LARGE:
        report(f'large file   {relative} ({len(content) / 1e6:.0f} MB)')
    if relative.endswith('.gz'):
        try: content = gzip.decompress(content)
        except OSError: pass
    for label, pattern in CHECKS.items():
        hits = len(pattern.findall(content))
        if hits:
            report(f'{label:12} {relative} ({hits})')


def main():
    findings = []
    report = findings.append
    if '--history' in sys.argv[1:]:
        git = lambda *a: subprocess.run(['git', '-C', ROOT, *a], capture_output=True, check=True).stdout
        seen = {}
        commits = git('rev-list', '--all').decode().split()
        for commit in commits:
            for line in git('ls-tree', '-r', commit).decode().splitlines():
                meta, path = line.split('\t', 1)
                kind, sha = meta.split()[1:3]
                if kind == 'blob' and sha not in seen: seen[sha] = path
            message = git('log', '-1', '--format=%B', commit)
            for label, pattern in CHECKS.items():
                if pattern.search(message): report(f'{label:12} message of {commit[:8]}')
        for sha, path in seen.items():
            scan(path, git('cat-file', 'blob', sha), report)
        print(f'{len(commits)} commits, {len(seen)} distinct files')
    else:
        for base, subdirs, names in os.walk(ROOT):
            subdirs[:] = [d for d in subdirs if d not in SKIP_DIRS]
            for name in names:
                path = os.path.join(base, name)
                with open(path, 'rb') as handle:
                    scan(os.path.relpath(path, ROOT).replace(os.sep, '/'), handle.read(), report)
    for line in findings: print(line)
    print('clean' if not findings else f'{len(findings)} finding(s)')
    sys.exit(1 if findings else 0)


if __name__ == '__main__':
    main()
