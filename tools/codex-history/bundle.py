"""Bundle search projections below the application's text and chunk limits."""
import json
from pathlib import Path
import sys
from archive import write_json

stage = Path(sys.argv[1])
selection = json.loads((stage/'selection.json').read_text())
transcripts = json.loads((stage/'transcripts.json').read_text())
archives = json.loads((stage/'archives.json').read_text())
archive_for = {item['relative']: record['name'] for record in archives for item in record['files']}
uploads = json.loads((stage/'upload-state.json').read_text()) if (stage/'upload-state.json').exists() else {'assets': {}}
output = stage/'search-documents';output.mkdir(mode=0o700,exist_ok=True)
records=[]
MAX=120000

def units(text):return len(text.encode('utf-16-le'))//2

def chunks(text):
    current=[];count=0
    for char in text:
        size=2 if ord(char)>65535 else 1
        if count+size>MAX-1000:
            yield ''.join(current);current=[];count=0
        current.append(char);count+=size
    if current:yield ''.join(current)

for kind in ('main','subagent','unindexed'):
    buffer='';ids=set();months=set();number=0
    def flush():
        global buffer,ids,months,number
        if not buffer:return
        number+=1
        name=f'Codex-{kind}-{number:04d}.md';target=output/name
        target.write_text(buffer,encoding='utf-8');target.chmod(0o600)
        records.append({'name':name,'path':str(target),'kind':kind,'task_ids':sorted(ids),'months':sorted(months),'utf16_units':units(buffer),'bytes':target.stat().st_size})
        buffer='';ids=set();months=set()
    for item in selection['files']:
        if item['kind']!=kind:continue
        projection=transcripts[item['relative']]
        if 'error' in projection:raise ValueError('A task projection failed')
        if not projection['messages']:continue
        archive_name=archive_for[item['relative']]
        asset=uploads['assets'].get(archive_name)
        archive_link=f"[{archive_name}](https://drive.swyx.io/orgs/swyx/documents/{asset['documentId']})" if asset and asset.get('complete') else archive_name
        prefix=f"\n\n---\n\n# Codex task {item['task_id']}\n\nLossless archive: {archive_link}\n\n"
        for part in projection['parts']:
            text=(Path(projection['output_dir'])/part['filename']).read_text()
            for chunk in chunks(text):
                value=prefix+chunk
                if units(buffer)+units(value)>MAX:flush()
                buffer+=value;ids.add(item['task_id']);months.add(item['month'])
    flush()
write_json(stage/'search-documents.json',records)
print(json.dumps({'search_documents':len(records),'bytes':sum(r['bytes'] for r in records),'tasks_with_visible_messages':sum(v.get('messages',0)>0 for v in transcripts.values()),'projection_errors':sum('error' in v for v in transcripts.values())}))
