import {test,expect,afterEach,vi} from 'vitest';
import {Miniflare} from 'miniflare';
import {Hono} from 'hono';
import {readFile} from 'node:fs/promises';
import {URL as NodeURL} from 'node:url';
import {build} from 'esbuild';
import {PDF} from '@libpdf/core';
import type {AppEnv,Env,Identity} from './types';
import {registerReviewRoutes} from './reviews';
import {registerSigningRoutes} from './signing';
import {registerAuthoringRoutes} from './authoring';
import {validateSource} from './authoring-pdf';
vi.mock('./jobs',()=>({enqueueVersion:vi.fn(async()=>{})}));
const instances:Miniflare[]=[];afterEach(async()=>{for(const m of instances.splice(0))await m.dispose();});
const key='a'.repeat(32),token='b'.repeat(32),source={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'TEST ONLY - Native document'}]}]};
async function fixture(){
 const m=new Miniflare({modules:true,script:'export default {fetch(){return new Response("OK")}}',compatibilityDate:'2026-07-21',d1Databases:['DB'],r2Buckets:['FILES','BACKUPS']});instances.push(m);const DB=await m.getD1Database('DB');await DB.exec(await readFile(new NodeURL('../schema.sql',import.meta.url),'utf8'));const env={AUTH_SECRET:'test-review-secret'.repeat(4),AUTH_LIMITER:{limit:async()=>({success:true})},APP_URL:'https://test.example',DB,FILES:await m.getR2Bucket('FILES'),BACKUPS:await m.getR2Bucket('BACKUPS')} as unknown as Env;
 await DB.prepare("INSERT INTO organizations(id,name,created_at,updated_at) VALUES ('org','org',1,1)").run();
 for(const user of ['owner','writer']){await DB.prepare('INSERT INTO users(id,google_sub,email,email_verified,name,created_at,updated_at) VALUES (?,?,?,1,?,1,1)').bind(user,user,`${user}@ai.engineer`,user).run();await DB.prepare('INSERT INTO organization_members(id,organization_id,user_id,role,created_at,updated_at) VALUES (?,\'org\',?,?,1,1)').bind(user,user,user==='owner'?'owner':'member').run();}
 await DB.prepare("INSERT INTO folders(id,organization_id,name,is_home,is_restricted,created_by,created_at,updated_at) VALUES ('fld_home_org','org','Home',1,0,'owner',1,1)").run();
 const app=new Hono<AppEnv>();app.use('*',async(c,next)=>{const user=c.req.header('X-Test-User')||'owner';c.set('identity',{userId:user,email:`${user}@ai.engineer`,name:user,organizations:[{id:'org',name:'org',role:'owner'}]} as Identity);await next();});registerAuthoringRoutes(app);registerReviewRoutes(app);registerSigningRoutes(app);
 const request=(path:string,body?:unknown,user='owner')=>app.request(`https://test.example${path}`,body?{method:'POST',headers:{'Content-Type':'application/json','X-Test-User':user},body:JSON.stringify(body)}:{headers:{'X-Test-User':user}},env,{waitUntil:()=>{},passThroughOnException:()=>{},props:{}});
 const create=()=>request('/api/organizations/org/authored-documents',{key,name:'TEST ONLY',source});const base=`/api/organizations/org/documents/doc_${key.slice(0,24)}/editor`;return {env,DB,request,create,base};
}

test('review links pin one version, support idempotent proposals and close when the sender loses authority',async()=>{
 const f=await fixture();await f.create();const base=f.base.replace('/editor','/reviews');expect((await f.request(base,{},'writer')).status).toBe(403);const created=await (await f.request(base,{})).json() as any;const linkToken=created.url.split('/').pop();expect((await f.request('/api/reviews/'+linkToken+'bad')).status).toBe(404);const viewed=await (await f.request('/api/reviews/'+linkToken)).json() as any;expect(viewed.source).toEqual(source);
 const payload={key:'c'.repeat(32),name:'TEST ONLY Reviewer',comment:'Please revise the text',source:{...source,content:[{type:'paragraph',content:[{type:'text',text:'TEST ONLY - proposed revision'}]}]}};expect((await f.request('/api/reviews/'+linkToken+'/proposals',payload)).status).toBe(201);expect((await f.request('/api/reviews/'+linkToken+'/proposals',payload)).status).toBe(200);expect((await f.DB.prepare('SELECT count(*) n FROM review_proposals').first())?.n).toBe(1);await f.DB.prepare("UPDATE organization_members SET role='member' WHERE user_id='owner'").run();expect((await f.request('/api/reviews/'+linkToken)).status).toBe(410);
});
test('accepting a proposal publishes its PDF and source atomically; unresolved feedback blocks signing',async()=>{
 const f=await fixture();await f.create();const base=f.base.replace('/editor','/reviews'),signing=f.base.replace('/editor','/signing');const created=await (await f.request(base,{})).json() as any,linkToken=created.url.split('/').pop();const proposed={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'TEST ONLY - accepted changes'}]}]};await f.request('/api/reviews/'+linkToken+'/proposals',{key:'c'.repeat(32),name:'Test reviewer',comment:'Proposed text',source:proposed});expect((await f.request(signing,{idempotencyKey:'test',versionId:'ver_'+key})).status).toBe(409);
 await f.request(f.base+'/lock',{token:'b'.repeat(32)});const save={key:'d'.repeat(32),token:'b'.repeat(32),versionId:'ver_'+key,source:proposed,proposalId:'proposal_'+'c'.repeat(32)};const result=await f.request(f.base,save);expect(result.status).toBe(200);const p=await f.DB.prepare('SELECT * FROM review_proposals').first<any>();expect(p.status).toBe('accepted');expect(p.published_version_id).toBe('ver_'+'d'.repeat(32));const row=await f.DB.prepare('SELECT source_json FROM authored_versions WHERE version_id=?').bind(p.published_version_id).first<any>();expect(JSON.parse(row.source_json)).toEqual(proposed);expect((await f.request('/api/reviews/'+linkToken+'/proposals',{key:'e'.repeat(32),name:'Test reviewer',comment:'Late change'})).status).toBe(409);
});
test('a proposed edit cannot be accepted with altered content or after rejection',async()=>{
 const f=await fixture();await f.create();const base=f.base.replace('/editor','/reviews'),created=await (await f.request(base,{})).json() as any,linkToken=created.url.split('/').pop();await f.request('/api/reviews/'+linkToken+'/proposals',{key:'c'.repeat(32),name:'Test reviewer',comment:'Test',source});await f.request(f.base+'/lock',{token});const save={key:'d'.repeat(32),token,versionId:'ver_'+key,source,proposalId:'proposal_'+'c'.repeat(32)};expect((await f.request(f.base,{...save,source:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Different text'}]}]}})).status).toBe(409);await f.request(base+'/proposals/'+save.proposalId+'/resolve',{status:'rejected'});expect((await f.request(f.base,save)).status).toBe(409);expect((await f.DB.prepare('SELECT count(*) n FROM versions').first())?.n).toBe(1);
});

test('sending the approved PDF closes its review links and rejects later feedback',async()=>{const f=await fixture();await f.create();Object.assign(f.env,{SIGNING_P12:'configured',SIGNING_PASSPHRASE:'configured',RESEND_API_KEY:'configured',SIGNING_FROM:'TEST ONLY <test@example.com>',JOBS:{send:async()=>{}}});const created=await (await f.request(f.base.replace('/editor','/reviews'),{})).json() as any,linkToken=created.url.split('/').pop();const response=await f.request(f.base.replace('/editor','/signing'),{idempotencyKey:'send-test',versionId:'ver_'+key,recipients:[{name:'Test signer',email:'test@example.com'}],fields:[{type:'signature',recipient:0,page:1,x:.1,y:.7,width:.3,height:.07}]});expect(response.status).toBe(201);expect((await f.request('/api/reviews/'+linkToken)).status).toBe(410);expect((await f.request('/api/reviews/'+linkToken+'/proposals',{key:'c'.repeat(32),name:'Test',comment:'Late'})).status).toBe(410);});
