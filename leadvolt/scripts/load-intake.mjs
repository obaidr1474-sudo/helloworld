// Local/staging exercise. Always creates a new fictional workspace; never contacts a provider.
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {io} from 'socket.io-client';
if(process.env.LOAD_TEST_ALLOW_FICTIONAL!=='1')throw Error('Set LOAD_TEST_ALLOW_FICTIONAL=1 only on a development/staging installation where fictional workspaces are allowed.');
const base=process.env.LOAD_TEST_URL??'http://localhost:4000';
const count=Number(process.env.LOAD_TEST_COUNT??200),concurrency=Number(process.env.LOAD_TEST_CONCURRENCY??20);
if(!Number.isInteger(count)||count<1||count>250||!Number.isInteger(concurrency)||concurrency<1||concurrency>50)throw Error('Use 1–250 enquiries and 1–50 concurrent requests.');
const slug='load-fixture-'+crypto.randomBytes(5).toString('hex'),password=crypto.randomBytes(24).toString('base64url');
async function request(path,body,token){const res=await fetch(base+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});if(!res.ok)throw Error('Fixture setup failed: '+path+' HTTP '+res.status);return res.json();}
const registered=await request('/auth/register',{company:'Load exercise (fictional)',slug,name:'Fixture Owner',email:'owner@load.example.test',password});
const token=registered.token;
const agent=await request('/users',{name:'No BRN fixture agent',email:'agent@load.example.test',password,role:'agent'},token);
await request('/routing/listings',{source:'bayut',listingRef:'LOAD-FIXTURE-REF',responsibleAgentId:agent.id},token);
const secret=(await request('/settings/intake-secret/reveal',{},token)).secret;
const agentToken=(await request('/auth/login',{workspace:slug,email:'agent@load.example.test',password})).token;
const socket=io(base,{path:'/ws',auth:{token:agentToken},transports:['websocket']});
const started=new Map(),screenLatencies=[],acceptedLatencies=[],frames=new Set();let failures=0,duplicates=0,next=0;
const finished=performance.now();
try{
 await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);setTimeout(()=>reject(Error('Socket connection timeout')),10000).unref();});
 socket.on('event',event=>{if(event.type==='lead.created'&&/^Fictional load buyer \d+$/.test(event.data.name)){const n=Number(event.data.name.split(' ').at(-1));if(!frames.has(n)){frames.add(n);screenLatencies.push(performance.now()-started.get(n));}}});
 async function deliver(n){
  const body=JSON.stringify({event_id:'load-event-'+n,contact:{name:'Fictional load buyer '+n,phone:'+971509'+String(n).padStart(6,'0')},listing:{reference:'LOAD-FIXTURE-REF'}});
  const timestamp=String(Math.floor(Date.now()/1000)),signature='sha256='+crypto.createHmac('sha256',secret).update(timestamp+'.bayut.'+body).digest('hex');
  const begin=performance.now();
  const res=await fetch(base+'/api/v1/intake/portal?source=bayut',{method:'POST',headers:{'Content-Type':'application/json','X-LeadVolt-Workspace':slug,'X-LeadVolt-Timestamp':timestamp,'X-LeadVolt-Signature':signature},body,signal:AbortSignal.timeout(20000)});
  const data=await res.json();acceptedLatencies.push(performance.now()-begin);
  if(!res.ok||data.ownerId!==agent.id)failures++;if(data.duplicate)duplicates++;
 }
 const beginning=performance.now();
 await Promise.all(Array.from({length:concurrency},async()=>{for(;;){const n=next++;if(n>=count)return;started.set(n,performance.now());await Promise.all([deliver(n),deliver(n)]);}}));
 const deadline=Date.now()+20000;
 while(frames.size<count&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
 const totals=await request('/leads/counts?queue=all',undefined,agentToken);
 const percentile=(values,p)=>Math.round([...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]??0);
 const result={fictionalWorkspace:slug,enquiries:count,httpDeliveries:count*2,concurrency,providerRetries:duplicates,wrongOwnerOrFailedDelivery:failures,savedLeads:totals.all,agentLiveNotifications:frames.size,httpP50Ms:percentile(acceptedLatencies,.5),httpP95Ms:percentile(acceptedLatencies,.95),agentNotificationP95Ms:percentile(screenLatencies,.95),elapsedMs:Math.round(performance.now()-beginning),environment:'Local/staging fixture exercise; not a production capacity guarantee'};
 if(failures||duplicates!==count||totals.all!==count||frames.size!==count)throw Error('Intake exercise failed: '+JSON.stringify(result));
 console.log(JSON.stringify(result,null,2));
}finally{socket.close();}
