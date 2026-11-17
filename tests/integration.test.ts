import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../src/server.js";
import type { LedgerConfig } from "../src/config.js";

const dispatcher="d".repeat(24), reader="r".repeat(24);
function fixture() {
  const root=mkdtempSync(join(tmpdir(),"lel-test-")), artifactDir=join(root,"artifacts");
  mkdirSync(artifactDir);
  const config:LedgerConfig={dbPath:join(root,"test.db"),artifactDir,dispatcherToken:dispatcher,readToken:reader,port:0,host:"127.0.0.1",heartbeatTtlMs:1,maxArtifactBytes:1048576};
  let app=buildApp(config);
  const post=(body:unknown,token=dispatcher)=>app.inject({method:"POST",url:"/v1/events",headers:{authorization:"Bearer "+token,"content-type":"application/json"},payload:JSON.stringify(body)});
  const get=(url:string,token=reader)=>app.inject({method:"GET",url,headers:{authorization:"Bearer "+token}});
  const close=async()=>{await app.close();rmSync(root,{recursive:true,force:true});};
  return {config,get,post,close,app,replaceApp:async()=>{await app.close();app=buildApp(config);return app;}};
}
const makeEvent=(type:string,run_id?:string,attempt_id?:string,data:Record<string,unknown>={})=>({
  event_id:randomUUID(),type,run_id,attempt_id,actor:"dispatcher",data
});
const runCreate=(run:string)=>makeEvent("run.created",run,undefined,{work_item:{source:"github",repository:"Dzikle/Licitacija",external_id:"139",title:"Homepage"}});
async function started(ctx:ReturnType<typeof fixture>,run:string) {
  assert.equal((await ctx.post(runCreate(run))).statusCode,201);
  assert.equal((await ctx.post(makeEvent("run.started",run))).statusCode,201);
}

test("happy path persists run, attempt, events and survives restart",async()=>{
 const ctx=fixture(),run="run-"+randomUUID(),attempt="attempt-"+randomUUID();
 try{
  await started(ctx,run);
  assert.equal((await ctx.post(makeEvent("attempt.started",run,attempt,{role:"developer",provider:"opencode",model:"glm",phase:"implementation"}))).statusCode,201);
  assert.equal((await ctx.post(makeEvent("attempt.progress",run,attempt,{phase:"qa",message:"tests"}))).statusCode,201);
  assert.equal((await ctx.post(makeEvent("attempt.succeeded",run,attempt,{exit_code:0}))).statusCode,201);
  assert.equal((await ctx.post(makeEvent("run.completed",run,undefined,{result:"verified"}))).statusCode,201);
  const r=await ctx.get("/v1/runs/"+encodeURIComponent(run));assert.equal(r.statusCode,200);
  assert.equal(r.json().status,"completed");assert.equal(r.json().attempts[0].status,"succeeded");
  assert.equal(r.json().attempts[0].phase,"qa");
  assert.equal((await ctx.get("/v1/events?run_id="+encodeURIComponent(run))).json().events.length,6);
  await ctx.replaceApp();
  const restarted=await ctx.get("/v1/runs/"+encodeURIComponent(run));
  assert.equal(restarted.json().status,"completed");
  assert.equal((await ctx.get("/v1/agents/active")).json().attempts.length,0);
 }finally{await ctx.close();}
});

test("idempotency, changed payload conflict and forbidden post",async()=>{
 const ctx=fixture(),run="run-"+randomUUID();
 try{
  const event=runCreate(run);
  const first=await ctx.post(event);assert.equal(first.statusCode,201);
  const again=await ctx.post(event);assert.equal(again.statusCode,200);
  assert.equal(again.json().duplicate,true);assert.equal(first.json().sequence,again.json().sequence);
  const conflicting={...event,data:{work_item:{source:"github",repository:"Different/Repo",external_id:"139"}}};
  assert.equal((await ctx.post(conflicting)).statusCode,409);
  assert.equal((await ctx.post(makeEvent("run.started",run),reader)).statusCode,403);
  assert.equal((await ctx.get("/v1/runs")).statusCode,200);
  assert.equal((await ctx.get("/v1/runs","badtoken")).statusCode,401);
  assert.equal((await ctx.get("/v1/events")).json().events.length,1);
 }finally{await ctx.close();}
});

test("QA failure leaves run open, retry gets a distinct attempt, terminal transition rejected",async()=>{
 const ctx=fixture(),run="run-"+randomUUID(),qa="qa-"+randomUUID(),fix="fix-"+randomUUID();
 try{
  await started(ctx,run);
  assert.equal((await ctx.post(makeEvent("attempt.started",run,qa,{role:"qa"}))).statusCode,201);
  assert.equal((await ctx.post(makeEvent("run.completed",run))).statusCode,409);
  assert.equal((await ctx.post(makeEvent("attempt.failed",run,qa,{exit_code:2}))).statusCode,201);
  assert.equal((await ctx.post(makeEvent("attempt.heartbeat",run,qa))).statusCode,409);
  assert.equal((await ctx.post(makeEvent("attempt.started",run,fix,{role:"developer",phase:"fix",parent_attempt_id:qa}))).statusCode,201);
  assert.equal((await ctx.post(makeEvent("attempt.succeeded",run,fix))).statusCode,201);
  assert.equal((await ctx.post(makeEvent("run.completed",run))).statusCode,201);
  assert.equal((await ctx.post(makeEvent("run.resumed",run))).statusCode,409);
  const r=(await ctx.get("/v1/runs/"+encodeURIComponent(run))).json();
  assert.equal(r.attempts.length,2);assert.equal(r.status,"completed");
 }finally{await ctx.close();}
});

test("system ticks, active attempt stale indication and usage idempotency",async()=>{
 const ctx=fixture(),run="run-"+randomUUID(),attempt="attempt-"+randomUUID();
 try{
  assert.equal((await ctx.post(makeEvent("system.tick"))).statusCode,201);
  await started(ctx,run);
  assert.equal((await ctx.post(makeEvent("attempt.started",run,attempt,{role:"reviewer"}))).statusCode,201);
  const active=(await ctx.get("/v1/agents/active")).json().attempts;
  assert.equal(active.length,1);assert.equal(typeof active[0].suspected_stale,"boolean");
  const usage={sample_id:"usage-"+randomUUID(),attempt_id:attempt,provider:"claude",model:"opus",input_tokens:100,output_tokens:20,cost_usd_micros:null,source:"provider_reported"};
  const send=()=>ctx.app.inject({method:"POST",url:"/v1/usage",headers:{authorization:"Bearer "+dispatcher},payload:usage});
  assert.equal((await send()).statusCode,201);
  assert.equal((await send()).statusCode,200);
  const summary=(await ctx.get("/v1/usage/summary?run_id="+encodeURIComponent(run))).json();
  assert.equal(summary.samples,1);assert.equal(summary.cost_usd_micros,null);
  assert.equal((await ctx.get("/v1/events")).json().events.length,5);
 }finally{await ctx.close();}
});

test("artifact integrity, replay and download permission",async()=>{
 const ctx=fixture(),run="run-"+randomUUID(),attempt="attempt-"+randomUUID();
 const old=process.env.LEDGER_ALLOW_ARTIFACT_UPLOAD;
 process.env.LEDGER_ALLOW_ARTIFACT_UPLOAD="true";
 try{
  await started(ctx,run);
  await ctx.post(makeEvent("attempt.started",run,attempt,{role:"developer"}));
  const bytes=Buffer.from("redacted test log\n","utf8");
  const digest=createHash("sha256").update(bytes).digest("hex");
  const headers={authorization:"Bearer "+dispatcher,"content-type":"application/octet-stream","x-artifact-id":"test-art-1","x-run-id":run,"x-attempt-id":attempt,"x-artifact-type":"session-log","x-sha256":digest,"x-sanitized":"true"};
  const send=()=>ctx.app.inject({method:"POST",url:"/v1/artifacts",headers,payload:bytes});
  assert.equal((await send()).statusCode,201);
  assert.equal((await send()).statusCode,200);
  assert.equal((await ctx.get("/v1/artifacts/test-art-1")).statusCode,403);
  const downloaded=await ctx.get("/v1/artifacts/test-art-1",dispatcher);
  assert.equal(downloaded.body,"redacted test log\n");
  const wrong=await ctx.app.inject({method:"POST",url:"/v1/artifacts",headers:{...headers,"x-sha256":"0".repeat(64),"x-artifact-id":"wrong"},payload:bytes});
  assert.equal(wrong.statusCode,400);
 }finally{
  if(old===undefined)delete process.env.LEDGER_ALLOW_ARTIFACT_UPLOAD;else process.env.LEDGER_ALLOW_ARTIFACT_UPLOAD=old;
  await ctx.close();
 }
});
