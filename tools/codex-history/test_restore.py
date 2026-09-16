import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from archive import identity, pack

class RestoreTest(unittest.TestCase):
    def test_verified_restore_and_refusal_to_overwrite_different_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)/'codex';(root/'sessions').mkdir(parents=True)
            source=root/'sessions'/'task.jsonl';original=b'{"message":"TEST ONLY"}\n';source.write_bytes(original)
            destination=Path(temporary)/'archives';destination.mkdir()
            selection={'root':str(root),'cutoff':'2026-08-19T00:00:00+00:00','files':[{'relative':'sessions/task.jsonl','identity':identity(source),'task_id':'task','kind':'main','month':'2026-01','metadata':{'id':'task'}}],'related':{}}
            records=pack(selection,destination)
            command=[sys.executable,str(Path(__file__).with_name('restore.py')),'--archive',records[0]['path'],'--manifest',str(destination/'archives.json'),'--task-id','task','--root',str(root)]
            source.unlink()
            result=subprocess.run(command,capture_output=True)
            self.assertEqual(result.returncode,0)
            self.assertEqual(source.read_bytes(),original)
            source.write_bytes(b'Resumed content')
            result=subprocess.run(command,capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(source.read_bytes(),b'Resumed content')

if __name__=='__main__':unittest.main()
