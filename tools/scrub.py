#!/usr/bin/env python3
"""Replace machine-specific absolute paths in snapshot files with placeholders, and record each change.

    python3 tools/scrub.py

Rules, applied in order:
- the research repository's checkout path          -> <repo>
- macOS per-user temporary folders (/private/var/folders/..., /var/folders/...) -> <tmp>
- /private/tmp                                      -> <tmp>
- any other /Users/<name> or /home/<name>           -> ~

Gzip files are decompressed, rewritten and recompressed with a zero timestamp. PROVENANCE.json keeps each file's
source hash under "files" and lists every rewritten file under "modified" with its new hash and the reason.
"""
import gzip, hashlib, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RULES = [
    (re.compile(rb'/Users/[A-Za-z0-9_.-]+/github\.com/omdsh-dev/dsh-mnemon[A-Za-z0-9_.-]*(?:/dsh-mnemon)?'), b'<repo>'),
    (re.compile(rb'(?:/private)?/var/folders/[A-Za-z0-9_]+/[A-Za-z0-9_]+'), b'<tmp>'),
    (re.compile(rb'/private/tmp(?=/|\b)'), b'<tmp>'),
    (re.compile(rb'/(?:Users|home)/[A-Za-z0-9_.-]+(?=/)'), b'~'),
]
REASON = 'machine-specific absolute paths replaced by placeholders (<repo>, <tmp>, ~)'


def rewrite(data):
    for pattern, replacement in RULES:
        data = pattern.sub(replacement, data)
    return data


def main():
    provenance_path = os.path.join(ROOT, 'PROVENANCE.json')
    provenance = json.load(open(provenance_path))
    changed = 0
    for relative in provenance['files']:
        path = os.path.join(ROOT, relative)
        raw = open(path, 'rb').read()
        compressed = relative.endswith('.gz')
        text = gzip.decompress(raw) if compressed else raw
        updated = rewrite(text)
        if updated == text:
            continue
        output = gzip.compress(updated, mtime=0) if compressed else updated
        open(path, 'wb').write(output)
        provenance['modified'][relative] = {'sha256': hashlib.sha256(output).hexdigest(), 'reason': REASON}
        changed += 1
        print('scrubbed', relative)
    json.dump(provenance, open(provenance_path, 'w'), indent=1, ensure_ascii=False)
    print(f'{changed} file(s) rewritten')


if __name__ == '__main__':
    main()
