#!/usr/bin/env node
// Dependency-free agent CLI. Node.js 22 LTS. Never prints bearer credentials.
import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, linkSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

const endpoint=(process.env.LEDGER_URL||"http://127.0.0.1:4177").replace(/\/+$/,"");
const token=process.env.LEDGER_TOKEN||"";
const spool=resolve(process.env.LEDGER_SPOOL_DIR||"./spool");
const timeoutMs=Number(process.env.LEDGER_HTTP_TIMEOUT_MS||5000);
const usage="Usage: agent-ledger.mjs runs [status] | run ID | active | events [runId] | issue REPO NUMBER | emit FILE|- | replay | usage FILE";
function requireToken() {if(!token) throw new Error("LEDGER_TOKEN is required");}
async function request(method,path,body) {
  requireToken();
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new Error("LEDGER_HTTP_TIMEOUT_MS must be an integer between 1 and 60000");
  const response=await fetch(endpoint+path,{method,headers:{Authorization:"Bearer "+token,...(body!==undefined?{"Content-Type":"application/json"}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
  const text=await response.text();
  let payload;
  try{payload=JSON.parse(text)}catch{throw new Error("HTTP "+response.status+": invalid JSON response");}
  if(!response.ok)throw new Error("HTTP "+response.status+": "+JSON.stringify(payload.error||payload));
  return payload;
}
async function sendFile(path) {
  const body=JSON.parse(readFileSync(path,"utf8"));
  return request("POST","/v1/events",body);
}
function spoolFiles() {return readdirSync(spool).filter(f=>f.endsWith(".json")).sort();}
function retainEvent(data) {
  mkdirSync(spool,{recursive:true,mode:0o700});
  const temp=join(spool,"."+randomUUID()+".tmp");
  writeFileSync(temp,JSON.stringify(data)+"\n",{mode:0o600,flag:"wx",flush:true});
  try {
    for(;;) {
      // A monotonic queue position survives clock rollback and same-ms emits.
      let position=BigInt(Date.now());
      for(const file of spoolFiles()) {
        const match=/^(\d{16})(?:-|\.json$)/.exec(file);
        if(match && BigInt(match[1])>=position)position=BigInt(match[1])+1n;
      }
      // Never reuse an old entry's pathname: another replay can still hold its
      // ACK after that file was removed. Concurrent producers use distinct keys;
      // queued entries observed before publication retain their earlier prefix.
      const path=join(spool,position.toString().padStart(16,"0")+"-"+randomUUID()+".json");
      try {
        // Publish complete flushed bytes atomically, without overwriting an entry.
        linkSync(temp,path);
        return path;
      }catch(err){if(err.code!=="EEXIST")throw err;}
    }
  }finally{unlinkSync(temp);}
}
async function drain(target) {
  mkdirSync(spool,{recursive:true,mode:0o700});
  const files=spoolFiles();
  let done=0,result;
  for(const file of files) {
    const path=join(spool,file);
    try {
      const ack=await sendFile(path);
      try{unlinkSync(path);}catch(error){if(error.code!=="ENOENT")throw error;}
      done++;
      if(path===target)result=ack;
    }catch(error){
      // Unique paths are removed only after a committed ACK. Another consumer
      // may already have acknowledged this snapshot entry before we read it.
      if(error.code==="ENOENT"){done++;continue;}
      return {done,remaining:files.length-done,error,file,result};
    }
  }
  return {done,remaining:0,result};
}
async function emit(file) {
  const raw=file==="-"?await new Promise((resolveInput,reject)=>{
    let data="";process.stdin.setEncoding("utf8");
    process.stdin.on("data",chunk=>data+=chunk);process.stdin.on("end",()=>resolveInput(data));process.stdin.on("error",reject);
  }):readFileSync(file,"utf8");
  const data=JSON.parse(raw);
  if(!data || typeof data!=="object" || typeof data.event_id!=="string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(data.event_id))throw new Error("Valid event_id required before spooling");
  let path=retainEvent(data);
  const outcome=await drain(path);
  if(!outcome.error && !outcome.result){
    // A concurrent replay already removed our entry after its ACK. Retrieve the
    // original ACK by replaying identical data, and requeue if that request fails.
    try{outcome.result=await request("POST","/v1/events",data);}
    catch(error){path=retainEvent(data);outcome.error=error;outcome.file=path;}
  }
  if(outcome.error){
    process.stderr.write("Event retained in "+path+"; replay later. Stopped at "+outcome.file+": "+String(outcome.error)+"\n");
    process.exitCode=1;
  }else process.stdout.write(JSON.stringify(outcome.result,null,2)+"\n");
}
async function replay() {
  const outcome=await drain();
  if(outcome.error){process.stderr.write("Stopped replay at "+outcome.file+": "+String(outcome.error)+"\n");process.exitCode=1;}
  process.stdout.write(JSON.stringify({replayed:outcome.done,remaining:outcome.remaining})+"\n");
}
const [command,...args]=process.argv.slice(2);
try {
  let result;
  switch(command){
    case "runs":result=await request("GET","/v1/runs"+(args[0]?"?status="+encodeURIComponent(args[0]):""));break;
    case "run":if(!args[0])throw new Error(usage);result=await request("GET","/v1/runs/"+encodeURIComponent(args[0]));break;
    case "active":result=await request("GET","/v1/agents/active");break;
    case "events":result=await request("GET","/v1/events"+(args[0]?"?run_id="+encodeURIComponent(args[0]):""));break;
    case "issue":if(args.length<2)throw new Error(usage);result=await request("GET","/v1/issues?source=github&repository="+encodeURIComponent(args[0])+"&external_id="+encodeURIComponent(args[1]));break;
    case "usage":if(!args[0])throw new Error(usage);result=await request("POST","/v1/usage",JSON.parse(readFileSync(args[0],"utf8")));break;
    case "emit":if(!args[0])throw new Error(usage);await emit(args[0]);break;
    case "replay":await replay();break;
    default:throw new Error(usage);
  }
  if(result!==undefined)process.stdout.write(JSON.stringify(result,null,2)+"\n");
}catch(err){process.stderr.write(String(err)+"\n");process.exitCode=1;}
