"""Package the paper's LaTeX sources for arXiv: main.tex, the sections, tables and figures it uses, the bibliography
as main.bbl, and a 00README.json that names the top-level file and the compiler (pdfLaTeX, arXiv's TeX Live 2025).

    python3 docs/paper/scripts/arxiv.py [--out DIR] [--tectonic PATH] [--check IMAGE]

main.bbl comes from one Tectonic run of the paper, as build.sh compiles it; arXiv uses a .bbl when one is present and
then runs no BibTeX. Everything main.tex does not use (the appendix, data, scripts, logs) and hidden files are left out.
Beside the package, abstract.txt holds the abstract as plain text for arXiv's form, within its 1,920 characters; a
line that starts with spaces begins a new paragraph there.
With --check, the package is compiled twice with pdflatex inside a TeX Live Docker image (for example
texlive/texlive:TL2025-historic) and the log is searched for errors, undefined references and overfull lines.
"""
import argparse, json, re, shutil, subprocess, sys, tarfile, tempfile
from pathlib import Path

PAPER = Path(__file__).resolve().parents[1]


def uncommented(text):
    return '\n'.join(re.sub(r'(?<!\\)%.*', '', line) for line in text.splitlines())


def used_files():
    """main.tex and every file it reaches through \\input and \\includegraphics, in order of first use."""
    files, queue = [], ['main.tex']
    while queue:
        name = queue.pop(0)
        if name in files: continue
        files.append(name)
        text = uncommented((PAPER / name).read_text(encoding='utf-8'))
        for target in re.findall(r'\\input\{([^}]+)\}', text):
            queue.append(target if target.endswith('.tex') else target + '.tex')
        for target in re.findall(r'\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}', text):
            files.append(target) if (PAPER / target).exists() else files.append(target + '.pdf')
    return files


def bibliography(tectonic):
    """Compile once in a scratch copy and return the .bbl text."""
    with tempfile.TemporaryDirectory() as scratch:
        copy = Path(scratch) / 'paper'
        shutil.copytree(PAPER, copy, ignore=shutil.ignore_patterns('data', 'scripts', '*.pdf', '*.log', '*.aux', '*.blg'))
        for figure in (PAPER / 'figures').glob('*.pdf'):
            shutil.copy(figure, copy / 'figures' / figure.name)
        subprocess.run([tectonic, '-X', 'compile', 'main.tex', '--keep-intermediates'], cwd=copy, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return (copy / 'main.bbl').read_text(encoding='utf-8')


ABSTRACT_LIMIT = 1920   # characters arXiv's form accepts for the abstract


def plain_abstract():
    """sections/abstract.tex as plain text: macros of main.tex and tables/numbers.tex expanded, TeX markup removed."""
    macros = {}
    for source in ('main.tex', 'tables/numbers.tex'):
        text = (PAPER / source).read_text(encoding='utf-8')
        macros.update(re.findall(r'\\newcommand\{\\(\w+)\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}', text))
    text = (PAPER / 'sections/abstract.tex').read_text(encoding='utf-8')
    text = uncommented(text.split('\\begin{abstract}')[1].split('\\end{abstract}')[0])
    for _ in range(3):   # a macro may use another one
        text = re.sub(r'\\(\w+)(?:\{\})?', lambda m: macros.get(m.group(1), m.group(0)), text)
    text = text.replace('\\-', '').replace('\\%', '%').replace('\\,', ' ').replace('~', ' ').replace('--', '-')
    if '\\' in text or '{' in text: sys.exit('the abstract keeps TeX markup that plain text cannot show')
    # arXiv joins lines; a line that starts with whitespace begins a new paragraph.
    return '\n  '.join(' '.join(paragraph.split()) for paragraph in text.strip().split('\n\n'))


def check(package, image):
    """Compile the package with pdflatex twice in a TeX Live container; report what arXiv would complain about."""
    run = lambda: subprocess.run(['docker', 'run', '--rm', '--platform', 'linux/amd64', '-v', f'{package}:/paper', '-w', '/paper', image,
                                  'pdflatex', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'],
                                 capture_output=True, text=True)
    first = run()
    second = run() if first.returncode == 0 else first
    log = (package / 'main.log').read_text(encoding='utf-8', errors='replace') if (package / 'main.log').exists() else second.stdout
    problems = [line for line in log.splitlines() if line.startswith('!') or 'undefined' in line.lower() or 'Overfull' in line]
    version = next((line for line in log.splitlines()[:3] if 'pdfTeX' in line), '')
    pages = re.search(r'Output written on main\.pdf \((\d+) pages', log)
    print(f'pdflatex exit {second.returncode}; {version.strip()}')
    print(f'pages: {pages.group(1) if pages else "?"}; problems: {len(problems)}')
    for line in problems[:20]: print('  ', line[:160])
    for leftover in ('main.aux', 'main.log', 'main.out', 'main.pdf'):
        target = package / leftover
        if target.exists(): target.rename(package.parent / f'checked-{leftover}')
    return second.returncode == 0 and not any(line.startswith('!') for line in problems)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--out', default=tempfile.mkdtemp(prefix='mnemon-arxiv-'), help='output directory')
    parser.add_argument('--tectonic', default=shutil.which('tectonic') or 'tectonic')
    parser.add_argument('--check', metavar='IMAGE', help='a TeX Live Docker image to compile the package with')
    args = parser.parse_args()
    out = Path(args.out).resolve()
    package = out / 'arxiv-src'
    shutil.rmtree(package, ignore_errors=True)
    package.mkdir(parents=True)
    files = used_files()
    for name in files:
        target = package / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(PAPER / name, target)
    (package / 'main.bbl').write_text(bibliography(args.tectonic), encoding='utf-8')
    (package / '00README.json').write_text(json.dumps({
        'process': {'compiler': 'pdflatex'},
        'sources': [{'filename': 'main.tex', 'usage': 'toplevel'}],
    }, indent=2) + '\n', encoding='utf-8')
    hidden = [p for p in package.rglob('.*')]
    if hidden: sys.exit(f'hidden files in the package: {hidden}')
    archive = out / 'mnemon-arxiv.tar.gz'
    with tarfile.open(archive, 'w:gz') as tar:
        for path in sorted(package.rglob('*')):
            if path.is_file(): tar.add(path, arcname=str(path.relative_to(package)))
    size = sum(p.stat().st_size for p in package.rglob('*') if p.is_file())
    print(f'{len(files) + 2} files, {size / 1e6:.1f} MB uncompressed -> {archive} ({archive.stat().st_size / 1e6:.1f} MB)')
    abstract = plain_abstract()
    (out / 'abstract.txt').write_text(abstract + '\n', encoding='utf-8')
    print(f'abstract: {len(abstract)} characters, arXiv accepts {ABSTRACT_LIMIT} -> {out / "abstract.txt"}')
    if len(abstract) > ABSTRACT_LIMIT: sys.exit('the abstract is too long for arXiv')
    if args.check:
        sys.exit(0 if check(package, args.check) else 1)


if __name__ == '__main__':
    main()
