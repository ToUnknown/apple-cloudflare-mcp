import test from 'node:test';
import assert from 'node:assert/strict';
import {PermissionCache, PERMISSION_MS, POLL_MS, pollDelay, type PermissionSnapshot} from '../src/event-permissions';
import {scanInboxBatch} from '../src/event-imap';
import type {ImapFlow} from 'imapflow';
test('hourly permissions persist across restart, expire, and fail closed', async () => {
  let now = 100000, calls = 0, fail = false;
  let stored: PermissionSnapshot | undefined;
  let grants = [{id:'g',clientId:'c',scope:['mail'],expiresAt:0}];
  const deps = {now:()=>now,load:async()=>stored,save:async(s:PermissionSnapshot)=>{stored=s;},fetch:async()=>{calls++;if(fail)throw Error('offline');return structuredClone(grants);}};
  const p={userId:'owner',clientId:'c',grantId:'g'};
  assert.equal(await new PermissionCache(deps).authorized(p),true);
  grants=[];
  for(let i=0;i<120;i++) {now+=POLL_MS-1;assert.equal(await new PermissionCache(deps).authorized(p),true);}
  assert.equal(calls,1);
  now=100000+PERMISSION_MS;fail=true;
  await assert.rejects(new PermissionCache(deps).authorized(p));
  fail=false;assert.equal(await new PermissionCache(deps).authorized(p),false);
  assert.equal(await new PermissionCache(deps).authorized({...p,userId:'other'}),false);
  grants=[{id:'g',clientId:'c',scope:['mail'],expiresAt:(now+1000)/1000}];
  assert.equal(await new PermissionCache(deps).authorized(p,true),true);
  now+=1000;assert.equal(await new PermissionCache(deps).authorized(p),false);
});
test('one shared read-only scan preserves independent checkpoints and resets',async()=>{
  let locks=0,fetches=0,releases=0;
  const client={mailbox:{uidValidity:1n,uidNext:40},getMailboxLock:async(_name:string,opts:unknown)=>{assert.deepEqual(opts,{readOnly:true});locks++;return{release(){releases++;}};},fetch:async function*(range:string){fetches++;assert.equal(range,'10:19');yield {uid:12,internalDate:new Date(),envelope:{subject:'new'}};yield {uid:18,internalDate:new Date(),envelope:{subject:'later'}};}} as unknown as ImapFlow;
  const result=await scanInboxBatch(client,[{uidValidity:'1',nextUid:10},{uidValidity:'1',nextUid:15},{uidValidity:'1',nextUid:30},{uidValidity:'old',nextUid:8}]);
  assert.equal(locks,1);assert.equal(fetches,1);assert.equal(releases,1);
  assert.deepEqual(result.map(r=>r.position.nextUid),[20,20,30,40]);
  assert.deepEqual(result.map(r=>r.messages.map(m=>m.uid)),[[12,18],[18],[],[]]);
  assert.deepEqual(result.map(r=>r.reset),[false,false,false,true]);
});
test('healthy polling is 30 seconds and failures back off with a cap',()=>{
 assert.equal(pollDelay(0),30000);assert.equal(pollDelay(1),60000);assert.equal(pollDelay(100),900000);
});
