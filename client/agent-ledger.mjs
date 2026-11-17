#!/usr/bin/env node
// Dependency-free agent CLI. Node.js >=20. Never prints bearer credentials.
import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

const endpoint=(process.env.LEDGER_URL||"http://127.0.0.1:4177").replace(/\/+$/,"");
const token=process.env.LEDGER_TOKEN||"";
const spool=resolve(process.env.LEDGER_SPOOL_DIR||"./spool");
const usage="Usage: agent-ledger.mjs runs [status] | run ID | active | events [runId] | issue REPO NUMBER | emit FILE|- | replay | usage FILE";
function requireToken() {if(!token) throw new Error("LEDGER_TOKEN is required");}
async function request(method,path,body) {
  requireToken();
  const response=await fetch(endpoint+path,{method,headers:{Authorization:"Bearer "+token,...(body!==undefined?{"Content-Type":"application/json"}:{})},body:body===undefined?undefined:JSON.stringify(body)});
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
async function emit(file) {
  const raw=file==="-"?await new Promise((resolveInput,reject)=>{
    let data="";process.stdin.setEncoding("utf8");
    process.stdin.on("data",chunk=>data+=chunk);process.stdin.on("end",()=>resolveInput(data));process.stdin.on("error",reject);
  }):readFileSync(file,"utf8");
  const data=JSON.parse(raw);
  if(!data.event_id || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(data.event_id))throw new Error("Valid event_id required before spooling");
  mkdirSync(spool,{recursive:true,mode:0o700});
  const name=Date.now().toString().padStart(16,"0")+"-"+randomUUID()+".json";
  const path=join(spool,name),temp=path+".tmp";
  writeFileSync(temp,JSON.stringify(data)+"\n",{mode:0o600});
  renameSync(temp,path);
  try {
    const result=await sendFile(path);
    unlinkSync(path);
    process.stdout.write(JSON.stringify(result,null,2)+"\n");
  }catch(err){
    process.stderr.write("Event retained in "+path+"; replay later. "+String(err)+"\n");
    process.exitCode=1;
  }
}
async function replay() {
  mkdirSync(spool,{recursive:true,mode:0o700});
  const files=readdirSync(spool).filter(f=>f.endsWith(".json")).sort();
  let done=0;
  for(const file of files) {
    const path=join(spool,file);
    try {await sendFile(path);unlinkSync(path);done++;}
    catch(err){process.stderr.write("Stopped replay at "+file+": "+String(err)+"\n");process.exitCode=1;break;}
  }
  process.stdout.write(JSON.stringify({replayed:done,remaining:files.length-done})+"\n");
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
