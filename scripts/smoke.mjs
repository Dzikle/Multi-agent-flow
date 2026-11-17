#!/usr/bin/env node
// Standalone HTTP smoke test. Start server before invoking.
import { randomUUID } from "node:crypto";
const url=(process.env.LEDGER_URL||"http://127.0.0.1:4177").replace(/\/+$/,"");
const token=process.env.LEDGER_TOKEN;
if(!token)throw new Error("Set LEDGER_TOKEN to the dispatcher token");
const run="smoke-"+randomUUID(),attempt="smoke-attempt-"+randomUUID();
async function call(method,path,body) {
 const r=await fetch(url+path,{method,headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:body?JSON.stringify(body):undefined});
 const json=await r.json();if(!r.ok)throw new Error(method+" "+path+" "+r.status+" "+JSON.stringify(json));
 return json;
}
const event=(type,attempt_id,data={})=>({event_id:randomUUID(),type,run_id:run,attempt_id,actor:"smoke-test",data});
await call("POST","/v1/events",event("run.created",undefined,{work_item:{source:"smoke",repository:"test/local",external_id:run,title:"smoke"}}));
await call("POST","/v1/events",event("run.started"));
await call("POST","/v1/events",event("attempt.started",attempt,{role:"developer",phase:"implementation",provider:"test"}));
await call("POST","/v1/events",event("attempt.succeeded",attempt,{exit_code:0}));
await call("POST","/v1/events",event("run.completed",undefined,{result:"verified"}));
const result=await call("GET","/v1/runs/"+encodeURIComponent(run));
if(result.status!=="completed"||result.attempts?.[0]?.status!=="succeeded")throw new Error("Smoke verification failed");
process.stdout.write(JSON.stringify({ok:true,run_id:run,attempt_id:attempt,events:5,status:result.status},null,2)+"\n");
