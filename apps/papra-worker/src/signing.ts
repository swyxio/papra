import type { App, Env, Identity } from './types';
import { all, first, run, error, id } from './db';
import { ensureDocumentAccess, ensureOrganizationMember } from './collaboration';
import { isApprovedEmail } from './auth';
import { s3, signedDownload } from './storage';
import { validateSigningText, digestBytes, sealSigningPdf, signingPdf, validateFields, SIGNING_MAX_BYTES } from './signing-pdf';
import type { SigningField, PdfSigner } from './signing-pdf';
import { enqueueVersion } from './jobs';

type RequestRow = Record<string,any> & { id:string;document_id:string;version_id:string;organization_id:string;status:string;expires_at:number;created_by:string;fields:string;source_sha256:string;created_at:number;name:string };
type RecipientRow = Record<string,any> & {id:string;position:number;request_id:string;name:string;email:string;signed_at:number|null};
const encoder=new TextEncoder();
function clean(value:unknown,max=100){if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw error(400,'Enter a valid name or field value');return value.trim();}
async function signature(env:Env,value:string){const key=await crypto.subtle.importKey('raw',encoder.encode(env.AUTH_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(`drive-sign:${value}`))),x=>x.toString(16).padStart(2,'0')).join('');}
export async function recipientToken(env:Env,recipient:RecipientRow){return `${recipient.id}.${await signature(env,recipient.id)}`;}
async function publicSigning(env:Env,token:string){
  const [recipientId,mac]=token.split('.');if(!/^sigrec_[a-f0-9]{24}$/.test(recipientId||'')||!mac||mac.length!==64)throw error(404,'Signing link unavailable');
  const expected=await signature(env,recipientId);let diff=0;for(let i=0;i<64;i++)diff|=mac.charCodeAt(i)^expected.charCodeAt(i);if(diff)throw error(404,'Signing link unavailable');
  const recipient=await first<RecipientRow>(env,'SELECT * FROM signing_recipients WHERE id=?',recipientId);
  const request=recipient && await first<RequestRow>(env,'SELECT * FROM signing_requests WHERE id=?',recipient.request_id);
  if(!request||!recipient)throw error(404,'Signing link unavailable');
  if(request.expires_at<Date.now()||['cancelled','rejected'].includes(request.status))throw error(410,'Signing request is closed');
  // Recheck sender admission, role, personal ownership and folder access for every link use.
  const sender=await first(env,'SELECT * FROM users WHERE id=?',request.created_by);
  if(!sender||sender.disabled_at||!isApprovedEmail(sender.email,sender.email_verified===1))throw error(410,'Signing request is closed');
  const organizations=await all(env,'SELECT o.id,o.name,m.role FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.user_id=?',sender.id);
  const identity={userId:sender.id,email:sender.email,name:sender.name,isOwner:false,organizations,session:{id:'signing',expiresAt:new Date()}} as Identity;
  try{await manageDocument(env,identity,request.organization_id,request.document_id);}catch{throw error(410,'Signing request is closed');}
  return {request,recipient};
}
async function manageDocument(env:Env,identity:Identity,org:string,doc:string){
  if(identity.serviceScope)throw error(403,'Signing requires a personal owner or team admin');
  const role=await ensureOrganizationMember(env,identity,org);
  if(!['owner','admin'].includes(role))throw error(403,'Signing requires a personal owner or team admin');
  const document=await ensureDocumentAccess(env,identity,doc,'read');
  if(document.organization_id!==org)throw error(404,'File not found');
  if(document.is_deleted)throw error(410,'File is deleted');
  return document;
}
export async function signingDto(env:Env,request:RequestRow,links=true){
  const recipients=await all<RecipientRow>(env,'SELECT * FROM signing_recipients WHERE request_id=? ORDER BY position',request.id);
  return {id:request.id,name:request.name,status:request.status,versionId:request.version_id,sourceSha256:request.source_sha256,createdAt:request.created_at,expiresAt:request.expires_at,completedAt:request.completed_at,error:request.error,signedSha256:request.signed_sha256,signedSize:request.signed_size,fields:JSON.parse(request.fields),recipients:await Promise.all(recipients.map(async r=>({id:r.id,name:r.name,email:r.email,signedAt:r.signed_at,rejectedAt:r.rejected_at,url:links?`${env.APP_URL}/sign/${await recipientToken(env,r)}`:undefined}))),mail:await all(env,'SELECT recipient_id,kind,status,error FROM signing_mail WHERE request_id=?',request.id)};
}
async function dispatch(env:Env,requestId:string){await env.JOBS.send({signingId:requestId});}
export function registerSigningRoutes(app:App){
  app.use('/api/signing/*',async(c,next)=>{c.header('Referrer-Policy','no-referrer');c.header('X-Robots-Tag','noindex, nofollow, noarchive');await next();});
  const base='/api/organizations/:org/documents/:doc/signing';
  app.get(`${base}/source/:versionId`,async c=>{
    const d=await manageDocument(c.env,c.get('identity'),c.req.param('org'),c.req.param('doc'));
    const version=await first(c.env,'SELECT * FROM versions WHERE id=? AND document_id=?',c.req.param('versionId'),d.id);
    if(!version||version.mime_type!=='application/pdf')throw error(404,'PDF revision not found');
    if(version.size>SIGNING_MAX_BYTES)throw error(413,'Signing supports PDFs up to 10 MiB');
    const object=await c.env.FILES.get(version.storage_key);if(!object)throw error(404,'PDF not found');c.header('Content-Type','application/pdf');return c.body(object.body);
  });
  app.get(base,async c=>{const d=await ensureDocumentAccess(c.env,c.get('identity'),c.req.param('doc'));if(d.organization_id!==c.req.param('org'))throw error(404,'File not found');const role=await ensureOrganizationMember(c.env,c.get('identity'),d.organization_id);const links=['owner','admin'].includes(role)&&!c.get('identity').serviceScope;const rows=await all<RequestRow>(c.env,'SELECT * FROM signing_requests WHERE document_id=? ORDER BY created_at DESC',d.id);return c.json({canSend:links,requests:await Promise.all(rows.map(r=>signingDto(c.env,r,links))),maxBytes:SIGNING_MAX_BYTES});});
  app.post(base,async c=>{
    const identity=c.get('identity'),document=await manageDocument(c.env,identity,c.req.param('org'),c.req.param('doc'));
    const b=await c.req.json();const requestKey=clean(b.idempotencyKey,100);
    const existing=await first<RequestRow>(c.env,'SELECT * FROM signing_requests WHERE created_by=? AND request_key=?',identity.userId,requestKey);
    if(existing){if(existing.document_id!==document.id)throw error(409,'This send key belongs to another document');return c.json({request:await signingDto(c.env,existing)},201);}
    if(await first(c.env,"SELECT p.id FROM review_proposals p JOIN document_reviews r ON r.id=p.review_id WHERE r.document_id=? AND p.status='pending' LIMIT 1",document.id))throw error(409,'Resolve proposed changes and comments before sending this PDF');
    try{validateSigningText(document.name);}catch(e){throw error(400,(e as Error).message);}
    if(b.versionId!==document.current_version_id)throw error(409,'The document changed; reload the PDF before sending');
    const version=await first(c.env,'SELECT * FROM versions WHERE id=?',document.current_version_id);
    if(!version||version.mime_type!=='application/pdf')throw error(400,'Request signatures on a PDF');
    if(version.size>SIGNING_MAX_BYTES)throw error(413,'Signing currently supports PDFs up to 10 MiB');
    if(!c.env.SIGNING_P12||!c.env.SIGNING_PASSPHRASE||!c.env.RESEND_API_KEY)throw error(503,'Signing is not configured yet');
    if(!Array.isArray(b.recipients)||b.recipients.length<1||b.recipients.length>20)throw error(400,'Add 1 to 20 recipients');
    const recipients=b.recipients.map((r:any,i:number)=>({id:id('sigrec'),name:clean(r.name),email:clean(r.email,254).toLowerCase(),position:i}));
    try{for(const r of recipients){validateSigningText(r.name);validateSigningText(r.email);}}catch(e){throw error(400,(e as Error).message);}
    if(recipients.some((r:any)=>!/^\S+@[^@\s]+\.[^@\s]+$/.test(r.email))||new Set(recipients.map((r:any)=>r.email)).size!==recipients.length)throw error(400,'Use a different valid email for each recipient');
    const object=await c.env.FILES.get(version.storage_key);if(!object)throw error(404,'PDF not found');
    const bytes=new Uint8Array(await object.arrayBuffer());let pdf,fields:SigningField[];
    try{pdf=await signingPdf(bytes);fields=validateFields(b.fields,recipients.length,pdf.getPages().length);}catch(e){throw error(400,(e as Error).message);}
    const sha=await digestBytes(bytes);if(version.sha256&&version.sha256!==sha)throw error(409,'PDF integrity check failed');
    const now=Date.now(),requestId=id('sigreq');
    const current=await first(c.env,'SELECT current_version_id FROM documents WHERE id=?',document.id);if(current?.current_version_id!==version.id)throw error(409,'The document changed; reload before sending');
    try { await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO signing_requests(id,organization_id,document_id,version_id,name,source_sha256,fields,created_by,sender_name,sender_email,created_at,updated_at,expires_at,request_key) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM documents WHERE id=? AND current_version_id=? AND is_deleted=0 AND NOT EXISTS(SELECT 1 FROM review_proposals p JOIN document_reviews r ON r.id=p.review_id WHERE r.document_id=documents.id AND p.status=\'pending\')').bind(requestId,document.organization_id,document.id,version.id,document.name,sha,JSON.stringify(fields),identity.userId,identity.name,identity.email,now,now,now+90*86400000,requestKey,document.id,version.id),
      c.env.DB.prepare("UPDATE document_reviews SET status='closed' WHERE document_id=? AND EXISTS(SELECT 1 FROM signing_requests WHERE id=?)").bind(document.id,requestId),
      ...recipients.flatMap((r:any)=>[
        c.env.DB.prepare('INSERT INTO signing_recipients(id,request_id,position,name,email) SELECT ?,?,?,?,? FROM signing_requests WHERE id=?').bind(r.id,requestId,r.position,r.name,r.email,requestId),
        c.env.DB.prepare("INSERT INTO signing_mail(id,request_id,recipient_id,kind,updated_at) SELECT ?,?,?, 'request',? FROM signing_requests WHERE id=?").bind(id('sigmail'),requestId,r.id,now,requestId),
      ]),
    ]); } catch(e) {
      const accepted=await first<RequestRow>(c.env,'SELECT * FROM signing_requests WHERE created_by=? AND request_key=?',identity.userId,requestKey);
      if(accepted?.document_id===document.id)return c.json({request:await signingDto(c.env,accepted)},201);
      throw e;
    }
    const request=await first<RequestRow>(c.env,'SELECT * FROM signing_requests WHERE id=?',requestId);if(!request)throw error(409,'The document changed; reload before sending');
    try{await dispatch(c.env,requestId);}catch{/* Durable outbox is repaired by the scheduler. */}
    return c.json({request:await signingDto(c.env,request)},201);
  });
  app.post(`${base}/:requestId/cancel`,async c=>{await manageDocument(c.env,c.get('identity'),c.req.param('org'),c.req.param('doc'));await run(c.env,"UPDATE signing_requests SET status='cancelled',lease_token=NULL,updated_at=? WHERE id=? AND document_id=? AND status IN ('pending','sealing','error')",Date.now(),c.req.param('requestId'),c.req.param('doc'));return c.json({ok:true});});
  app.post(`${base}/:requestId/retry`,async c=>{await manageDocument(c.env,c.get('identity'),c.req.param('org'),c.req.param('doc'));const r=await first<RequestRow>(c.env,'SELECT * FROM signing_requests WHERE id=? AND document_id=?',c.req.param('requestId'),c.req.param('doc'));if(!r)throw error(404,'Request not found');await c.env.DB.batch([c.env.DB.prepare("UPDATE signing_requests SET status='pending',attempts=0,error=NULL,updated_at=? WHERE id=? AND status='error'").bind(Date.now(),r.id),c.env.DB.prepare("UPDATE signing_mail SET status='pending',attempts=0,error=NULL,updated_at=? WHERE request_id=? AND status='error'").bind(Date.now(),r.id)]);await dispatch(c.env,r.id);return c.json({ok:true});});
  app.get(`${base}/:requestId/file`,async c=>{await ensureDocumentAccess(c.env,c.get('identity'),c.req.param('doc'));const r=await first<RequestRow>(c.env,'SELECT * FROM signing_requests WHERE id=? AND document_id=? AND organization_id=?',c.req.param('requestId'),c.req.param('doc'),c.req.param('org'));if(!r||r.status!=='completed')throw error(404,'Signed PDF is not ready');if(c.req.query('inline')==='true'){const object=await c.env.FILES.get(r.signed_key);if(!object)throw error(404,'Signed PDF unavailable');c.header('Content-Type','application/pdf');return c.body(object.body);}return c.redirect(await signedDownload(c.env,r.signed_key,`${r.name.replace(/\.pdf$/i,'')}-signed.pdf`,60));});
  app.get('/api/signing/:token',async c=>{const {request:r,recipient:p}=await publicSigning(c.env,c.req.param('token'));const people=await all<RecipientRow>(c.env,'SELECT name,signed_at FROM signing_recipients WHERE request_id=? ORDER BY position',r.id);return c.json({id:r.id,name:r.name,status:r.status,senderName:r.sender_name,recipient:{name:p.name,email:p.email,signedAt:p.signed_at},fields:(JSON.parse(r.fields) as SigningField[]).filter(f=>f.recipient===p.position),people:people.map(x=>({name:x.name,signedAt:x.signed_at})),sourceSha256:r.source_sha256});});
  app.get('/api/signing/:token/file',async c=>{const {request:r}=await publicSigning(c.env,c.req.param('token'));const v=await first(c.env,'SELECT storage_key FROM versions WHERE id=?',r.version_id);const key=c.req.query('signed')==='true'&&r.status==='completed'?r.signed_key:v?.storage_key;if(!key)throw error(404,'PDF unavailable');if(c.req.query('download')==='true')return c.redirect(await signedDownload(c.env,key,r.status==='completed'?`${r.name.replace(/\.pdf$/i,'')}-signed.pdf`:r.name,60));const object=await c.env.FILES.get(key);if(!object)throw error(404,'PDF unavailable');c.header('Content-Type','application/pdf');c.header('Content-Disposition','inline');return c.body(object.body);});
  app.post('/api/signing/:token/sign',async c=>{
    const {request:r,recipient:p}=await publicSigning(c.env,c.req.param('token'));if(p.signed_at)return c.json({ok:true,status:r.status});if(r.status!=='pending')throw error(409,'Signing is not open');
    if(!(await c.env.AUTH_LIMITER.limit({key:`sign:${c.req.header('CF-Connecting-IP')||'local'}`})).success)throw error(429,'Please wait before trying again');
    const b=await c.req.json();if(b.consent!==true)throw error(400,'Consent to electronic signing is required');const name=clean(b.name),sig=clean(b.signature);
    const fields=(JSON.parse(r.fields) as SigningField[]).filter(f=>f.recipient===p.position&&f.type==='text');try{validateSigningText(name);validateSigningText(sig);}catch(e){throw error(400,(e as Error).message);}
    const values:Record<string,string>={};for(const f of fields){values[f.id]=clean(b.values?.[f.id],500);try{validateSigningText(values[f.id]);}catch(e){throw error(400,(e as Error).message);}}
    await run(c.env,"UPDATE signing_recipients SET name=?,signature=?,values_json=?,signed_at=?,address=?,user_agent=? WHERE id=? AND signed_at IS NULL AND rejected_at IS NULL AND EXISTS(SELECT 1 FROM signing_requests WHERE id=? AND status='pending')",name,sig,JSON.stringify(values),Date.now(),(c.req.header('CF-Connecting-IP')||'unavailable').slice(0,80),(c.req.header('User-Agent')||'').slice(0,512),p.id,r.id);
    const accepted=await first(c.env,'SELECT signed_at FROM signing_recipients WHERE id=?',p.id);if(!accepted?.signed_at)throw error(409,'The request closed before your signature was saved');
    try{await dispatch(c.env,r.id);}catch{/* Scheduler repairs accepted signing. */}return c.json({ok:true,status:'pending'});
  });
  app.post('/api/signing/:token/reject',async c=>{const {request:r,recipient:p}=await publicSigning(c.env,c.req.param('token'));if(p.signed_at)throw error(409,'You already signed this document');await c.env.DB.batch([c.env.DB.prepare("UPDATE signing_recipients SET rejected_at=? WHERE id=? AND signed_at IS NULL AND EXISTS(SELECT 1 FROM signing_requests WHERE id=? AND status='pending')").bind(Date.now(),p.id,r.id),c.env.DB.prepare("UPDATE signing_requests SET status='rejected',updated_at=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM signing_recipients WHERE id=? AND rejected_at IS NOT NULL)").bind(Date.now(),r.id,p.id)]);return c.json({ok:true});});
}

async function deliverMail(env:Env,r:RequestRow){
  for(const mail of await all(env,"SELECT * FROM signing_mail WHERE request_id=? AND status='pending'",r.id)){
    const lease=crypto.randomUUID();const claim=await run(env,"UPDATE signing_mail SET status='sending',lease_token=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'",lease,Date.now(),mail.id);if(!claim.meta.changes)continue;
    try{
      const current=await first<RequestRow>(env,'SELECT * FROM signing_requests WHERE id=?',r.id),p=await first<RecipientRow>(env,'SELECT * FROM signing_recipients WHERE id=?',mail.recipient_id);
      if(!current||!p||['cancelled','rejected'].includes(current.status)||current.expires_at<Date.now()){await run(env,"UPDATE signing_mail SET status='cancelled',lease_token=NULL WHERE id=? AND lease_token=?",mail.id,lease);continue;}
      const url=`${env.APP_URL}/sign/${await recipientToken(env,p)}`;
      const completed=mail.kind==='completed';
      const res=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`drive-${mail.id}`},body:JSON.stringify({from:env.SIGNING_FROM,to:[p.email],subject:`${completed?'Signed':'Signature requested'}: ${r.name}`,text:completed?`${r.name} has been signed by every recipient.\n\nDownload the sealed PDF and view the signing record:\n${url}\n\nswyx Drive`:`${r.sender_name} (${r.sender_email}) requests your signature on ${r.name}.\n\nReview and sign:\n${url}\n\nThis link grants access to this signing request only. No account is needed.\n\nswyx Drive`}),signal:AbortSignal.timeout(15000)});
      const result=await res.json() as {id?:string};if(!res.ok||!result.id)throw new Error('mail_provider_failed');
      await run(env,"UPDATE signing_mail SET status='sent',provider_id=?,lease_token=NULL,error=NULL,updated_at=? WHERE id=? AND lease_token=?",result.id,Date.now(),mail.id,lease);
    }catch{await run(env,"UPDATE signing_mail SET status=CASE WHEN attempts>=3 THEN 'error' ELSE 'pending' END,error='Email delivery failed; retry or copy the signing link',lease_token=NULL,updated_at=? WHERE id=? AND lease_token=?",Date.now(),mail.id,lease);throw new Error('signing_email_failed');}
  }
}
export async function processSigning(env:Env,requestId:string){
  let r=await first<RequestRow>(env,'SELECT * FROM signing_requests WHERE id=?',requestId);if(!r||['cancelled','rejected','error'].includes(r.status))return;
  if(r.expires_at<Date.now())return;
  const firstRecipient=await first<RecipientRow>(env,'SELECT * FROM signing_recipients WHERE request_id=? ORDER BY position LIMIT 1',r.id);
  if(!firstRecipient)return;
  try{await publicSigning(env,await recipientToken(env,firstRecipient));}catch(e){if((e as {status?:number}).status===410){await run(env,"UPDATE signing_requests SET status='cancelled',lease_token=NULL,updated_at=? WHERE id=? AND status IN ('pending','sealing')",Date.now(),r.id);return;}throw e;}
  await deliverMail(env,r);
  if(r.status==='completed')return;
  const lease=crypto.randomUUID();const claim=await run(env,"UPDATE signing_requests SET status='sealing',lease_token=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='pending' AND NOT EXISTS(SELECT 1 FROM signing_recipients WHERE request_id=? AND signed_at IS NULL)",lease,Date.now(),r.id,r.id);if(!claim.meta.changes)return;
  const outputKey=`signing/${r.id}/${lease}/signed.pdf`,auditKey=`signing/${r.id}/${lease}/audit.json`;
  try{
    const version=await first(env,'SELECT * FROM versions WHERE id=?',r.version_id);if(!version)throw new Error('source_missing');
    const object=await env.FILES.get(version.storage_key);if(!object)throw new Error('source_missing');const bytes=new Uint8Array(await object.arrayBuffer());if(await digestBytes(bytes)!==r.source_sha256)throw new Error('source_integrity_failed');
    const people=await all<RecipientRow>(env,'SELECT * FROM signing_recipients WHERE request_id=? ORDER BY position',r.id);
    const recipients:PdfSigner[]=people.map(p=>({name:p.name,email:p.email,signedAt:p.signed_at!,signature:p.signature,values:JSON.parse(p.values_json||'{}'),address:p.address}));
    const audit={requestId:r.id,name:r.name,sourceSha256:r.source_sha256,createdAt:r.created_at};
    const signed=await sealSigningPdf(bytes,JSON.parse(r.fields),recipients,audit,Uint8Array.from(atob(env.SIGNING_P12),x=>x.charCodeAt(0)),env.SIGNING_PASSPHRASE);
    const sha=await digestBytes(signed),now=Date.now(),versionId=`ver_${r.id}`;
    const record=JSON.stringify({...audit,recipients:people.map(p=>({name:p.name,email:p.email,signedAt:p.signed_at,signature:p.signature,address:p.address,userAgent:p.user_agent,values:JSON.parse(p.values_json||'{}')})),signedSha256:sha,signedSize:signed.length,sealedAt:now});
    await Promise.all([env.FILES.put(outputKey,signed,{httpMetadata:{contentType:'application/pdf'}}),env.FILES.put(auditKey,record,{httpMetadata:{contentType:'application/json'}}),env.BACKUPS.put(outputKey,signed,{httpMetadata:{contentType:'application/pdf'}}),env.BACKUPS.put(auditKey,record,{httpMetadata:{contentType:'application/json'}})]);
    const results=await env.DB.batch([
      env.DB.prepare("INSERT INTO versions(id,document_id,storage_key,original_name,mime_type,size,sha256,created_by,created_at) SELECT ?,?,?,?,'application/pdf',?,?,?,? FROM signing_requests WHERE id=? AND status='sealing' AND lease_token=?").bind(versionId,r.document_id,outputKey,`${r.name.replace(/\.pdf$/i,'')}-signed.pdf`,signed.length,sha,r.created_by,now,r.id,lease),
      env.DB.prepare("UPDATE documents SET current_version_id=?,mime_type='application/pdf',updated_at=? WHERE id=? AND current_version_id=? AND is_deleted=0 AND EXISTS(SELECT 1 FROM signing_requests WHERE id=? AND status='sealing' AND lease_token=?)").bind(versionId,now,r.document_id,r.version_id,r.id,lease),
      env.DB.prepare("UPDATE signing_requests SET status='completed',completed_at=?,updated_at=?,signed_version_id=?,signed_key=?,signed_sha256=?,signed_size=?,audit_key=?,lease_token=NULL,error=NULL WHERE id=? AND status='sealing' AND lease_token=?").bind(now,now,versionId,outputKey,sha,signed.length,auditKey,r.id,lease),
      ...people.map(p=>env.DB.prepare("INSERT OR IGNORE INTO signing_mail(id,request_id,recipient_id,kind,updated_at) SELECT ?,?,?,'completed',? FROM signing_requests WHERE id=? AND status='completed' AND signed_key=?").bind(id('sigmail'),r!.id,p.id,now,r!.id,outputKey)),
    ]);
    if(!results[2].meta.changes){await Promise.all([env.FILES.delete([outputKey,auditKey]),env.BACKUPS.delete([outputKey,auditKey])]);return;}
    await enqueueVersion(env,versionId,'process');await enqueueVersion(env,versionId,'hash');await enqueueVersion(env,versionId,'backup');
    r=(await first<RequestRow>(env,'SELECT * FROM signing_requests WHERE id=?',r.id))!;
  }catch(e){
    const stored=await first(env,'SELECT status,signed_key FROM signing_requests WHERE id=?',r.id);
    if(stored?.signed_key!==outputKey)await Promise.all([env.FILES.delete([outputKey,auditKey]),env.BACKUPS.delete([outputKey,auditKey])]);
    await run(env,"UPDATE signing_requests SET status=CASE WHEN attempts>=3 THEN 'error' ELSE 'pending' END,error='PDF sealing failed; your signatures are saved',lease_token=NULL,updated_at=? WHERE id=? AND lease_token=?",Date.now(),r.id,lease);throw e;
  }
  await deliverMail(env,r);
}
export async function repairSigning(env:Env){
  const now=Date.now();await env.DB.batch([
    env.DB.prepare("UPDATE signing_requests SET status=CASE WHEN attempts>=3 THEN 'error' ELSE 'pending' END,lease_token=NULL,error='Sealing interrupted; signatures retained',updated_at=? WHERE status='sealing' AND updated_at<?").bind(now,now-10*60000),
    env.DB.prepare("UPDATE signing_mail SET status=CASE WHEN attempts>=3 THEN 'error' ELSE 'pending' END,lease_token=NULL,updated_at=? WHERE status='sending' AND updated_at<?").bind(now,now-10*60000),
  ]);
  for(const r of await all(env,"SELECT DISTINCT r.id FROM signing_requests r LEFT JOIN signing_mail m ON m.request_id=r.id WHERE r.expires_at>? AND r.status IN ('pending','completed') AND (m.status='pending' OR (r.status='pending' AND NOT EXISTS(SELECT 1 FROM signing_recipients p WHERE p.request_id=r.id AND p.signed_at IS NULL))) LIMIT 100",now))await dispatch(env,r.id);
}
