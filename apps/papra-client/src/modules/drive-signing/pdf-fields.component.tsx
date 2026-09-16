import { createEffect, createSignal, For, Index, onCleanup, onMount, Show } from 'solid-js';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
export type SigningField = {id:string;recipient:number;type:'signature'|'name'|'date'|'text';page:number;x:number;y:number;width:number;height:number;label?:string};
type FieldActions={onPlace?:(page:number,x:number,y:number)=>void;onMove?:(id:string,x:number,y:number)=>void;onRemove?:(id:string)=>void;labels?:(field:SigningField)=>string;onError?:()=>void};
export function PdfFields(props:{url:string;fields:SigningField[];onReady?:()=>void}&FieldActions){
  const [pdf,setPdf]=createSignal<PDFDocumentProxy>();const [message,setMessage]=createSignal('Loading PDF…');
  createEffect(()=>{
    const task=getDocument({url:props.url,withCredentials:true,cMapUrl:'/pdfjs-assets/cmaps/',cMapPacked:true,standardFontDataUrl:'/pdfjs-assets/standard_fonts/',isEvalSupported:false});
    let active=true;
    void task.promise.then(d=>{if(active){setPdf(d);setMessage('');props.onReady?.();}}).catch(()=>{if(active){setMessage('Could not load the PDF. Reload to try again.');props.onError?.();}});
    onCleanup(()=>{active=false;void task.destroy();});
  });
  return <div class="space-y-6"><Show when={message()}><p role="status">{message()}</p></Show><Show when={pdf()}>{d=><For each={Array.from({length:d().numPages},(_,i)=>i+1)}>{page=><PdfPage {...props} pdf={d()} page={page} fields={props.fields.filter(f=>f.page===page)}/>}</For>}</Show></div>;
}
function PdfPage(props:{pdf:PDFDocumentProxy;page:number;fields:SigningField[]}&FieldActions){
  let canvas!:HTMLCanvasElement;let wrapper!:HTMLDivElement;
  const [ratio,setRatio]=createSignal('612 / 792');const [failed,setFailed]=createSignal(false);
  onMount(()=>{let task:{cancel:()=>void}|undefined;let active=true;void props.pdf.getPage(props.page).then(p=>{if(!active)return;const view=p.getViewport({scale:1.3});canvas.width=view.width;canvas.height=view.height;setRatio(`${view.width} / ${view.height}`);const render=p.render({canvasContext:canvas.getContext('2d')!,viewport:view});task=render;return render.promise;}).catch(()=>{if(active){setFailed(true);props.onError?.();}});onCleanup(()=>{active=false;task?.cancel();});});
  function move(event:PointerEvent,field:SigningField){
    if(!props.onMove)return;event.stopPropagation();event.preventDefault();const node=event.currentTarget as HTMLElement,rect=wrapper.getBoundingClientRect();const dx=event.clientX-rect.left-field.x*rect.width,dy=event.clientY-rect.top-field.y*rect.height;
    node.setPointerCapture(event.pointerId);node.onpointermove=e=>props.onMove?.(field.id,Math.max(0,Math.min(1-field.width,(e.clientX-rect.left-dx)/rect.width)),Math.max(0,Math.min(1-field.height,(e.clientY-rect.top-dy)/rect.height)));node.onpointerup=()=>{node.onpointermove=null;node.onpointerup=null;};
  }
  return <div><p class="text-xs text-muted-foreground mb-2">Page {props.page}</p><div ref={wrapper} class="relative border shadow-sm bg-white overflow-hidden" style={{'aspect-ratio':ratio(),'touch-action':props.onPlace?'none':'auto'}} onClick={e=>{if(e.target!==canvas)return;const r=wrapper.getBoundingClientRect();props.onPlace?.(props.page,(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height);}}>
    <canvas ref={canvas} class="w-full h-full"/><Show when={failed()}><p class="absolute top-4 left-4 text-red-700">Page rendering failed; reload before signing.</p></Show>
    <Index each={props.fields}>{field=><div class="absolute border-2 border-blue-500 bg-blue-100/70 text-blue-950 flex items-center justify-between px-1 text-xs select-none overflow-hidden" style={{left:`${field().x*100}%`,top:`${field().y*100}%`,width:`${field().width*100}%`,height:`${field().height*100}%`,'touch-action':'none',cursor:props.onMove?'move':'default'}} onPointerDown={e=>move(e,field())} onClick={e=>e.stopPropagation()}><span class="truncate">{props.labels?.(field())||field().label||field().type}</span><Show when={props.onRemove}><button type="button" aria-label={`Remove ${field().type} field`} class="px-1 font-bold" onPointerDown={e=>e.stopPropagation()} onClick={()=>props.onRemove?.(field().id)}>×</button></Show></div>}</Index>
  </div></div>;
}
