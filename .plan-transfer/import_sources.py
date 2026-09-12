#!/usr/bin/env python3
"""Restore the 48 verbatim planning source files; never modify main or game code."""
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
import hashlib
import json
import lzma
import shutil
import subprocess
import sys
import tempfile

EXPECTED_SHA256 = '9d7e27ea5caca6b6cb6361ec66ffb7f736272f4a901392ec4200044f30c5380d'
EXPECTED_COUNTS = {'v1': 7, 'v2': 11, 'v3': 13, 'v4': 17}
ROOT = Path(__file__).resolve().parent.parent
STAGING = ROOT / '.plan-transfer'

def main() -> None:
    compressed = b''.join((STAGING / f'{i:02d}.bin').read_bytes() for i in range(7))
    if len(compressed) != 80348 or hashlib.sha256(compressed).hexdigest() != EXPECTED_SHA256:
        raise ValueError('Planning source payload failed SHA-256 validation')
    decoder = lzma.LZMADecompressor()
    raw = decoder.decompress(compressed, max_length=2_000_001)
    if len(raw) > 2_000_000 or not decoder.eof or decoder.unused_data:
        raise ValueError('Invalid or oversized payload')
    files = json.loads(raw)
    if not isinstance(files, dict) or len(files) != 48:
        raise ValueError('Expected exactly 48 planning source files')
    entries = []
    counts = Counter()
    for name, text in sorted(files.items()):
        path = PurePosixPath(name)
        if (not isinstance(text, str) or path.is_absolute() or '..' in path.parts
                or '\\' in name or path.suffix not in {'.md', '.json', '.py'}):
            raise ValueError(f'Unsafe source entry: {name}')
        if len(path.parts) == 4 and path.parts[:3] == ('docs', 'plans', 'current'):
            version = 'v4'
        elif len(path.parts) == 5 and path.parts[:3] == ('docs', 'plans', 'archive') and path.parts[3] in {'v1', 'v2', 'v3'}:
            version = path.parts[3]
        else:
            raise ValueError(f'Unapproved destination: {name}')
        data = text.encode('utf-8')
        if path.suffix == '.json':
            json.loads(text)
        target = ROOT / name
        if target.exists() and target.read_bytes() != data:
            raise ValueError(f'Refusing to replace existing different file: {name}')
        entries.append({'path': name, 'version': version, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        counts[version] += 1
    if dict(counts) != EXPECTED_COUNTS:
        raise ValueError(f'Wrong version counts: {dict(counts)}')
    for entry in entries:
        target = ROOT / entry['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(files[entry['path']].encode('utf-8'))
        if hashlib.sha256(target.read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError(f'Write verification failed: {target}')
    # The supplied validator rewrites DOCUMENT_CHECKS.json and carries the old
    # date. Execute a temporary copy, keeping all original files unchanged.
    with tempfile.TemporaryDirectory(prefix='semekome-plan-check-') as tmp:
        check_root = Path(tmp) / 'current'
        shutil.copytree(ROOT / 'docs/plans/current', check_root)
        run = subprocess.run([sys.executable, str(check_root / 'validate_documents.py')], cwd=check_root, text=True, capture_output=True, check=True, timeout=60)
        report = json.loads(run.stdout)
    if report['document_checks'] != 46 or report['passed'] != 46 or report['failed']:
        raise ValueError(f'Document validation failed: {report}')
    for entry in entries:
        if hashlib.sha256((ROOT / entry['path']).read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError('Original changed during validation')
    manifest = {
        'imported_at_utc': datetime.now(timezone.utc).isoformat(),
        'scope': '48 original UTF-8 planning source files extracted from the four conversation archives; no content edits',
        'current_version': 'v4',
        'source_payload_sha256': EXPECTED_SHA256,
        'counts_by_version': dict(counts),
        'stored_original_formats': ['Markdown', 'JSON', 'Python document validator'],
        'not_stored_original_formats': ['four original PDF exports', 'four original ZIP packages'],
        'document_validation': report,
        'game_implemented': False,
        'game_acceptance_tests_executed': False,
        'iphone_device_test_executed': False,
        'files': entries,
    }
    (ROOT / 'docs/plans/IMPORT_MANIFEST.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'stored_source_files': len(entries), 'counts': dict(counts), 'document_validation': report}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
