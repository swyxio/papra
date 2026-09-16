"""Local Codex conversation projection; raw JSONL remains the lossless archive.

export_transcript(source_path, output_dir, metadata, max_chars=100_000) returns
a JSON-serializable manifest. Only user/assistant visible messages are projected.
No network access, credential access, or source modification is performed.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Iterator

ARTIFACT = "[Binary/image artifact omitted from conversation projection]"


class ExportError(ValueError):
    pass


def _records(source: Path) -> Iterator[tuple[int, dict]]:
    """Read bounded chunks, masking binary JSON strings before decoding records.

    json.loads never sees image/base64 data. Unlike readline or ijson string
    events, even a single multi-gigabyte image string stays bounded in memory.
    Non-binary text remains verbatim; malformed records fail without echoing data.
    """
    record: list[str] = []
    string: list[str] = []
    in_string = escaped = omit = False
    previous = last_string = ""
    line = 1
    with source.open("r", encoding="utf-8") as stream:
        while chunk := stream.read(65_536):
            index = 0
            while index < len(chunk):
                if in_string and omit and not escaped:
                    special = re.search(r'["\\]', chunk[index:])
                    if special is None:
                        break
                    index += special.start()
                char = chunk[index]
                index += 1
                if in_string:
                    if char == '"' and not escaped:
                        if omit:
                            record.append(json.dumps(ARTIFACT))
                            last_string = ARTIFACT
                        else:
                            encoded = '"' + ''.join(string) + '"'
                            record.append(encoded)
                            try:
                                last_string = json.loads(encoded)
                            except json.JSONDecodeError:
                                raise ExportError(f"Invalid JSON string at source line {line}") from None
                        in_string = False
                        string = []
                        previous = '"'
                        continue
                    if not omit:
                        string.append(char)
                        # Data URLs also occur in tool artifacts and older formats.
                        if len(string) == 11 and ''.join(string).lower().startswith(
                            ('data:image', 'data:audio', 'data:video')
                        ):
                            omit = True
                            string = []
                    if escaped:
                        escaped = False
                    elif char == '\\':
                        escaped = True
                    continue
                if char == '"':
                    in_string = True
                    escaped = False
                    # These fields carry binary artifacts, never conversation text.
                    omit = previous == ':' and last_string in {'image_url', 'base64', 'data', 'output', 'arguments'}
                    string = []
                elif char == '\n':
                    encoded = ''.join(record).strip()
                    if encoded:
                        try:
                            value = json.loads(encoded)
                        except json.JSONDecodeError:
                            raise ExportError(f"Invalid JSON record at source line {line}") from None
                        if not isinstance(value, dict):
                            raise ExportError(f"Non-object record at source line {line}")
                        yield line, value
                    record = []
                    previous = last_string = ''
                    line += 1
                else:
                    record.append(char)
                    if not char.isspace():
                        previous = char
        if in_string:
            raise ExportError(f"Unterminated JSON string at source line {line}")
        encoded = ''.join(record).strip()
        if encoded:
            try:
                value = json.loads(encoded)
            except json.JSONDecodeError:
                raise ExportError(f"Invalid JSON record at source line {line}") from None
            if not isinstance(value, dict):
                raise ExportError(f"Non-object record at source line {line}")
            yield line, value


def _message(message: dict) -> tuple[str, str, int] | None:
    role = message.get('role')
    if role not in ('user', 'assistant') or message.get('channel') == 'analysis' or message.get('phase') == 'analysis':
        return None
    content = message.get('content', message.get('text', ''))
    if isinstance(content, str):
        return role, content, 0
    if not isinstance(content, list):
        return None
    texts: list[str] = []
    artifacts = 0
    for item in content:
        if not isinstance(item, dict):
            artifacts += 1
            texts.append(ARTIFACT)
            continue
        kind = item.get('type', '')
        if kind in ('input_text', 'output_text', 'text') and isinstance(item.get('text'), str):
            texts.append(item['text'])
        elif kind not in ('analysis', 'reasoning'):
            artifacts += 1
            texts.append(ARTIFACT)
    return (role, '\n'.join(texts), artifacts) if texts else None


def _original(record: dict):
    payload = record.get('payload', {})
    if record.get('type') == 'response_item' and isinstance(payload, dict) and payload.get('type') == 'message':
        return _message(payload)
    return None


def _event(record: dict):
    payload = record.get('payload', {})
    if record.get('type') != 'event_msg' or not isinstance(payload, dict):
        return None
    kind = payload.get('type')
    if kind not in ('user_message', 'agent_message'):
        return None
    if payload.get('phase') == 'analysis' or payload.get('channel') == 'analysis':
        return None
    text = payload.get('message', '')
    if not isinstance(text, str):
        return None
    images = payload.get('images', [])
    artifacts = len(images) if isinstance(images, list) else int(bool(images))
    role = 'user' if kind == 'user_message' else 'assistant'
    return role, text + ('\n' + ARTIFACT) * artifacts, artifacts


def _fallback_history(record: dict):
    payload = record.get('payload', {})
    if not isinstance(payload, dict):
        return None
    if record.get('type') == 'compacted':
        history = payload.get('replacement_history')
        if isinstance(history, list):
            return 'compacted_replacement_history', history
        summary = payload.get('message')
        if isinstance(summary, str) and summary:
            return 'compacted_summary_only', [{'role': 'assistant', 'content': summary}]
    if record.get('type') == 'world_state' or 'world_state' in payload:
        state = payload.get('world_state', payload)
        if isinstance(state, dict):
            history = state.get('messages', state.get('conversation'))
            if isinstance(history, list):
                return 'world_state', history
    return None


class _Parts:
    def __init__(self, folder: Path, metadata: dict, max_chars: int):
        self.folder, self.metadata, self.limit = folder, metadata, max_chars
        self.parts: list[dict] = []
        self.handle = None
        self.characters = 0

    def _next(self):
        if self.handle:
            self.handle.close()
        number = len(self.parts) + 1
        header = f"# {self.metadata.get('title', 'Codex conversation')}\n\nPart {number}. Conversation projection; binary artifacts and tool output are omitted. Raw JSONL is the lossless source.\n\n```json\n{json.dumps(self.metadata, ensure_ascii=False, indent=2)}\n```\n\n"
        if len(header) >= self.limit:
            raise ExportError('Metadata header exceeds the part character limit')
        path = self.folder / f'conversation-{number:04d}.md'
        # Refuse overwrites; root owns source selection/staging directories.
        self.handle = os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf-8', newline='')
        self.handle.write(header)
        self.characters = len(header)
        self.parts.append({'filename': path.name, 'characters': self.characters})

    def write(self, text: str):
        offset = 0
        while offset < len(text):
            if self.handle is None or self.characters == self.limit:
                self._next()
            count = min(len(text) - offset, self.limit - self.characters)
            self.handle.write(text[offset:offset + count])
            self.characters += count
            self.parts[-1]['characters'] = self.characters
            offset += count

    def close(self):
        if self.handle:
            self.handle.close()


def export_transcript(source_path, output_dir, metadata: dict, max_chars: int = 100_000) -> dict:
    """Project a source to a dedicated private output directory, refusing overwrite.

    Metadata should include title/task_id/date/parent_id as available. Original
    message records win over duplicate events and all replacement summaries.
    Without originals, events win; otherwise the latest snapshot is projected.
    Two bounded passes allow this choice without retaining the conversation.
    """
    if not 1_000 <= max_chars <= 100_000:
        raise ExportError('max_chars must be between 1,000 and 100,000')
    source, folder = Path(source_path), Path(output_dir)
    def signature():
        stat = source.stat()
        return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns

    source_signature = signature()
    original_count = event_count = tool_records = compacted_records = records = 0
    instruction_records = analysis_records = 0
    fallback_line = None
    fallback_kind = None
    for line, record in _records(source):
        records += 1
        original_count += int(_original(record) is not None)
        event_count += int(_event(record) is not None)
        history = _fallback_history(record)
        if history:
            compacted_records += 1
            fallback_kind, fallback_line = history[0], line
        payload = record.get('payload', {})
        if record.get('type') == 'response_item' and isinstance(payload, dict):
            instruction_records += int(payload.get('role') in ('system', 'developer'))
            analysis_records += int(payload.get('type') == 'reasoning' or payload.get('channel') == 'analysis' or payload.get('phase') == 'analysis')
            if payload.get('type') not in ('message', 'reasoning') or payload.get('role') == 'tool':
                tool_records += 1
    if signature() != source_signature:
        raise ExportError('Source changed during projection selection; export an inactive snapshot')
    projection = 'response_item_messages' if original_count else 'event_messages' if event_count else fallback_kind or 'no_visible_messages'
    limitations = ['This Markdown projects visible conversation only; retain the raw JSONL for lossless logs, tool artifacts and binary content.']
    if compacted_records:
        limitations.append('Compaction/snapshot records exist. Original messages or events take precedence; earlier absent messages cannot be reconstructed losslessly from summaries.')
    if projection != 'response_item_messages':
        limitations.append(f'Original message history absent; projection uses {projection} and cannot prove complete original conversation coverage.')
    header_metadata = {**metadata, 'source': str(source.resolve()), 'projection': projection, 'limitations': limitations}
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    parts = _Parts(folder, header_metadata, max_chars)
    messages = artifacts = content_characters = 0
    try:
        for line, record in _records(source):
            candidates = []
            if original_count:
                candidates = [_original(record)]
            elif event_count:
                candidates = [_event(record)]
            elif line == fallback_line:
                history = _fallback_history(record)
                candidates = [_message(item) for item in history[1] if isinstance(item, dict)] if history else []
            for message in candidates:
                if message is None:
                    continue
                role, text, count = message
                timestamp = record.get('timestamp', '')
                parts.write(f"## {role.title()}" + (f" · {timestamp}" if timestamp else '') + '\n\n')
                parts.write(text)
                parts.write('\n\n')
                messages += 1
                artifacts += count
                content_characters += len(text)
        parts.write(f"\n[Omitted {tool_records} tool call/output records and {artifacts} message image/artifact blocks. System/developer instructions and assistant analysis are excluded.]\n")
    finally:
        parts.close()
    if signature() != source_signature:
        raise ExportError('Source changed during projection; output is incomplete and must not authorize source deletion')
    return {'source': str(source.resolve()), 'output_dir': str(folder.resolve()), 'metadata': metadata, 'projection': projection,
            'records': records, 'messages': messages, 'image_artifacts_omitted': artifacts,
            'content_characters': content_characters,
            'tool_records_omitted': tool_records, 'compaction_snapshot_records': compacted_records,
            'instruction_records_omitted': instruction_records, 'analysis_records_omitted': analysis_records,
            'duplicate_event_messages_omitted': event_count if original_count else 0,
            'limitations': limitations, 'parts': parts.parts}
