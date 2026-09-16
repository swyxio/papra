import pdfmake from 'pdfmake/build/pdfmake.js';
import fonts from 'pdfmake/build/vfs_fonts.js';
pdfmake.addVirtualFileSystem(fonts);
export type DocumentNode={type:string;text?:string;attrs?:Record<string,any>;marks?:{type:string;attrs?:Record<string,any>}[];content?:DocumentNode[]};
const types=new Set(['doc','paragraph','heading','text','bulletList','orderedList','listItem','blockquote','horizontalRule','hardBreak','table','tableRow','tableCell','tableHeader']);
export function validateSource(value:unknown):DocumentNode {
  if(JSON.stringify(value)?.length>200_000)throw new Error('Document exceeds the 200 KB authoring limit');
  let count=0;
  function check(n:any,depth=0):DocumentNode{
    if(!n||depth>20||++count>5000||!types.has(n.type))throw new Error('Unsupported document content');
    if(n.type==='text'&&(typeof n.text!=='string'||n.text.length>200_000))throw new Error('Invalid document text');
    if(n.content!==undefined&&!Array.isArray(n.content))throw new Error('Invalid document content');
    const attrs:Record<string,any>={};
    if(n.type==='heading'){if(!Number.isInteger(n.attrs?.level)||n.attrs.level<1||n.attrs.level>3)throw new Error('Use headings 1 to 3');attrs.level=n.attrs.level;}
    if(n.type==='orderedList')attrs.start=Math.max(1,Math.min(10000,Number(n.attrs?.start)||1));
    if(['tableCell','tableHeader'].includes(n.type)){
      if((n.attrs?.colspan||1)!==1||(n.attrs?.rowspan||1)!==1)throw new Error('Merged table cells are not supported');attrs.colspan=1;attrs.rowspan=1;
    }
    const content=n.content?.map((c:any)=>check(c,depth+1));
    if(n.type==='table'){
      if(!content?.length||content.length>100||!content[0].content?.length||content[0].content.length>10||content.some((row:DocumentNode)=>row.type!=='tableRow'||row.content?.length!==content[0].content.length))throw new Error('Use rectangular tables with up to 100 rows and 10 columns');
    }
    if(n.type==='tableRow'&&content?.some((c:DocumentNode)=>!['tableCell','tableHeader'].includes(c.type)))throw new Error('Invalid table row');
    return {type:n.type,...(n.type==='text'?{text:n.text}:{}),...(Object.keys(attrs).length?{attrs}:{}),...(content?{content}:{}),...(n.marks?{marks:n.marks.filter((m:any)=>['bold','italic','strike','code','underline'].includes(m.type)).map((m:any)=>({type:m.type}))}:{})};
  }
  const source=check(value);if(source.type!=='doc')throw new Error('Invalid document root');return source;
}
export function sourceText(node:DocumentNode):string{return node.type==='text'?node.text||'':(node.content||[]).map(sourceText).join(['paragraph','heading'].includes(node.type)?'':'\n');}
function inline(nodes:DocumentNode[]=[]):any[]{return nodes.flatMap(n=>n.type==='hardBreak'?['\n']:n.type==='text'?[{text:n.text||'',bold:n.marks?.some(m=>m.type==='bold'),italics:n.marks?.some(m=>m.type==='italic'),decoration:n.marks?.some(m=>m.type==='strike')?'lineThrough':n.marks?.some(m=>m.type==='underline')?'underline':undefined}]:inline(n.content));}
function block(n:DocumentNode):any{
  switch(n.type){
    case 'paragraph':return {text:inline(n.content).length?inline(n.content):' ',margin:[0,0,0,8]};
    case 'heading':return {text:inline(n.content),fontSize:[24,18,14][n.attrs!.level-1],bold:true,margin:[0,12,0,8]};
    case 'bulletList':case 'orderedList':return {[n.type==='bulletList'?'ul':'ol']:(n.content||[]).map(block),...(n.type==='orderedList'?{start:n.attrs?.start||1}:{}),margin:[0,0,0,8]};
    case 'listItem':case 'blockquote':case 'tableCell':case 'tableHeader':return {stack:(n.content||[]).map(block),...(n.type==='tableHeader'?{bold:true,fillColor:'#f1f5f9'}:{}),...(n.type==='blockquote'?{margin:[16,0,0,8],color:'#475569'}:{})};
    case 'horizontalRule':return {canvas:[{type:'line',x1:0,y1:0,x2:499,y2:0,lineWidth:1,lineColor:'#cbd5e1'}],margin:[0,8,0,12]};
    case 'table':return {table:{widths:n.content![0].content!.map(()=>'*'),headerRows:n.content![0].content!.every(c=>c.type==='tableHeader')?1:0,body:n.content!.map(r=>r.content!.map(block))},margin:[0,8,0,12]};
    default:throw new Error('Unsupported document structure');
  }
}
export async function renderDocument(source:DocumentNode,title:string){
  return new Uint8Array(await pdfmake.createPdf({info:{title,creator:'swyx Drive'},pageSize:'A4',pageMargins:[48,48,48,48],defaultStyle:{font:'Roboto',fontSize:11,lineHeight:1.25},content:source.content?.map(block)||[{text:' '}]}).getBuffer());
}
