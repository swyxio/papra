import importlib.util
import json
from pathlib import Path
import tempfile
import tracemalloc
import unittest

spec = importlib.util.spec_from_file_location('transcripts', Path(__file__).with_name('transcripts.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def response(role, content, **kwargs):
    return {'type': 'response_item', 'timestamp': '2026-01-01T00:00:00Z',
            'payload': {'type': 'message', 'role': role, 'content': content, **kwargs}}


class TranscriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.source = self.folder / 'synthetic.jsonl'
        self.output = self.folder / 'output'

    def tearDown(self):
        self.temp.cleanup()

    def export(self, records, **kwargs):
        self.source.write_text('\n'.join(json.dumps(r, ensure_ascii=False) for r in records), encoding='utf-8')
        return module.export_transcript(self.source, self.output, {'title': 'Synthetic task', 'task_id': 'task-test', 'date': '2026-01-01', 'parent_id': 'parent-test'}, **kwargs)

    def text(self):
        return ''.join(p.read_text(encoding='utf-8') for p in sorted(self.output.glob('*.md')))

    def test_visible_messages_no_duplicate_events_or_private_instructions(self):
        manifest = self.export([
            response('system', 'EXCLUDED_SYSTEM'), response('developer', 'EXCLUDED_DEVELOPER'),
            response('user', [{'type': 'input_text', 'text': 'Hello 世界'}]),
            {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'Hello 世界'}},
            response('assistant', 'EXCLUDED_ANALYSIS', channel='analysis'),
            response('assistant', [{'type': 'output_text', 'text': 'Visible answer'}]),
            {'type': 'response_item', 'payload': {'type': 'function_call_output', 'output': 'EXCLUDED_TOOL'}},
        ])
        self.assertEqual(manifest['messages'], 2)
        self.assertEqual(manifest['tool_records_omitted'], 1)
        text = self.text()
        self.assertEqual(text.count('Hello 世界'), 1)
        self.assertIn('Visible answer', text)
        self.assertNotIn('EXCLUDED_', text)
        self.assertIn('parent-test', text)

    def test_image_message_preserves_text_before_and_after(self):
        manifest = self.export([response('user', [
            {'type': 'input_text', 'text': 'Before image'},
            {'type': 'input_image', 'image_url': 'data:image/png;base64,AAA'},
            {'type': 'input_text', 'text': 'After image'},
        ])])
        self.assertEqual(manifest['messages'], 1)
        self.assertEqual(manifest['image_artifacts_omitted'], 1)
        self.assertIn('Before image', self.text())
        self.assertIn('After image', self.text())
        self.assertNotIn('base64,AAA', self.text())

    def test_unicode_large_message_parts_preserve_all_characters(self):
        message = 'こんにちは🙂é\\"\n' * 30_000
        manifest = self.export([response('user', message)])
        body = ''.join(p.read_text(encoding='utf-8').split('\n```\n\n', 1)[1] for p in sorted(self.output.glob('*.md')))
        self.assertIn(message, body)
        self.assertGreater(len(manifest['parts']), 2)
        for part in manifest['parts']:
            actual = (self.output / part['filename']).read_text(encoding='utf-8')
            self.assertLessEqual(len(actual), 100_000)
            self.assertEqual(len(actual), part['characters'])
            self.assertEqual((self.output / part['filename']).stat().st_mode & 0o777, 0o600)

    def test_compaction_is_not_duplicated_if_originals_exist(self):
        manifest = self.export([
            response('user', 'Original message'),
            {'type': 'compacted', 'payload': {'replacement_history': [{'role': 'user', 'content': 'Original message'}]}},
        ])
        self.assertEqual(self.text().count('Original message\n\n'), 1)
        self.assertEqual(manifest['projection'], 'response_item_messages')
        self.assertEqual(manifest['compaction_snapshot_records'], 1)

    def test_events_fallback_reports_coverage_limitation(self):
        manifest = self.export([
            {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'Event question', 'images': ['data:image/png;base64,AAA']}},
            {'type': 'event_msg', 'payload': {'type': 'agent_message', 'message': 'Event answer'}},
        ])
        self.assertEqual(manifest['projection'], 'event_messages')
        self.assertEqual(manifest['messages'], 2)
        self.assertEqual(manifest['image_artifacts_omitted'], 1)
        self.assertTrue(any('coverage' in item for item in manifest['limitations']))

    def test_latest_compacted_history_used_once(self):
        manifest = self.export([
            {'type': 'compacted', 'payload': {'replacement_history': [{'role': 'user', 'content': 'OLD_SNAPSHOT'}]}},
            {'type': 'compacted', 'payload': {'replacement_history': [{'role': 'user', 'content': 'Retained question'}, {'role': 'assistant', 'content': 'Retained answer'}]}},
        ])
        self.assertEqual(manifest['projection'], 'compacted_replacement_history')
        self.assertEqual(manifest['messages'], 2)
        self.assertNotIn('OLD_SNAPSHOT', self.text())

    def test_world_state_and_summary_fallback(self):
        manifest = self.export([{'type': 'world_state', 'payload': {'messages': [{'role': 'user', 'content': 'Older question'}]}}])
        self.assertEqual(manifest['projection'], 'world_state')
        self.assertIn('Older question', self.text())

    def test_summary_only_is_explicitly_limited(self):
        manifest = self.export([{'type': 'compacted', 'payload': {'message': 'Only a synthetic summary survives'}}])
        self.assertEqual(manifest['projection'], 'compacted_summary_only')
        self.assertTrue(any('cannot prove complete' in item for item in manifest['limitations']))
        self.assertIn('Only a synthetic summary survives', self.text())

    def test_invalid_record_fails_without_echoing_raw_text(self):
        self.source.write_text('{"private":"NEVER_ECHO", bad}\n', encoding='utf-8')
        with self.assertRaises(module.ExportError) as caught:
            module.export_transcript(self.source, self.output, {})
        self.assertNotIn('NEVER_ECHO', str(caught.exception))
        self.assertFalse(self.output.exists())

    def test_existing_output_refuses_overwrite(self):
        self.export([response('user', 'First export')])
        before = self.text()
        with self.assertRaises(FileExistsError):
            module.export_transcript(self.source, self.output, {})
        self.assertEqual(self.text(), before)

    def test_huge_image_record_is_memory_bounded_and_retains_message(self):
        with self.source.open('w', encoding='utf-8') as stream:
            stream.write('{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Adjacent before"},{"type":"input_image","image_url":"data:image/png;base64,')
            block = 'A' * 65_536
            for _ in range(512):
                stream.write(block)
            stream.write('"},{"type":"input_text","text":"Adjacent after"}]}}\n')
        tracemalloc.start()
        manifest = module.export_transcript(self.source, self.output, {'title': 'Large synthetic image'})
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        self.assertLess(peak, 5_000_000)
        self.assertEqual(manifest['messages'], 1)
        self.assertIn('Adjacent before', self.text())
        self.assertIn('Adjacent after', self.text())


if __name__ == '__main__':
    unittest.main()
