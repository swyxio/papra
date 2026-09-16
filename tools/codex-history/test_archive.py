import datetime as dt
import importlib.util
from pathlib import Path
import sqlite3
import os
import tempfile
import unittest
from unittest.mock import patch
import subprocess

spec = importlib.util.spec_from_file_location('archive', Path(__file__).with_name('archive.py'))
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


class ArchiveTest(unittest.TestCase):
    def setUp(self):
        self.open_files = patch.object(archive.subprocess, 'run', return_value=subprocess.CompletedProcess(['lsof'], 0, b'', b''))
        self.open_files.start()
        self.addCleanup(self.open_files.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'codex'
        (self.root / 'sessions').mkdir(parents=True)
        self.output = Path(self.temp.name) / 'output'
        self.output.mkdir()
        self.file = self.root / 'sessions' / 'example.jsonl'
        self.file.write_bytes(b'{"synthetic":"TEST ONLY"}\n')
        os.utime(self.file, (1, 1))
        self.db = sqlite3.connect(self.root / 'state_5.sqlite')
        self.db.executescript('CREATE TABLE threads(id TEXT,rollout_path TEXT,source TEXT,created_at INTEGER,updated_at INTEGER); CREATE TABLE thread_dynamic_tools(thread_id TEXT); CREATE TABLE thread_artifacts(thread_id TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT);')
        self.db.execute('INSERT INTO threads VALUES(?,?,?,?,?)', ('task', str(self.file), 'cli', 1, 1))
        self.db.commit()
        self.selection = dict(root=str(self.root), cutoff='2026-08-19T00:00:00+00:00', files=[dict(relative='sessions/example.jsonl', identity=archive.identity(self.file), task_id='task', kind='main', month='2026-01', metadata={'id':'task'})], related={})
        self.records = archive.pack(self.selection, self.output)
        record = self.records[0]
        self.receipt = dict(all_uploads_verified=True, metadata_verified=True, archives={record['name']:dict(primary_sha256=record['sha256'], backup_sha256=record['sha256'], contents_verified=True)})

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_restored_archive_contains_original_bytes_before_deletion(self):
        record = self.records[0]
        archive.verify_archive(record['path'], record)
        result = archive.delete_verified(self.selection, self.records, self.receipt, self.output)
        self.assertEqual(len(result['deleted']), 1)
        self.assertFalse(self.file.exists())

    def test_missing_backup_or_content_verification_prevents_all_deletion(self):
        for key in ('backup_sha256', 'contents_verified'):
            proof = self.receipt['archives'][self.records[0]['name']]
            saved = proof.pop(key)
            with self.assertRaises(ValueError):
                archive.delete_verified(self.selection, self.records, self.receipt, self.output)
            self.assertTrue(self.file.exists())
            proof[key] = saved

    def test_resumed_task_is_retained_even_when_file_bytes_are_unchanged(self):
        self.db.execute('UPDATE threads SET updated_at=?', (int(dt.datetime.now(dt.timezone.utc).timestamp()),))
        self.db.commit()
        result = archive.delete_verified(self.selection, self.records, self.receipt, self.output)
        self.assertEqual(len(result['retained']), 1)
        self.assertTrue(self.file.exists())

    def test_modified_file_is_retained(self):
        self.file.write_bytes(b'New activity')
        result = archive.delete_verified(self.selection, self.records, self.receipt, self.output)
        self.assertEqual(len(result['retained']), 1)
        self.assertTrue(self.file.exists())

    def test_corrupt_archive_cannot_verify(self):
        record = self.records[0]
        Path(record['path']).write_bytes(b'broken')
        with self.assertRaises(ValueError):
            archive.verify_archive(record['path'], record)

    def test_open_task_is_retained(self):
        with patch.object(archive.subprocess, 'run', return_value=subprocess.CompletedProcess(['lsof'], 0, ('n'+str(self.file)+'\n').encode(), b'')):
            result = archive.delete_verified(self.selection, self.records, self.receipt, self.output)
        self.assertEqual(len(result['retained']), 1)
        self.assertTrue(self.file.exists())

    def test_recent_snapshot_is_retained_even_if_database_is_old(self):
        self.records[0]['files'][0]['identity']['mtime_ns'] = int(dt.datetime.now(dt.timezone.utc).timestamp()*1e9)
        self.selection['files'][0]['identity'] = self.records[0]['files'][0]['identity']
        result = archive.delete_verified(self.selection, self.records, self.receipt, self.output)
        self.assertEqual(len(result['retained']), 1)
        self.assertTrue(self.file.exists())

    def test_incomplete_selection_coverage_prevents_deletion(self):
        self.selection['files'].append({**self.selection['files'][0], 'relative': 'sessions/other.jsonl'})
        with self.assertRaises(ValueError):
            archive.delete_verified(self.selection, self.records, self.receipt, self.output)
        self.assertTrue(self.file.exists())

    def test_paths_outside_session_roots_are_rejected(self):
        for path in ('sessions/../../outside.jsonl', 'sessions/../worktrees/project.jsonl', 'worktrees/project.jsonl', '/tmp/outside.jsonl'):
            with self.assertRaises(ValueError):
                archive.safe_source(self.root, path)


if __name__ == '__main__':
    unittest.main()
