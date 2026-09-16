"""Project selected logs locally, preserving a resumable per-task manifest."""
import json
from pathlib import Path
import sys
from archive import write_json
from transcripts import export_transcript

folder = Path(sys.argv[1])
selection = json.loads((folder / 'selection.json').read_text())
manifest_path = folder / 'transcripts.json'
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
for index, item in enumerate(selection['files']):
    key = item['relative']
    if key in manifest:
        continue
    metadata = item['metadata']
    target = folder / 'transcripts' / item['task_id']
    # Failed partial projections may be removed; originals are never modified here.
    if target.exists():
        for path in target.glob('conversation-*.md'):
            path.unlink()
    try:
        result = export_transcript(Path(selection['root']) / key, target, {
            'task_id': item['task_id'], 'title': metadata.get('title', 'Codex task')[:400],
            'kind': item['kind'], 'created_at': metadata.get('created_at'),
            'updated_at': metadata.get('updated_at'), 'project': metadata.get('cwd'),
            'raw_source': key,
        }, max_chars=100000)
        manifest[key] = result
    except ValueError as error:
        manifest[key] = {'error': str(error), 'task_id': item['task_id'], 'parts': []}
    write_json(manifest_path, manifest)
    if index % 50 == 0 or index + 1 == len(selection['files']):
        print(json.dumps({'projected': index + 1, 'total': len(selection['files']), 'errors': sum('error' in v for v in manifest.values())}), flush=True)
