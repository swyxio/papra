import type {App,Env,Identity} from './types';
import {first,error} from './db';
import {canWriteFolder,ensureOrganizationMember,ensureDocumentAccess,organizationHomeFolderId} from './collaboration';
import {registerAuthoringExportRoutes} from './authoring-export';
import {renderDocument,validateSource,sourceText} from './authoring-pdf';
import {digestBytes,SIGNING_MAX_BYTES} from './signing-pdf';
import {enqueueVersion} from './jobs';
const base='/api/organizations/:org/documents/:doc/editor';
async function stagePdf(env:Env,storageKey:string,bytes:Uint8Array){
  const results=await Promise.allSettled([env.FILES.put(storageKey,bytes,{httpMetadata:{contentType:'application/pdf'}}),env.BACKUPS.put(storageKey,bytes,{httpMetadata:{contentType:'application/pdf'}})]);
  if(results.some(r=>r.status==='rejected')){await Promise.allSettled([env.FILES.delete(storageKey),env.BACKUPS.delete(storageKey)]);throw error(503,'Could not archive PDF. Your edits are retained; try saving again.');}
}

async function document(env:Env,user:Identity,org:string,doc:string,mode:'read'|'write'='read'){
  if(user.serviceScope)throw error(403,'Use your Google account to edit documents');
  const d=await ensureDocumentAccess(env,user,doc,mode);if(d.organization_id!==org||d.is_deleted)throw error(404,'Document not found');return d;
}
function key(value:unknown){if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))throw error(400,'Invalid save key');return value;}
export function registerAuthoringRoutes(app:App){
  registerAuthoringExportRoutes(app);
  app.get(base,async c=>{
    const d=await document(c.env,c.get('identity'),c.req.param('org'),c.req.param('doc'));
    const source=await first(c.env,'SELECT * FROM authored_versions WHERE document_id=? ORDER BY (version_id=?) DESC,created_at DESC LIMIT 1',d.id,d.current_version_id);
    let canEdit=true;try{await document(c.env,c.get('identity'),c.req.param('org'),d.id,'write');}catch{canEdit=false;}
    const canSend=['owner','admin'].includes(await ensureOrganizationMember(c.env,c.get('identity'),d.organization_id));
    return c.json({authored:!!source,canEdit,canSend,name:d.name,versionId:d.current_version_id,sourceVersionId:source?.version_id,source:source?JSON.parse(source.source_json):null});
  });
  app.post('/api/organizations/:org/authored-documents',async c=>{
    const user=c.get('identity'),org=c.req.param('org');if(user.serviceScope)throw error(403,'Use your Google account');
    const b=await c.req.json(),requestKey=key(b.key),docId=`doc_${requestKey.slice(0,24)}`,versionId=`ver_${requestKey}`;
    const old=await first(c.env,'SELECT * FROM documents WHERE id=?',docId);
    if(old){await document(c.env,user,org,docId,'write');if(old.created_by!==user.userId)throw error(409,'Create key already used');return c.json({documentId:docId,versionId:old.current_version_id},201);}
    const folder=await canWriteFolder(c.env,user,b.folderId||organizationHomeFolderId(org));if(folder.organization_id!==org)throw error(403,'Folder access denied');
    const title=typeof b.name==='string'?b.name.trim().replace(/\.pdf$/i,'').slice(0,200):'';if(!title)throw error(400,'Enter a document name');
    let source,bytes;try{source=validateSource(b.source);bytes=await renderDocument(source,title);}catch(e){throw error(400,(e as Error).message);}
    if(bytes.length>SIGNING_MAX_BYTES)throw error(413,'Generated PDF exceeds 10 MiB');
    const storageKey=`originals/${org}/${docId}/${versionId}/${crypto.randomUUID()}`,now=Date.now(),sha=await digestBytes(bytes);
    await stagePdf(c.env,storageKey,bytes);
    try{await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO documents(id,organization_id,created_by,name,mime_type,content,current_version_id,home_folder_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(docId,org,user.userId,`${title}.pdf`,'application/pdf',sourceText(source),versionId,folder.id,now,now),
      c.env.DB.prepare('INSERT INTO versions(id,document_id,storage_key,original_name,mime_type,size,sha256,extracted_text,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(versionId,docId,storageKey,`${title}.pdf`,'application/pdf',bytes.length,sha,sourceText(source),user.userId,now),
      c.env.DB.prepare('INSERT INTO authored_versions(version_id,document_id,source_json,created_at) VALUES (?,?,?,?)').bind(versionId,docId,JSON.stringify(source),now),
    ]);}catch(e){const stored=await first(c.env,'SELECT id,storage_key FROM versions WHERE id=?',versionId);if(stored?.storage_key!==storageKey)await Promise.all([c.env.FILES.delete(storageKey),c.env.BACKUPS.delete(storageKey)]);if(stored){await document(c.env,user,org,docId,'write');return c.json({documentId:docId,versionId},201);}throw e;}
    c.executionCtx.waitUntil(enqueueVersion(c.env,versionId));return c.json({documentId:docId,versionId},201);
  });
  app.post(`${base}/lock`,async c=>{
    const user=c.get('identity'),d=await document(c.env,user,c.req.param('org'),c.req.param('doc'),'write'),b=await c.req.json(),token=key(b.token),now=Date.now();
    if(!await first(c.env,'SELECT version_id FROM authored_versions WHERE document_id=? LIMIT 1',d.id))throw error(400,'Uploaded PDFs cannot be edited as native documents');
    await c.env.DB.prepare('INSERT INTO document_edit_locks(document_id,user_id,token,expires_at) VALUES (?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET user_id=excluded.user_id,token=excluded.token,expires_at=excluded.expires_at WHERE document_edit_locks.expires_at<? OR (document_edit_locks.user_id=? AND document_edit_locks.token=?)').bind(d.id,user.userId,token,now+120000,now,user.userId,token).run();
    const lock=await first(c.env,'SELECT l.*,u.name FROM document_edit_locks l JOIN users u ON u.id=l.user_id WHERE document_id=?',d.id);if(lock?.user_id!==user.userId||lock?.token!==token)throw error(409,`${lock?.name||'A colleague'} is editing this document. Try again in two minutes.`);
    return c.json({expiresAt:lock.expires_at});
  });
  app.post(base,async c=>{
    const user=c.get('identity'),d=await document(c.env,user,c.req.param('org'),c.req.param('doc'),'write'),b=await c.req.json(),versionId=`ver_${key(b.key)}`,token=key(b.token);
    const previous=await first(c.env,'SELECT document_id FROM authored_versions WHERE version_id=?',versionId);if(previous){if(previous.document_id!==d.id)throw error(409,'Save key already used');return c.json({versionId});}
    if(d.current_version_id!==b.versionId)throw error(409,'A newer version exists. Your changes are still in the editor; copy them before reloading.');
    const lock=await first(c.env,'SELECT * FROM document_edit_locks WHERE document_id=? AND user_id=? AND token=? AND expires_at>?',d.id,user.userId,token,Date.now());if(!lock)throw error(409,'Editing lease expired. Try saving again after reconnecting.');
    let source,bytes;try{source=validateSource(b.source);bytes=await renderDocument(source,d.name);}catch(e){throw error(400,(e as Error).message);}
    if(b.proposalId){const proposal=await first(c.env,"SELECT p.*,r.version_id FROM review_proposals p JOIN document_reviews r ON r.id=p.review_id WHERE p.id=? AND r.document_id=?",b.proposalId,d.id);if(!proposal||proposal.status!=='pending'||proposal.version_id!==b.versionId||proposal.source_json!==JSON.stringify(source))throw error(409,'Proposal is resolved or belongs to another revision');}
    if(bytes.length>SIGNING_MAX_BYTES)throw error(413,'Generated PDF exceeds 10 MiB');
    const storageKey=`originals/${d.organization_id}/${d.id}/${versionId}/${crypto.randomUUID()}`,now=Date.now(),sha=await digestBytes(bytes);
    await stagePdf(c.env,storageKey,bytes);
    const valid='EXISTS(SELECT 1 FROM documents d JOIN document_edit_locks l ON l.document_id=d.id WHERE d.id=? AND d.current_version_id=? AND d.is_deleted=0 AND l.user_id=? AND l.token=? AND l.expires_at>?) AND (? IS NULL OR EXISTS(SELECT 1 FROM review_proposals WHERE id=? AND status=\'pending\'))';
    try{await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO versions(id,document_id,storage_key,original_name,mime_type,size,sha256,extracted_text,created_by,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${valid}`).bind(versionId,d.id,storageKey,d.name,'application/pdf',bytes.length,sha,sourceText(source),user.userId,now,d.id,b.versionId,user.userId,token,Date.now(),b.proposalId||null,b.proposalId||null),
      c.env.DB.prepare('INSERT INTO authored_versions(version_id,document_id,source_json,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM versions WHERE id=?)').bind(versionId,d.id,JSON.stringify(source),now,versionId),
      c.env.DB.prepare('UPDATE documents SET current_version_id=?,content=?,updated_at=? WHERE id=? AND current_version_id=? AND is_deleted=0 AND EXISTS(SELECT 1 FROM authored_versions WHERE version_id=?)').bind(versionId,sourceText(source),now,d.id,b.versionId,versionId),
      ...(b.proposalId?[c.env.DB.prepare("UPDATE review_proposals SET status='accepted',resolved_at=?,resolved_by=?,published_version_id=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM authored_versions WHERE version_id=?)").bind(now,user.userId,versionId,b.proposalId,versionId)]:[]),
    ]);if(!await first(c.env,'SELECT version_id FROM authored_versions WHERE version_id=?',versionId))throw error(409,'Document changed while preparing the PDF. Your edits are retained locally.');}
    catch(e){if((await first(c.env,'SELECT id,storage_key FROM versions WHERE id=?',versionId))?.storage_key!==storageKey)await Promise.all([c.env.FILES.delete(storageKey),c.env.BACKUPS.delete(storageKey)]);throw e;}
    c.executionCtx.waitUntil(enqueueVersion(c.env,versionId));return c.json({versionId});
  });
  app.post(`${base}/release`,async c=>{const user=c.get('identity'),d=await document(c.env,user,c.req.param('org'),c.req.param('doc'),'write'),b=await c.req.json();await c.env.DB.prepare('DELETE FROM document_edit_locks WHERE document_id=? AND user_id=? AND token=?').bind(d.id,user.userId,key(b.token)).run();return c.json({ok:true});});
}
