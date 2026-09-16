"""Restore one archived task after verifying the entire downloaded archive."""
import argparse
import json
from pathlib import Path
import os
import tarfile
from archive import safe_source, sha256, verify_archive

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--archive', required=True)
parser.add_argument('--manifest', required=True, help='Downloaded archives.json')
parser.add_argument('--task-id', required=True)
parser.add_argument('--root', default=str(Path.home()/'.codex'))
args = parser.parse_args()
records = json.loads(Path(args.manifest).read_text())
record = next(item for item in records if item['name'] == Path(args.archive).name)
verify_archive(args.archive, record)
items = [item for item in record['files'] if item['task_id'] == args.task_id]
if not items:
    raise ValueError('Task is not present in this archive')
with tarfile.open(args.archive, 'r:gz') as archive:
    for item in items:
        target = safe_source(args.root, item['relative'])
        if target.exists():
            if sha256(target) != item['sha256']:
                raise ValueError('Refusing to overwrite a different or resumed local task')
            continue
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Revalidate after creating parents; no symlink parent may escape session roots.
        safe_source(args.root, item['relative'])
        with target.open('xb') as output:
            os.chmod(target, 0o600)
            source = archive.extractfile('logs/'+item['relative'])
            while block := source.read(1024*1024):
                output.write(block)
        if sha256(target) != item['sha256']:
            target.unlink()
            raise ValueError('Restored task checksum mismatch')
        os.utime(target, ns=(item['identity']['mtime_ns'], item['identity']['mtime_ns']))
print(json.dumps({'restored_task': args.task_id, 'files': len(items)}))
