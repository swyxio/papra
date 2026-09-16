// Private, resumable Drive import using a temporary folder-scoped credential.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { AwsClient } from '../../apps/papra-worker/node_modules/aws4fetch/dist/aws4fetch.esm.mjs';
const ACCOUNT='2d017c943ff16e4c52783635ef05e535', DATABASE='300e75cb-d501-4cfe-b170-67642e0ee1c1';
const ORG='org_acdec956f4565812fe82e70a', USER='usr_38950f095bd9fde173a093ee';
const config='/Users/swyx/.config/papra-drive';
const stage=path.resolve(process.argv[2]);
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const writes=new Map();
const save=(file,value)=>{const data=JSON.stringify(value,null,2);const previous=writes.get(file)||Promise.resolve();const next=previous.then(async()=>{await fs.writeFile(file+'.tmp',data,{mode:0o600});await fs.rename(file+'.tmp',file);});writes.set(file,next);return next;};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function d1(sql,params=[]){
 const auth=await read(path.join(config,'cloudflare-auth-session.json'));
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`,{method:'POST',headers:{Authorization:`Bearer ${auth.token}`,'Content-Type':'application/json'},body:JSON.stringify({sql,params})});
 const result=await response.json();if(!response.ok||!result.success)throw new Error(`D1 request failed: ${response.status} ${JSON.stringify(result.errors)}`);
 return result.result[0].results;
}
async function identityGuard(){
 const rows=await d1('SELECT o.personal_owner_id,u.email,u.email_verified,m.role FROM organizations o JOIN organization_members m ON m.organization_id=o.id JOIN users u ON u.id=m.user_id WHERE o.id=?',[ORG]);
 if(rows.length!==1||rows[0].personal_owner_id!==USER||rows[0].email!=='shawnthe1@gmail.com'||rows[0].role!=='owner'||rows[0].email_verified!==1)throw new Error('Private owner identity guard failed');
}
const authPath=path.join(stage,'import-auth.json');
async function bootstrap(){
 await identityGuard();
 let auth;try{auth=await read(authPath);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!auth){
  const folderId='fld_'+crypto.randomUUID().replaceAll('-','');
  const credentialId='cred_'+crypto.randomUUID().replaceAll('-','');
  const token='drv_'+crypto.randomBytes(32).toString('hex');
  auth={folderId,credentialId,token,expiresAt:Date.now()+6*3600000};await save(authPath,auth);
 }
 await d1('INSERT OR IGNORE INTO folders(id,organization_id,parent_id,name,is_home,is_restricted,created_by,created_at,updated_at) VALUES(?,?,?,?,0,0,?,?,?)',[auth.folderId,ORG,'fld_home_'+ORG,'Codex history — before 2026-08-19',USER,Date.now(),Date.now()]);
 const existing=await d1('SELECT revoked_at,expires_at,folder_id FROM service_tokens WHERE id=?',[auth.credentialId]);
 if(existing.length&&(existing[0].revoked_at||existing[0].expires_at<Date.now()||existing[0].folder_id!==auth.folderId))throw new Error('Import credential expired, revoked or changed');
 await d1('INSERT OR IGNORE INTO service_tokens(id,user_id,organization_id,folder_id,token_hash,name,permissions,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',[auth.credentialId,USER,ORG,auth.folderId,sha(auth.token),'Codex history import 2026-09-16 (temporary)','["read","write"]',Date.now(),auth.expiresAt]);
 return auth;
}
const selection=await read(path.join(stage,'selection.json'));
let auth;
async function api(route,body,method=body===undefined?'GET':'POST'){
 for(let attempt=0;;attempt++){
  try{
   const response=await fetch(`https://drive.swyx.io/api/organizations/${ORG}/${route}`,{method,headers:{Authorization:`Bearer ${auth.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
   if(response.status===401&&attempt<3){
    const rows=await d1('SELECT token_hash,folder_id,expires_at,revoked_at FROM service_tokens WHERE id=? AND user_id=? AND organization_id=?',[auth.credentialId,USER,ORG]);
    if(rows.length===1&&rows[0].token_hash===sha(auth.token)&&rows[0].folder_id===auth.folderId&&!rows[0].revoked_at&&rows[0].expires_at>Date.now()){await sleep(1000*2**attempt);continue;}
   }
   if(!response.ok){if((response.status>=500||response.status===429)&&attempt<5){await sleep(1000*2**attempt);continue;}throw new Error(`Drive ${route} failed ${response.status}: ${(await response.text()).slice(0,300)}`);}
   return response.status===204?{}:await response.json();
  }catch(error){if(attempt>=5||error.message.startsWith('Drive '))throw error;await sleep(1000*2**attempt);}
 }
}
const statePath=path.join(stage,'upload-state.json');
let state;try{state=await read(statePath);}catch(error){if(error.code!=='ENOENT')throw error;state={folders:{},assets:{}};}
async function folder(name){
 if(state.folders[name])return state.folders[name];
 const {folder}=await api('folders',{name,parentId:auth.folderId});state.folders[name]=folder.id;await save(statePath,state);return folder.id;
}
const completions=[];let completionTimer;
async function flushCompletions(){
 if(completionTimer)clearTimeout(completionTimer);completionTimer=undefined;
 const batch=completions.splice(0,20);if(completions.length)completionTimer=setTimeout(()=>void flushCompletions(),100);
 if(!batch.length)return;
 try{const {results}=await api('uploads/complete',{uploadIds:batch.map(x=>x.id)});
  for(const item of batch){const result=results.find(x=>x.uploadId===item.id);if(result?.status===200&&result.document)item.resolve(result.document);else item.reject(new Error(`Upload completion failed ${result?.status||502}`));}
 }catch(error){for(const item of batch)item.reject(error);}
}
const completeUpload=id=>new Promise((resolve,reject)=>{completions.push({id,resolve,reject});if(completions.length>=20)void flushCompletions();else if(!completionTimer)completionTimer=setTimeout(()=>void flushCompletions(),100);});
async function upload(file,mimeType,folderId,label=path.basename(file)){
 const info=await fs.stat(file);const bytesHash=await fileHash(file);
 let asset=state.assets[label],created=false;
 if(asset&&(asset.sha256!==bytesHash||asset.bytes!==info.size))throw new Error('Upload asset changed');
 if(!asset){
  const {session}=await api('uploads',{fileName:label,mimeType,size:info.size,fingerprint:bytesHash,folderId});
  created=true;asset={...session,sha256:bytesHash,bytes:info.size,file,label};state.assets[label]=asset;await save(statePath,state);
 }
 if(asset.complete)return asset;
 let current=created?{session:asset,parts:[]}:await api('uploads/'+asset.id);
 if(current.session.status==='complete'){asset.complete=true;await save(statePath,state);return asset;}
 if(current.session.status==='stored'){const document=await completeUpload(asset.id);asset.complete=true;asset.documentId=document.id;await save(statePath,state);return asset;}
 if(current.session.mode==='single'){
  if(info.size){const bytes=await fs.readFile(file);for(let attempt=0;;attempt++){
   try{if(attempt){current=await api('uploads/'+asset.id);if(['stored','complete'].includes(current.session.status))break;}
    const response=await fetch(current.session.uploadUrl,{method:'PUT',headers:current.session.uploadHeaders,body:bytes,signal:AbortSignal.timeout(180000)});if(!response.ok)throw new Error('R2 upload rejected '+response.status);break;
   }catch(error){if(attempt>=5)throw error;await sleep(1000*2**attempt);}
  }}
  const document=await completeUpload(asset.id);asset.complete=true;asset.documentId=document.id;await save(statePath,state);return asset;
 }
 const uploaded=new Set(current.parts.map(item=>item.partNumber));
 const handle=await fs.open(file,'r');
 const signed=new Map();
 async function partUrl(number,refresh){
  if(refresh)return (await api('uploads/'+asset.id+'/parts',{partNumbers:[number]})).parts[0].url;
  const start=Math.floor((number-1)/8)*8+1;
  if(!signed.has(start))signed.set(start,api('uploads/'+asset.id+'/parts',{partNumbers:Array.from({length:Math.min(8,Math.ceil(info.size/asset.partSize)-start+1)},(_,i)=>start+i).filter(n=>!uploaded.has(n))}));
  const {parts}=await signed.get(start);const part=parts.find(x=>x.partNumber===number);if(!part)throw new Error('Missing signed upload part');return part.url;
 }
 try{
  let nextPart=1;
  await Promise.all(Array.from({length:4},async()=>{for(;;){
   const number=nextPart++;if(number>Math.ceil(info.size/asset.partSize))return;
   if(uploaded.has(number))continue;
   const size=Math.min(asset.partSize,info.size-(number-1)*asset.partSize);
   const buffer=Buffer.alloc(size);let readBytes=0;
   while(readBytes<size){const result=await handle.read(buffer,readBytes,size-readBytes,(number-1)*asset.partSize+readBytes);if(!result.bytesRead)throw new Error('Unexpected EOF');readBytes+=result.bytesRead;}
   for(let attempt=0;;attempt++){
    try{const response=await fetch(await partUrl(number,attempt>0),{method:'PUT',body:buffer,signal:AbortSignal.timeout(180000)});if(!response.ok||!response.headers.get('etag'))throw new Error('R2 part rejected '+response.status);break;}
    catch(error){if(attempt>=5)throw error;await sleep(1000*2**attempt);}
   }
  }}));
 }finally{await handle.close();}
 const document=await completeUpload(asset.id);asset.complete=true;asset.documentId=document.id;await save(statePath,state);return asset;
}
async function fileHash(file){const hash=crypto.createHash('sha256');const handle=await fs.open(file,'r');try{for await(const chunk of handle.createReadStream())hash.update(chunk);}finally{await handle.close();}return hash.digest('hex');}
async function command(argv){await new Promise((resolve,reject)=>{const child=spawn(argv[0],argv.slice(1),{stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',b=>error+=b.toString().slice(0,2000));child.on('close',code=>code===0?resolve():reject(new Error('Archive verification failed: '+error)));});}
async function cloudHash(client,bucket,key,destination){
 const request=await client.sign(`https://${ACCOUNT}.r2.cloudflarestorage.com/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`,{method:'GET',headers:{'Accept-Encoding':'identity'}});
 const response=await fetch(request,{signal:AbortSignal.timeout(600000)});
 if(response.status===404)return null;if(!response.ok)throw new Error('R2 read failed '+response.status);
 const hash=crypto.createHash('sha256');let bytes=0;let file;
 if(destination){await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});file=await fs.open(destination,'w',0o600);}
 try{for await(const block of response.body){hash.update(block);bytes+=block.length;if(file){let offset=0;while(offset<block.length){const {bytesWritten}=await file.write(block,offset,block.length-offset);if(!bytesWritten)throw new Error('Download write failed');offset+=bytesWritten;}}}}finally{await file?.close();}
 return {sha256:hash.digest('hex'),bytes};
}
async function verify(asset,record,client){
 const [version]=await d1('SELECT storage_key,size,sha256,document_id FROM versions WHERE id=?',[asset.versionId]);
 if(!version||version.size!==asset.bytes||version.document_id!==asset.documentId)throw new Error('Version metadata mismatch');
 const destination=record?path.join(stage,'downloads',record.name):undefined;
 const primary=await cloudHash(client,'papra-drive',version.storage_key,destination);
 if(!primary||primary.bytes!==asset.bytes||primary.sha256!==asset.sha256)throw new Error('Primary checksum mismatch');
 if(record){await command(['python3',path.join(path.dirname(fileURLToPath(import.meta.url)),'archive.py'),'verify','--destination',stage,'--archive',destination]);await fs.unlink(destination);}
 let backup;
 for(let attempt=0;attempt<180;attempt++){
  backup=await cloudHash(client,'papra-drive-backups',`originals/${asset.versionId}/original`);
  if(backup)break;
  if(attempt%6===0)console.log(JSON.stringify({waiting_for_backup:asset.label,minutes:Math.round(attempt/3)}));
  await sleep(20000);
 }
 if(!backup||backup.bytes!==asset.bytes||backup.sha256!==asset.sha256)throw new Error('Backup checksum mismatch or missing');
 return {document_id:asset.documentId,version_id:asset.versionId,primary_key:version.storage_key,backup_key:`originals/${asset.versionId}/original`,primary_sha256:primary.sha256,backup_sha256:backup.sha256,contents_verified:!!record,bytes:asset.bytes,verified_at:new Date().toISOString()};
}
const mode=process.argv[3]||'upload';
if(mode==='revoke'){
 await identityGuard();auth=await read(authPath);await d1('UPDATE service_tokens SET revoked_at=? WHERE id=? AND user_id=? AND organization_id=?',[Date.now(),auth.credentialId,USER,ORG]);await fs.unlink(authPath);console.log(JSON.stringify({revoked:true}));
}else{
 auth=await bootstrap();
 if(mode==='upload'){
  const archiveFolder=await folder('Lossless archives');
  // Archives.json is written atomically as packing proceeds. Resume never repeats completed objects.
  for(;;){
   let records=[];try{records=await read(path.join(stage,'archives.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
   for(const record of records){if(state.assets[record.name]?.complete)continue;const asset=await upload(record.path,'application/gzip',archiveFolder);console.log(JSON.stringify({uploaded:asset.label,bytes:asset.bytes,completed_archives:records.filter(r=>state.assets[r.name]?.complete).length}));}
   try{await fs.access(path.join(stage,'task-metadata.json'));if(records.reduce((total,record)=>total+record.files.length,0)===selection.files.length)break;}catch{}
   await sleep(5000);
  }
  const metadataFolder=await folder('Manifests and restore instructions');
  for(const name of ['task-metadata.json','selection.json','archives.json'])await upload(path.join(stage,name),'application/json',metadataFolder);
  await save(path.join(stage,'raw-upload-complete.json'),{archives_uploaded:Object.values(state.assets).filter(asset=>asset.complete&&asset.label.endsWith('.tar.gz')).length,folderId:auth.folderId});
  console.log(JSON.stringify({archives_uploaded:Object.values(state.assets).filter(asset=>asset.complete&&asset.label.endsWith('.tar.gz')).length,folderId:auth.folderId}));
 }else if(mode==='verify'){
  const secrets=await read(path.join(config,'worker-secrets.json'));
  const client=new AwsClient({accessKeyId:secrets.R2_ACCESS_KEY_ID,secretAccessKey:secrets.R2_SECRET_ACCESS_KEY,service:'s3',region:'auto'});
  const receiptPath=path.join(stage,'verification-receipt.json');let receipt;try{receipt=await read(receiptPath);}catch(error){if(error.code!=='ENOENT')throw error;receipt={organization_id:ORG,folder_id:auth.folderId,archives:{},assets:{}};}
  const records=await read(path.join(stage,'archives.json'));
  let nextArchive=0;
  await Promise.all(Array.from({length:3},async()=>{for(;;){const index=nextArchive++;if(index>=records.length)return;const record=records[index];if(receipt.archives[record.name])continue;let asset;for(;;){state=await read(statePath);asset=state.assets[record.name];if(asset?.complete)break;await sleep(10000);}receipt.archives[record.name]=await verify(asset,record,client);await save(receiptPath,receipt);console.log(JSON.stringify({verified_archives:Object.keys(receipt.archives).length,total:records.length}));}}));
  for(const name of ['task-metadata.json','selection.json','archives.json']){if(receipt.assets[name])continue;for(;;){state=await read(statePath);if(state.assets[name]?.complete)break;await sleep(10000);}receipt.assets[name]=await verify(state.assets[name],null,client);await save(receiptPath,receipt);}
  receipt.metadata_verified=true;receipt.all_uploads_verified=records.reduce((total,record)=>total+record.files.length,0)===selection.files.length&&Object.keys(receipt.archives).length===records.length;await save(receiptPath,receipt);
  // Receipt upload is performed by finish after concurrent primary transfers stop.
  console.log(JSON.stringify({all_uploads_verified:receipt.all_uploads_verified}));
 }else if(mode==='copy-missing-backups'){
  const secrets=await read(path.join(config,'worker-secrets.json'));
  const client=new AwsClient({accessKeyId:secrets.R2_ACCESS_KEY_ID,secretAccessKey:secrets.R2_SECRET_ACCESS_KEY,service:'s3',region:'auto'});
  const records=await read(path.join(stage,'archives.json'));
  const names=[...records.map(record=>record.name),'task-metadata.json','selection.json','archives.json'];
  let next=0;const copied=[];
  await Promise.all(Array.from({length:4},async()=>{for(;;){const index=next++;if(index>=names.length)return;const asset=state.assets[names[index]];if(!asset?.complete)throw new Error('Primary is not complete');
   const [version]=await d1('SELECT v.storage_key,v.size,v.document_id FROM versions v JOIN documents d ON d.id=v.document_id WHERE v.id=? AND d.organization_id=?',[asset.versionId,ORG]);
   if(!version||version.document_id!==asset.documentId||version.size!==asset.bytes)throw new Error('Backup target identity mismatch');
   const key=`originals/${asset.versionId}/original`,url=`https://${ACCOUNT}.r2.cloudflarestorage.com/papra-drive-backups/${key}`;
   const head=await client.fetch(url,{method:'HEAD',headers:{'Accept-Encoding':'identity'}});if(head.ok){if(head.headers.get('content-length')===null){const existing=await cloudHash(client,'papra-drive-backups',key);if(!existing||existing.bytes!==asset.bytes||existing.sha256!==asset.sha256)throw new Error('Existing backup content mismatch');}else if(Number(head.headers.get('content-length'))!==asset.bytes)throw new Error(`Existing backup size mismatch for ${asset.label}: expected ${asset.bytes}, stored ${head.headers.get('content-length')}`);continue;}if(head.status!==404)throw new Error('Backup HEAD failed '+head.status);
   const sourceUrl=`https://${ACCOUNT}.r2.cloudflarestorage.com/papra-drive/${version.storage_key}`;
   const source=await client.fetch(sourceUrl,{method:'HEAD',headers:{'Accept-Encoding':'identity'}});if(source.ok&&source.headers.get('content-length')===null){const actual=await cloudHash(client,'papra-drive',version.storage_key);if(!actual||actual.bytes!==asset.bytes||actual.sha256!==asset.sha256)throw new Error('Copy source content mismatch');}if(!source.ok||(source.headers.get('content-length')!==null&&Number(source.headers.get('content-length'))!==asset.bytes))throw new Error('Copy source missing or changed');
   const response=await client.fetch(url,{method:'PUT',headers:{'x-amz-copy-source':`/papra-drive/${version.storage_key}`,'x-amz-copy-source-if-match':source.headers.get('etag')},signal:AbortSignal.timeout(120000)});
   const xml=await response.text();if(!response.ok||xml.includes('<Error>')||!xml.includes('<ETag>'))throw new Error('Backup copy failed '+response.status);
   copied.push({name:asset.label,versionId:asset.versionId,sourceKey:version.storage_key,backupKey:key,bytes:asset.bytes,providerAcceptedAt:new Date().toISOString(),independentlyVerified:false});
   console.log(JSON.stringify({backup_copies_accepted:copied.length,name:asset.label}));
  }}));
  await save(path.join(stage,'backup-copy-receipt.json'),copied);
 }else if(mode==='dispatch-pending-archives'){
  const archiveFolder=state.folders['Lossless archives'];if(!archiveFolder)throw new Error('Archive folder missing');
  const jobs=await d1("SELECT j.id,j.generation FROM jobs j JOIN versions v ON v.id=j.version_id JOIN documents d ON d.id=v.document_id WHERE d.organization_id=? AND d.home_folder_id=? AND j.status='pending' AND j.kind IN ('backup','hash','backup-hash') AND j.updated_at<? LIMIT 100",[ORG,archiveFolder,Date.now()-180000]);
  if(jobs.length){const admin=await read(path.join(config,'cloudflare-auth-session.json'));const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/queues/3cfb0cf1537d4c63baf3888d8ff1eaf9/messages/batch`,{method:'POST',headers:{Authorization:`Bearer ${admin.token}`,'Content-Type':'application/json'},body:JSON.stringify({messages:jobs.map(job=>({content_type:'json',body:{jobId:job.id,generation:job.generation}}))})});const result=await response.json();if(!response.ok||!result.success)throw new Error('Queue publication failed '+response.status);console.log(JSON.stringify({redispatched_pending_archive_jobs:jobs.length,queue_metrics:result.result?.metadata?.metrics}));}
  else console.log(JSON.stringify({redispatched_pending_archive_jobs:0}));
 }else if(mode==='status'){
  const rows=await d1('SELECT j.kind,j.status,j.error,count(*) AS count FROM jobs j JOIN versions v ON v.id=j.version_id JOIN documents d ON d.id=v.document_id WHERE d.organization_id=? AND d.home_folder_id IN (SELECT id FROM folders WHERE parent_id=? OR id=?) GROUP BY j.kind,j.status,j.error ORDER BY j.kind,j.status',[ORG,auth.folderId,auth.folderId]);
  console.log(JSON.stringify({jobs:rows}));
 }else if(mode==='audit'){
  const target=await folder('Manifests and restore instructions');
  for(const name of ['deletion-receipt.json','local-audit.json'])await upload(path.join(stage,name),'application/json',target);
  console.log(JSON.stringify({deletion_receipt_uploaded:true}));
 }else if(mode==='finish'){
  const target=await folder('Manifests and restore instructions');
  for(const name of ['verification-receipt.json','transcripts.json','search-documents.json','README.md'])await upload(path.join(stage,name),name.endsWith('.md')?'text/markdown':'application/json',target);
  console.log(JSON.stringify({receipts_uploaded:true}));
 }else if(mode==='transcripts'){
  const records=await read(path.join(stage,'search-documents.json'));
  const destinations={main:await folder('Main task conversations'),subagent:await folder('Subagent conversations'),unindexed:await folder('Unindexed conversations')};
  let next=0,done=0;
  await Promise.all(Array.from({length:12},async()=>{for(;;){const i=next++;if(i>=records.length)return;const record=records[i];await upload(record.path,'text/markdown',destinations[record.kind],record.name);done++;if(done%25===0||done===records.length)console.log(JSON.stringify({searchable_documents_uploaded:done,total:records.length}));}}));
  await save(path.join(stage,'transcript-upload-complete.json'),{documents:records.length,completedAt:new Date().toISOString()});
 }else throw new Error('Unknown command');
}
