#!/usr/bin/env python3
"""Scan the working tree for content that must not be committed: credentials, local absolute paths, private endpoints,
and large files. Prints file names and counts only, never the matched text. Exit status 1 when anything is found.

    python3 tools/audit.py
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {'.git', 'node_modules', 'lib', 'dist', '.cache'}
CHECKS = {
    'credential': re.compile(rb'(sk-[A-Za-z0-9_-]{20,}|gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|'
                             rb'(?i:api[_-]?key|secret|token)["\']?\s*[:=]\s*["\'][A-Za-z0-9_\-]{24,}["\'])'),
    'local path': re.compile(rb'/(Users|home)/[A-Za-z0-9_.-]+/|/private/(tmp|var)/'),
    # Loopback and wildcard addresses are fine; any other literal IP is not.
    'endpoint': re.compile(rb'https?://(?!127\.|0\.0\.0\.0)(\d{1,3}\.){3}\d{1,3}(?!\d)'),
}
LARGE = 50 * 1024 * 1024
found = 0
for base, subdirs, names in os.walk(ROOT):
    subdirs[:] = [d for d in subdirs if d not in SKIP_DIRS]
    for name in names:
        path = os.path.join(base, name)
        relative = os.path.relpath(path, ROOT)
        # The audit and scrub tools describe the patterns they look for.
        if relative in (os.path.join('tools', 'audit.py'), os.path.join('tools', 'scrub.py')):
            continue
        if name == '.env' or name.startswith('.env.') and name != '.env.example':
            print(f'env file     {relative}'); found += 1; continue
        size = os.path.getsize(path)
        if size > LARGE:
            print(f'large file   {relative} ({size / 1e6:.0f} MB)'); found += 1
        with open(path, 'rb') as handle:
            content = handle.read()
        if relative.endswith('.gz'):
            import gzip
            try: content = gzip.decompress(content)
            except OSError: pass
        for label, pattern in CHECKS.items():
            hits = len(pattern.findall(content))
            if hits:
                print(f'{label:12} {relative} ({hits})'); found += 1
print('clean' if not found else f'{found} finding(s)')
sys.exit(1 if found else 0)
