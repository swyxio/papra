"""Lossless, checksummed cold-storage archives of inactive Codex session logs."""
import argparse
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import tarfile


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False))
    temporary.chmod(0o600)
    temporary.replace(path)


def sha256(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def identity(path):
    info = Path(path).lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('Session must be a regular file, not a symlink')
    return {key: getattr(info, 'st_' + key) for key in ('dev', 'ino', 'size', 'mtime_ns')}


def safe_source(root, relative):
    root = Path(root).resolve()
    path = root / relative
    parts = Path(relative).parts
    if not parts or Path(relative).is_absolute() or '..' in parts or parts[0] not in ('sessions', 'archived_sessions') or not str(relative).endswith('.jsonl'):
        raise ValueError('Only Codex session JSONL files are deletion targets')
    if not path.resolve().is_relative_to(root / parts[0]) or path.is_symlink():
        raise ValueError('Session path escapes authorized root')
    return path


def connection(root):
    result = sqlite3.connect('file:' + str(Path(root) / 'state_5.sqlite') + '?mode=ro', uri=True)
    result.row_factory = sqlite3.Row
    return result


def plan(root, destination, now=None):
    root = Path(root).resolve()
    now = now or dt.datetime.now(dt.timezone.utc)
    cutoff = (now - dt.timedelta(weeks=4)).timestamp()
    database = connection(root)
    threads = {Path(row['rollout_path']).name: dict(row) for row in database.execute('SELECT * FROM threads')}
    files = []
    for path in sorted(list((root / 'sessions').rglob('*.jsonl')) + list((root / 'archived_sessions').rglob('*.jsonl'))):
        relative = str(path.relative_to(root))
        safe_source(root, relative)
        snapshot = identity(path)
        thread = threads.get(path.name)
        if thread:
            if max(thread['created_at'], thread['updated_at'], snapshot['mtime_ns'] / 1e9) >= cutoff:
                continue
            task_id = thread['id']
            try:
                kind = 'subagent' if 'subagent' in json.loads(thread['source']) else 'main'
            except (ValueError, TypeError):
                kind = 'main'
        else:
            if snapshot['mtime_ns'] / 1e9 >= cutoff:
                continue
            with path.open('rb') as stream:
                first = stream.readline(1024 * 1024)
            header = json.loads(first)
            if header.get('type') != 'session_meta':
                raise ValueError('Unindexed session has no reliable metadata')
            created = dt.datetime.fromisoformat(header['timestamp'].replace('Z', '+00:00')).timestamp()
            if created >= cutoff:
                continue
            payload = header['payload']
            task_id = payload['id']
            thread = {key: payload.get(key) for key in ('id', 'cwd', 'source', 'originator')}
            thread.update(created_at=created, updated_at=snapshot['mtime_ns'] / 1e9, title='Unindexed Codex task')
            kind = 'unindexed'
        month = dt.datetime.fromtimestamp(thread['created_at'], dt.timezone.utc).strftime('%Y-%m')
        files.append(dict(relative=relative, identity=snapshot, task_id=task_id, kind=kind, month=month, metadata=thread))
    ids = {item['task_id'] for item in files}
    related = {}
    for table in ('thread_dynamic_tools', 'thread_artifacts', 'thread_spawn_edges'):
        selected = []
        for row in database.execute('SELECT * FROM ' + table):
            value = dict(row)
            if value.get('thread_id') in ids or value.get('parent_thread_id') in ids or value.get('child_thread_id') in ids:
                selected.append(value)
        related[table] = selected
    database.close()
    value = dict(format=1, root=str(root), created_at=now.isoformat(), cutoff=dt.datetime.fromtimestamp(cutoff, dt.timezone.utc).isoformat(), files=files, related=related)
    write_json(Path(destination) / 'selection.json', value)
    return value


class HashReader:
    def __init__(self, stream):
        self.stream = stream
        self.hash = hashlib.sha256()
    def read(self, size=-1):
        value = self.stream.read(size)
        self.hash.update(value)
        return value


def pack(selection, destination, max_raw=512 * 1024 ** 2):
    destination = Path(destination)
    groups = []
    current = []
    total = 0
    for item in selection['files']:
        if current and (total + item['identity']['size'] > max_raw or current[0]['month'] != item['month']):
            groups.append(current)
            current, total = [], 0
        current.append(item)
        total += item['identity']['size']
    if current:
        groups.append(current)
    archives = []
    for index, items in enumerate(groups):
        name = f"codex-{items[0]['month']}-{index + 1:03d}.tar.gz"
        target = destination / name
        included = []
        with tarfile.open(target, 'w:gz', compresslevel=1) as archive:
            for item in items:
                source = safe_source(selection['root'], item['relative'])
                if identity(source) != item['identity']:
                    raise ValueError('Session changed before archival')
                info = tarfile.TarInfo('logs/' + item['relative'])
                info.size = item['identity']['size']
                info.mode = 0o600
                info.mtime = item['identity']['mtime_ns'] // 10 ** 9
                with source.open('rb') as stream:
                    reader = HashReader(stream)
                    archive.addfile(info, reader)
                if identity(source) != item['identity']:
                    raise ValueError('Session changed while archiving')
                item = {**item, 'sha256': reader.hash.hexdigest()}
                included.append(item)
            metadata = json.dumps(dict(cutoff=selection['cutoff'], files=included), ensure_ascii=False).encode()
            info = tarfile.TarInfo('manifest.json')
            info.size = len(metadata)
            info.mode = 0o600
            archive.addfile(info, io.BytesIO(metadata))
        target.chmod(0o600)
        record = dict(name=name, path=str(target), bytes=target.stat().st_size, sha256=sha256(target), files=included)
        verify_archive(target, record)
        archives.append(record)
        write_json(destination / 'archives.json', archives)
        print(json.dumps(dict(archive=index + 1, total_archives=len(groups), files=len(items), compressed_bytes=record['bytes'])), flush=True)
    write_json(destination / 'task-metadata.json', dict(cutoff=selection['cutoff'], threads=[item['metadata'] for item in selection['files']], related=selection['related']))
    return archives


def verify_archive(path, record):
    if Path(path).stat().st_size != record['bytes'] or sha256(path) != record['sha256']:
        raise ValueError('Compressed archive hash or size mismatch')
    expected = {'logs/' + item['relative']: item for item in record['files']}
    seen = set()
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive:
            if member.name == 'manifest.json':
                continue
            if member.name not in expected or member.name in seen or not member.isfile():
                raise ValueError('Unexpected archive member')
            stream = archive.extractfile(member)
            reader = HashReader(stream)
            count = 0
            while block := reader.read(1024 * 1024):
                count += len(block)
            item = expected[member.name]
            if count != item['identity']['size'] or reader.hash.hexdigest() != item['sha256']:
                raise ValueError('Original session content mismatch')
            seen.add(member.name)
    if seen != set(expected):
        raise ValueError('Archive is missing sessions')


def delete_verified(selection, archives, receipt, destination):
    if not receipt.get('all_uploads_verified') or not receipt.get('metadata_verified'):
        raise ValueError('Cloud verification is not complete')
    expected_names = {item['name'] for item in archives}
    verified = receipt.get('archives', {})
    if set(verified) != expected_names:
        raise ValueError('Not every archive has a verification receipt')
    for item in archives:
        proof = verified[item['name']]
        if proof.get('primary_sha256') != item['sha256'] or proof.get('backup_sha256') != item['sha256'] or not proof.get('contents_verified'):
            raise ValueError('Archive needs full primary, backup and contents verification')
    selected = {item['relative']: item for item in selection['files']}
    included = [item for record in archives for item in record['files']]
    if len(included) != len(selected) or {item['relative'] for item in included} != set(selected):
        raise ValueError('Archives must exactly cover the frozen selection')
    for item in included:
        original = selected[item['relative']]
        if item['identity'] != original['identity'] or item['task_id'] != original['task_id']:
            raise ValueError('Archive selection metadata mismatch')
    cutoff = dt.datetime.fromisoformat(selection['cutoff']).timestamp()
    open_files = set()
    try:
        result = subprocess.run(['lsof', '-nP', '-F', 'n'], capture_output=True, timeout=30, check=False)
        open_files = {str(Path(line[1:].decode(errors='replace')).resolve()) for line in result.stdout.splitlines() if line.startswith(b'n/')}
    except (FileNotFoundError, subprocess.TimeoutExpired):
        raise ValueError('Cannot confirm selected session files are closed') from None
    database = connection(selection['root'])
    deleted, retained = [], []
    for archive in archives:
        for item in archive['files']:
            source = safe_source(selection['root'], item['relative'])
            if not source.exists():
                retained.append(dict(relative=item['relative'], reason='already missing'))
                continue
            row = database.execute('SELECT created_at,updated_at FROM threads WHERE id=?', (item['task_id'],)).fetchone()
            if str(source) in open_files or item['identity']['mtime_ns'] / 1e9 >= cutoff or (row and max(row['created_at'], row['updated_at']) >= cutoff) or identity(source) != item['identity'] or sha256(source) != item['sha256']:
                retained.append(dict(relative=item['relative'], reason='changed or resumed since selection'))
                continue
            # Recheck stat after hashing; only frozen regular files beneath the session roots are removed.
            if identity(source) != item['identity']:
                retained.append(dict(relative=item['relative'], reason='changed while checking'))
                continue
            source.unlink()
            deleted.append(dict(relative=item['relative'], bytes=item['identity']['size'], sha256=item['sha256']))
            write_json(Path(destination) / 'deletion-receipt.json', dict(deleted=deleted, retained=retained))
    database.close()
    result = dict(deleted=deleted, retained=retained)
    write_json(Path(destination) / 'deletion-receipt.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=('plan', 'pack', 'verify', 'delete'))
    parser.add_argument('--root', default='/Users/swyx/.codex')
    parser.add_argument('--destination', required=True)
    parser.add_argument('--archive')
    args = parser.parse_args()
    destination = Path(args.destination)
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.command == 'plan':
        value = plan(args.root, destination)
        print(json.dumps(dict(files=len(value['files']), bytes=sum(x['identity']['size'] for x in value['files']), cutoff=value['cutoff'])))
    elif args.command == 'pack':
        pack(json.loads((destination / 'selection.json').read_text()), destination)
    elif args.command == 'verify':
        records = json.loads((destination / 'archives.json').read_text())
        record = next(x for x in records if x['name'] == Path(args.archive).name)
        verify_archive(args.archive, record)
        print(json.dumps(dict(archive=record['name'], contents_verified=True)))
    else:
        result = delete_verified(json.loads((destination / 'selection.json').read_text()), json.loads((destination / 'archives.json').read_text()), json.loads((destination / 'verification-receipt.json').read_text()), destination)
        print(json.dumps(dict(deleted=len(result['deleted']), retained=len(result['retained']), bytes=sum(x['bytes'] for x in result['deleted']))))
