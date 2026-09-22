"""Convert downloaded Atlas DOCX forms into private native-editor templates.

Usage: bundled-python prepare-atlas-templates.py DIRECTORY
DIRECTORY contains sources.json and originals/. No template wording is committed.
Originals and drafting guidance remain available alongside the editable agreement.
"""
import hashlib, json, re, sys
from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET

# Labels follow the placeholders in each archived Atlas source, preserving field IDs.
FIELD_LABELS = {'mutual-nda': ['Effective date',
                'Counterparty name',
                'Discussion purpose',
                'Company confidential information scope',
                'Counterparty confidential information scope',
                'Jurisdiction county',
                'Company address line 1',
                'Company address line 2',
                'Company address line 3'],
 'offer-letter': ['Company address line 1',
                  'Company address line 2',
                  'Company address line 3',
                  'Greeting name',
                  'Primary duties',
                  'Starting compensation',
                  'Number of shares',
                  'Offer expiration date',
                  'Latest start date'],
 'advisor-agreement': ['Number of shares',
                       'Advisor term',
                       'Company address line 1',
                       'Company address line 2',
                       'Company address line 3',
                       'Company fax',
                       'Advisor address line 1',
                       'Advisor address line 2',
                       'Advisor address line 3',
                       'Advisor fax',
                       'Advisor email'],
 'consulting-individual': ['Consultant name',
                           'Effective date',
                           'Time commitment (%)',
                           'Hours per week',
                           'Expense approval threshold ($)',
                           'Consulting start date',
                           'Termination notice (business days)',
                           'Breach cure period (business days)',
                           'Governing law state',
                           'Company address line 1',
                           'Company address line 2',
                           'Company address line 3',
                           'Hourly rate ($)',
                           'Payment schedule',
                           'Maximum consulting fees ($)',
                           'Upfront payment ($)',
                           'Completion payment ($)',
                           'Number of option shares'],
 'consulting-company': ['Consultant name',
                        'Effective date',
                        'Time commitment (%)',
                        'Hours per week',
                        'Expense approval threshold ($)',
                        'Consulting start date',
                        'Termination notice (business days)',
                        'Breach cure period (business days)',
                        'Governing law state',
                        'Company address line 1',
                        'Company address line 2',
                        'Company address line 3',
                        'Hourly rate ($)',
                        'Payment schedule',
                        'Maximum consulting fees ($)',
                        'Upfront payment ($)',
                        'Completion payment ($)',
                        'Number of option shares'],
 'consultant-assignment-individual': ['Consultant name',
                                      'Effective date',
                                      'Governing law state',
                                      'Company address line 1',
                                      'Company address line 2',
                                      'Company address line 3',
                                      'No prior agreements checkbox'],
 'consultant-assignment-company': ['Consultant name',
                                   'Effective date',
                                   'Governing law state',
                                   'Company address line 1',
                                   'Company address line 2',
                                   'Company address line 3',
                                   'No prior agreements checkbox'],
 'bylaw-certification': ['Director adoption date',
                         'Director 1 execution date',
                         'Director 1 signature line',
                         'Director 2 execution date',
                         'Director 2 signature line',
                         'Director 3 execution date',
                         'Director 3 signature line',
                         'Secretary adoption date',
                         'Secretary execution date']}

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
def val(el, path, default=None):
    found = el.find(path) if el is not None else None
    return found.get(W+'val', default) if found is not None else default

def text(el):
    return ''.join(n.text or '' for n in el.iter(W+'t'))

def prepare(item, directory):
    path = directory/'originals'/item['originalFile']
    if path.suffix != '.docx': return None
    with ZipFile(path) as z:
        body = ET.fromstring(z.read('word/document.xml')).find(W+'body')
        styles = ET.fromstring(z.read('word/styles.xml'))
        stylemap = {s.get(W+'styleId'):s for s in styles.findall(W+'style')}
        numbering = ET.fromstring(z.read('word/numbering.xml'))
        abstract = {n.get(W+'abstractNumId'):n for n in numbering.findall(W+'abstractNum')}
        numbers = {n.get(W+'numId'):n for n in numbering.findall(W+'num')}
        counters = {}
        def numbered(p):
            num = p.find(W+'pPr/'+W+'numPr')
            sid=val(p,W+'pPr/'+W+'pStyle')
            visited=set()
            while num is None and sid in stylemap and sid not in visited:
                visited.add(sid);s=stylemap[sid];num=s.find(W+'pPr/'+W+'numPr');sid=val(s,W+'basedOn')
            if num is None:return ''
            nid=val(num,W+'numId');level=int(val(num,W+'ilvl','0'))
            if nid not in numbers:return ''
            a=abstract[val(numbers[nid],W+'abstractNumId')]
            levels={int(n.get(W+'ilvl')):n for n in a.findall(W+'lvl')}
            cfg=levels[level];state=counters.setdefault(nid,{})
            override=numbers[nid].find(f'{W}lvlOverride[@{W}ilvl="{level}"]')
            start=int(val(override,W+'startOverride',val(cfg,W+'start','1')))
            state[level]=state.get(level,start-1)+1
            for deeper in list(state):
                if deeper>level:del state[deeper]
            def fmt(n,kind):
                if kind=='bullet':return '•'
                if kind in ['upperLetter','lowerLetter']:
                    result='';
                    while n:n,rem=divmod(n-1,26);result=chr(97+rem)+result
                    return result.upper() if kind=='upperLetter' else result
                if kind in ['upperRoman','lowerRoman']:
                    result=''
                    for v,s in [(1000,'M'),(900,'CM'),(500,'D'),(400,'CD'),(100,'C'),(90,'XC'),(50,'L'),(40,'XL'),(10,'X'),(9,'IX'),(5,'V'),(4,'IV'),(1,'I')]:
                        while n>=v:result+=s;n-=v
                    return result if kind=='upperRoman' else result.lower()
                return str(n)
            if val(cfg,W+'numFmt')=='bullet':return '• '
            label=val(cfg,W+'lvlText','%1.')
            return re.sub(r'%(\d)',lambda m:fmt(state.get(int(m[1])-1,int(val(levels.get(int(m[1])-1),W+'start','1'))),val(levels.get(int(m[1])-1),W+'numFmt','decimal')),label)+' '
        children=list(body)
        start=next((i for i,p in enumerate(children) if text(p).strip() in ['[Company Name]','{COMPANY_NAME}']),None)
        if start is None:
            # The bylaw certification starts at its certificate heading.
            start=next(i for i,p in enumerate(children) if text(p).startswith('CERTIFICATE OF ADOPTION'))
        guidance='\n'.join(text(p) for p in children[:start])
        for name in ['word/footnotes.xml','word/endnotes.xml','word/comments.xml']:
            if name in z.namelist():
                extra=ET.fromstring(z.read(name));notes=[text(n) for n in extra if int(n.get(W+'id','0'))>0]
                if notes:guidance+='\n\nDrafting notes\n'+'\n'.join(notes)
        fields=[];named={};occurrence=0
        # Only simple data placeholders become fields. Clause choices stay in the editor.
        pattern=re.compile(r'\{[A-Z][A-Z_ ]+\}|\[[A-Z][A-Za-z0-9’\' ]{1,55}\]|_{3,}')
        def paragraph(p):
            nonlocal occurrence
            plain=text(p)
            runpieces=[]
            for r in p.iter(W+'r'):
                marks=[]
                for prop,mark in [('b','bold'),('i','italic'),('u','underline')]:
                    v=r.find(W+'rPr/'+W+prop)
                    if v is not None and v.get(W+'val') not in ['0','false','none']:marks.append({'type':mark})
                for child in r:
                    if child.tag==W+'t' and child.text:runpieces.append((child.text,marks))
                    elif child.tag in [W+'br',W+'cr'] and child.get(W+'type')!='page':runpieces.append(('\n',marks))
                    elif child.tag==W+'tab':runpieces.append(('  ',marks))
            full=''.join(s for s,_ in runpieces);stylechars=[marks for s,marks in runpieces for _ in s]
            replacements=[]
            for m in pattern.finditer(full):
                token=m[0]
                if token in ['[Signature Page Follows]','[See Attached]','[Signatures to follow on next page]']:continue
                if token.startswith('_'):
                    if not full[:m.start()].strip() and re.match(r'\s*(No conflicts|Additional|None|No Prior|See below)',full[m.end():],re.I):continue
                    occurrence+=1;fid=f'blank-{occurrence}'
                    before=full[max(0,m.start()-55):m.start()].strip()
                    after=full[m.end():m.end()+30].strip()
                    label=(before[-55:] or after[:30] or 'Blank')+' ('+str(occurrence)+')'
                    if occurrence<=len(FIELD_LABELS.get(item['id'],[])):label=FIELD_LABELS[item['id']][occurrence-1]
                    elif 'Consultant Name:' in before:label='Consultant name'
                    elif 'Effective Date:' in before:label='Effective date'
                else:
                    label=token[1:-1].replace('_',' ').strip().title().replace('’S','’s').replace("'S","'s");fid=re.sub(r'[^a-z0-9]+','-',label.lower()).strip('-')
                    if fid in named:
                        replacements.append((m.start(),m.end(),named[fid]));continue
                marker='{{'+fid+'}}'
                if fid not in named:
                    fields.append({'id':fid,'label':label,'marker':marker,'original':token});named[fid]=marker
                replacements.append((m.start(),m.end(),marker))
            for a,b,marker in reversed(replacements):
                marks=stylechars[a] if a<len(stylechars) else []
                full=full[:a]+marker+full[b:];stylechars[a:b]=[marks]*len(marker)
            nodes=[]
            prefix=numbered(p)
            if prefix:nodes.append({'type':'text','text':prefix})
            for i,char in enumerate(full):
                marks=stylechars[i] if i<len(stylechars) else []
                if nodes and nodes[-1].get('marks',[])==marks:nodes[-1]['text']+=char
                else:nodes.append({'type':'text','text':char,**({'marks':marks} if marks else {})})
            page_break=p.find('.//'+W+'br[@'+W+'type="page"]') is not None or p.find(W+'pPr/'+W+'pageBreakBefore') is not None
            return {'type':'paragraph','content':nodes,**({'attrs':{'pageBreakBefore':True}} if page_break else {})}
        def block(el):
            if el.tag==W+'p':return paragraph(el)
            if el.tag==W+'tbl':
                rows=[]
                for row in el.findall(W+'tr'):
                    cells=[]
                    for cell in row.findall(W+'tc'):
                        cells.append({'type':'tableCell','attrs':{'colspan':1,'rowspan':1},'content':[block(c) for c in cell if c.tag in [W+'p',W+'tbl']] or [{'type':'paragraph','content':[]}]})
                    rows.append({'type':'tableRow','content':cells})
                if len({len(row['content']) for row in rows})!=1:raise ValueError('Irregular table: '+item['id'])
                return {'type':'table','content':rows}
            raise ValueError('Unsupported body element '+el.tag)
        selected=[p for p in children[start:] if p.tag in [W+'p',W+'tbl']]
        blocks=[];signature_page=False
        for p in selected:
            if text(p).strip() in ['[Signature Page Follows]','[Signatures to follow on next page]']:
                signature_page=True;guidance+='\nLayout instruction: '+text(p).strip();continue
            node=block(p)
            if signature_page and p.tag==W+'p' and text(p).strip():
                node['attrs']={**node.get('attrs',{}),'pageBreakBefore':True};signature_page=False
            if node.get('attrs',{}).get('pageBreakBefore'):
                while blocks and blocks[-1]['type']=='paragraph' and not ''.join(n.get('text','') for n in blocks[-1].get('content',[])).strip():blocks.pop()
            blocks.append(node)
        source={'type':'doc','content':blocks}
        # Audit body text independently of formatting, numbering and field substitutions.
        def original_text(node):
            if node['type']=='text':
                return re.sub(r'\{\{([a-z0-9-]+)\}\}',lambda m:next(f['original'] for f in fields if f['id']==m[1]),node['text'])
            return '\n'.join(original_text(c) for c in node.get('content',[]))
        normalized=lambda s:re.sub(r'\s+','',s)
        retained=normalized(original_text(source))
        for p in selected:
            for para in ([p] if p.tag==W+'p' else p.iter(W+'p')):
                if text(para).strip() in ['[Signature Page Follows]','[Signatures to follow on next page]']:continue
                assert normalized(text(para)) in retained,('Lost body text',item['id'],text(para)[:80])
        source_json=json.dumps(source,ensure_ascii=False)
        assert len(source_json)<200000,(item['id'],len(source_json))
        result={**item,'source':source,'fields':fields,'guidance':guidance,'preparedAt':'2026-09-21','originalSha256':hashlib.sha256(path.read_bytes()).hexdigest()}
        target=directory/'prepared';target.mkdir(exist_ok=True)
        (target/(item['id']+'.json')).write_text(json.dumps(result,ensure_ascii=False))
        print(item['id'],len(source_json),'source bytes;',len(fields),'fields')
        return {k:result[k] for k in ['id','name','url','originalFile','originalSha256','preparedAt']}

def main():
    directory=Path(sys.argv[1]);items=json.loads((directory/'sources.json').read_text());catalog=[]
    for item in items:
        ready=prepare(item,directory)
        if ready:catalog.append(ready)
    (directory/'prepared'/'catalog.json').write_text(json.dumps({'templates':catalog},ensure_ascii=False))
if __name__=='__main__':main()
