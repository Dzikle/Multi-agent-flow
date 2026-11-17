import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { buildApp } from "../src/server.js";
import type { LedgerConfig } from "../src/config.js";

const cliPath=resolve("client/agent-ledger.mjs");
const dispatcher=randomUUID()+randomUUID(), reader=randomUUID()+randomUUID();
const event=(type:string,run_id?:string,data:Record<string,unknown>={})=>({event_id:randomUUID(),type,run_id,actor:"cli-verification",data});
function fixture() {
  const root=mkdtempSync(join(tmpdir(),"lel-cli-")), spool=join(root,"spool"), artifactDir=join(root,"artifacts");
  mkdirSync(spool);mkdirSync(artifactDir);
  const config:LedgerConfig={dbPath:join(root,"ledger.db"),artifactDir,dispatcherToken:dispatcher,readToken:reader,host:"127.0.0.1",port:0,heartbeatTtlMs:120000,maxArtifactBytes:1048576};
  let app=buildApp(config), endpoint="";
  const start=async(port=0)=>{endpoint=await app.listen({host:config.host,port});return endpoint;};
  const stop=async()=>{await app.close();};
  const restart=async(port:number)=>{app=buildApp(config);return start(port);};
  const run=(args:string[],options:{token?:string;url?:string;timeoutMs?:string;input?:string}={})=>new Promise<{code:number;stdout:string;stderr:string}>((resolveResult,reject)=>{
    const child=execFile(process.execPath,[cliPath,...args],{
      env:{...process.env,LEDGER_URL:options.url??endpoint,LEDGER_TOKEN:options.token??dispatcher,LEDGER_SPOOL_DIR:spool,LEDGER_HTTP_TIMEOUT_MS:options.timeoutMs??"1000"},
      timeout:6000,maxBuffer:1024*1024
    },(err,stdout,stderr)=>{
      if(err && typeof err.code!=="number")return reject(err);
      resolveResult({code:err?.code as number??0,stdout,stderr});
    });
    if(options.input!==undefined)child.stdin!.end(options.input);
  });
  const emit=(body:unknown,options:Parameters<typeof run>[1]={})=>run(["emit","-"],{...options,input:JSON.stringify(body)});
  const get=async(path:string):Promise<Record<string,any>>=>{
    const response=await fetch(endpoint+path,{headers:{authorization:"Bearer "+reader,connection:"close"}});
    assert.equal(response.status,200);return response.json() as Promise<Record<string,any>>;
  };
  const close=async()=>{await app.close();rmSync(root,{recursive:true,force:true});};
  return {root,spool,config,start,stop,restart,run,emit,get,close,get endpoint(){return endpoint;}};
}

test("CLI retains offline events and drains them before a newer emit after service restart",async()=>{
  const ctx=fixture(),runId="cli-"+randomUUID();
  const created=event("run.created",runId,{work_item:{source:"github",repository:"verification/local",external_id:"cli"}});
  const started=event("run.started",runId);
  try{
    await ctx.start();const port=new URL(ctx.endpoint).port;
    await ctx.stop();
    const offline=await ctx.emit(created);assert.equal(offline.code,1);assert.match(offline.stderr,/retained/i);
    const queued=readdirSync(ctx.spool).filter(name=>name.endsWith(".json"));assert.equal(queued.length,1);
    assert.deepEqual(JSON.parse(readFileSync(join(ctx.spool,queued[0]),"utf8")),created);
    await ctx.restart(Number(port));
    const recovered=await ctx.emit(started);assert.equal(recovered.code,0,recovered.stderr);
    assert.equal(readdirSync(ctx.spool).filter(name=>name.endsWith(".json")).length,0);
    const history=await ctx.get("/v1/events?run_id="+runId);
    assert.deepEqual(history.events.map((entry:{event_id:string})=>entry.event_id),[created.event_id,started.event_id]);
    assert.equal((await ctx.get("/v1/runs/"+runId)).status,"running");
    await ctx.stop();await ctx.restart(Number(port));
    assert.equal((await ctx.get("/v1/runs/"+runId)).status,"running");
    const replay=await ctx.run(["replay"]);assert.equal(replay.code,0);assert.deepEqual(JSON.parse(replay.stdout),{replayed:0,remaining:0});
  }finally{await ctx.close();}
});

test("CLI spool allocation preserves append order when the producer clock goes backwards",async()=>{
  const ctx=fixture(),older=event("system.tick"),newer=event("system.idle");
  try{
    const previous="9999999999999998-older.json";
    writeFileSync(join(ctx.spool,previous),JSON.stringify(older));
    const result=await ctx.emit(newer,{url:"http://127.0.0.1:1"});assert.equal(result.code,1);
    const queued=readdirSync(ctx.spool).filter(name=>name.endsWith(".json")).sort();
    assert.equal(queued.length,2);
    assert.deepEqual(queued.map(name=>JSON.parse(readFileSync(join(ctx.spool,name),"utf8")).event_id),[older.event_id,newer.event_id]);
  }finally{await ctx.close();}
});

test("CLI times out an unresponsive HTTP service and retains the original event",async()=>{
  const ctx=fixture(),body=event("system.tick");
  const stalled=createServer((_request,_response)=>{});
  await new Promise<void>(done=>stalled.listen(0,"127.0.0.1",done));
  const address=stalled.address();assert.ok(address && typeof address!=="string");
  try{
    const before=Date.now();
    const result=await ctx.emit(body,{url:"http://127.0.0.1:"+address.port,timeoutMs:"100"});
    assert.equal(result.code,1);assert.ok(Date.now()-before<3000);assert.match(result.stderr,/tim(e|ed).*out/i);
    const queued=readdirSync(ctx.spool).filter(name=>name.endsWith(".json"));assert.equal(queued.length,1);
    assert.equal(JSON.parse(readFileSync(join(ctx.spool,queued[0]),"utf8")).event_id,body.event_id);
  }finally{stalled.closeAllConnections();await new Promise<void>(done=>stalled.close(()=>done()));await ctx.close();}
});

test("CLI process killed after commit retains its spool and replays with the original ID exactly once",async()=>{
  const ctx=fixture(),body=event("system.tick");
  let committed!:()=>void;
  const committedEvent=new Promise<void>(done=>{committed=done;});
  let proxyFailure:unknown;
  const proxy=createServer(async(request,_response)=>{
    try{
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      const response=await fetch(ctx.endpoint+"/v1/events",{method:"POST",headers:{authorization:"Bearer "+dispatcher,"content-type":"application/json"},body:Buffer.concat(chunks)});
      assert.equal(response.status,201);await response.text();
    }catch(err){proxyFailure=err;}finally{committed();}
    // Deliberately lose the server ACK, as if the client connection died.
  });
  let child:ReturnType<typeof spawn>|undefined;
  try{
    await ctx.start();const servicePort=Number(new URL(ctx.endpoint).port);
    await new Promise<void>(done=>proxy.listen(0,"127.0.0.1",done));
    const address=proxy.address();assert.ok(address && typeof address!=="string");
    child=spawn(process.execPath,[cliPath,"emit","-"],{stdio:["pipe","ignore","ignore"],env:{...process.env,LEDGER_URL:"http://127.0.0.1:"+address.port,LEDGER_TOKEN:dispatcher,LEDGER_SPOOL_DIR:ctx.spool,LEDGER_HTTP_TIMEOUT_MS:"5000"}});
    child.stdin!.end(JSON.stringify(body));
    await committedEvent;if(proxyFailure)throw proxyFailure;
    // Stop the real service while the CLI submission still awaits its ACK.
    await ctx.stop();
    const exited=new Promise<void>(done=>child!.once("exit",()=>done()));child.kill("SIGKILL");await exited;
    const queued=readdirSync(ctx.spool).filter(name=>name.endsWith(".json"));assert.equal(queued.length,1);
    assert.equal(JSON.parse(readFileSync(join(ctx.spool,queued[0]),"utf8")).event_id,body.event_id);
    await ctx.restart(servicePort);
    const replay=await ctx.run(["replay"]);assert.equal(replay.code,0,replay.stderr);
    assert.deepEqual(JSON.parse(replay.stdout),{replayed:1,remaining:0});
    const history=await ctx.get("/v1/events");assert.deepEqual(history.events.map((entry:{event_id:string})=>entry.event_id),[body.event_id]);
  }finally{
    if(child && child.exitCode===null && child.signalCode===null)child.kill("SIGKILL");
    proxy.closeAllConnections();await new Promise<void>(done=>proxy.close(()=>done()));await ctx.close();
  }
});

test("overlapping CLI replays cannot delete a newer queued event after clock rollback",async()=>{
  const ctx=fixture(),older=event("system.tick"),newer=event("system.idle"),fixed=1794950000000;
  const preloader=join(ctx.root,"interleave.mjs"),published=join(ctx.root,"published"),release=join(ctx.root,"release");
  writeFileSync(join(ctx.spool,String(fixed).padStart(16,"0")+".json"),JSON.stringify(older));
  // Pause precisely after publication, before emit can read/send its own file.
  // This makes the competing old ACK deterministic without production hooks.
  writeFileSync(preloader,`import fs from "node:fs";import {syncBuiltinESMExports} from "node:module";Date.now=()=>${fixed};if(process.env.PAUSE_PUBLISH){const link=fs.linkSync;fs.linkSync=(...args)=>{link(...args);fs.writeFileSync(process.env.PUBLISHED,"1");while(!fs.existsSync(process.env.RELEASE))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);};syncBuiltinESMExports();}`);
  const requests:string[]=[],payloads:unknown[]=[],responses:import("node:http").ServerResponse[]=[];
  const server=createServer(async(request,response)=>{
    let raw="";for await(const chunk of request)raw+=chunk;
    const parsed=JSON.parse(raw),id=parsed.event_id;requests.push(id);payloads.push(parsed);responses.push(response);
    if(id===newer.event_id)response.end(JSON.stringify({accepted:true,duplicate:requests.filter(value=>value===id).length>1,sequence:2,recorded_at:"2026-11-17T00:00:00.000Z"}));
  });
  const children:ReturnType<typeof spawn>[]=[];
  const until=async(predicate:()=>boolean)=>{const deadline=Date.now()+3000;while(!predicate()){assert.ok(Date.now()<deadline,"concurrent CLI watchdog");await new Promise(done=>setTimeout(done,10));}};
  try{
    await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
    const address=server.address();assert.ok(address && typeof address!=="string");
    const start=(args:string[],pause=false,input?:unknown)=>{
      const child=spawn(process.execPath,["--import",pathToFileURL(preloader).href,cliPath,...args],{stdio:["pipe","pipe","pipe"],env:{...process.env,LEDGER_URL:"http://127.0.0.1:"+address.port,LEDGER_TOKEN:dispatcher,LEDGER_SPOOL_DIR:ctx.spool,LEDGER_HTTP_TIMEOUT_MS:"5000",...(pause?{PAUSE_PUBLISH:"1",PUBLISHED:published,RELEASE:release}:{})}});
      let stdout="",stderr="";child.stdout!.on("data",chunk=>stdout+=chunk);child.stderr!.on("data",chunk=>stderr+=chunk);
      const finished=new Promise<{code:number|null;stdout:string;stderr:string}>(done=>child.once("exit",code=>done({code,stdout,stderr})));
      if(input!==undefined)child.stdin!.end(JSON.stringify(input));children.push(child);return finished;
    };
    const first=start(["replay"]);await until(()=>requests.length===1);
    const second=start(["replay"]);await until(()=>requests.length===2);
    responses[0].end(JSON.stringify({accepted:true,duplicate:false,sequence:1}));assert.equal((await first).code,0);
    const fresh=start(["emit","-"],true,newer);await until(()=>existsSync(published));
    responses[1].end(JSON.stringify({accepted:true,duplicate:true,sequence:1}));assert.equal((await second).code,0);
    // Another consumer may finish the new event before its emitter resumes.
    assert.equal((await start(["replay"])).code,0);
    writeFileSync(release,"1");const outcome=await fresh;assert.equal(outcome.code,0,outcome.stderr);
    assert.ok(requests.includes(newer.event_id),"newer event must reach HTTP before its spool file is removed");
    assert.equal(JSON.parse(outcome.stdout).accepted,true);
    assert.equal(JSON.parse(outcome.stdout).sequence,2);
    for(const payload of payloads.filter((value:any)=>value.event_id===newer.event_id))assert.deepEqual(payload,JSON.parse(JSON.stringify(newer)));
    assert.equal(readdirSync(ctx.spool).filter(name=>name.endsWith(".json")).length,0);
  }finally{
    const exits=children.filter(child=>child.exitCode===null && child.signalCode===null).map(child=>new Promise<void>(done=>{child.once("exit",()=>done());child.kill("SIGKILL");}));
    await Promise.all(exits);server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await ctx.close();
  }
});

test("CLI read commands match HTTP, reject invalid credentials, and never print credentials",async()=>{
  const ctx=fixture(),runId="cli-"+randomUUID();
  try{
    await ctx.start();
    assert.equal((await ctx.emit(event("run.created",runId,{work_item:{source:"github",repository:"verification/local",external_id:"39"}}))).code,0);
    const pairs=[["runs","/v1/runs"],["runs created","/v1/runs?status=created"],["run "+runId,"/v1/runs/"+runId],["active","/v1/agents/active"],["events "+runId,"/v1/events?run_id="+runId],["issue verification/local 39","/v1/issues?source=github&repository=verification%2Flocal&external_id=39"]];
    for(const [command,path] of pairs){
      const result=await ctx.run(command.split(" "),{token:reader});assert.equal(result.code,0,result.stderr);
      assert.deepEqual(JSON.parse(result.stdout),await ctx.get(path));
    }
    const invalidToken=randomUUID();
    const denied=await ctx.run(["runs"],{token:invalidToken});assert.equal(denied.code,1);assert.match(denied.stderr,/HTTP 401/);
    assert.ok(!denied.stderr.includes(invalidToken));assert.ok(!denied.stdout.includes(invalidToken));
    const body=event("system.tick");
    const deniedEmit=await ctx.emit(body,{token:reader});assert.equal(deniedEmit.code,1);assert.match(deniedEmit.stderr,/HTTP 403/);
    assert.equal(readdirSync(ctx.spool).filter(name=>name.endsWith(".json")).length,1);
    assert.equal((await ctx.run(["replay"])).code,0);
    assert.equal((await ctx.get("/v1/events")).events.length,2);
  }finally{await ctx.close();}
});

test("CLI rejects malformed input without poisoning the spool and stops replay at its first failure",async()=>{
  const ctx=fixture();
  try{
    await ctx.start();
    for(const input of ["{broken", "null", JSON.stringify({event_id:"../bad"})]){
      const invalid=await ctx.run(["emit","-"],{input});assert.equal(invalid.code,1);
    }
    assert.equal(readdirSync(ctx.spool).filter(name=>name.endsWith(".json")).length,0);
    writeFileSync(join(ctx.spool,"0000000000000001-invalid.json"),"{");
    writeFileSync(join(ctx.spool,"0000000000000002-valid.json"),JSON.stringify(event("system.tick")));
    const replay=await ctx.run(["replay"]);assert.equal(replay.code,1);
    assert.deepEqual(JSON.parse(replay.stdout),{replayed:0,remaining:2});assert.equal((await ctx.get("/v1/events")).events.length,0);
  }finally{await ctx.close();}
});
