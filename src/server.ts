import Fastify from "fastify";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { LedgerStore } from "./store.js";
import { eventSchema, usageSchema, LedgerError } from "./contracts.js";
import { loadConfig, type LedgerConfig } from "./config.js";

function constantTimeEqual(a: string, b: string): boolean {
  const x=Buffer.from(a), y=Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x,y);
}
const stringHeader = (h: string | string[] | undefined) => typeof h === "string" ? h : "";
const validId = (v: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v);

export function buildApp(config: LedgerConfig) {
  const store=new LedgerStore(config.dbPath);
  const app=Fastify({logger:false, bodyLimit:config.maxArtifactBytes+1024});
  app.addContentTypeParser("application/octet-stream",{parseAs:"buffer"},(_req,body,done)=>done(null,body));
  app.addContentTypeParser("application/gzip",{parseAs:"buffer"},(_req,body,done)=>done(null,body));
  app.addHook("onClose",async()=>store.close());

  function authenticate(header: string | undefined, write: boolean, artifactRead = false) {
    const prefix="Bearer ";
    if (!header?.startsWith(prefix)) throw new LedgerError("UNAUTHORIZED","Missing bearer token",401);
    const token=header.slice(prefix.length);
    if (constantTimeEqual(token,config.dispatcherToken)) return;
    if (constantTimeEqual(token,config.readToken)) {
      if (!write && !artifactRead) return;
      throw new LedgerError("FORBIDDEN","Insufficient permissions",403);
    }
    throw new LedgerError("UNAUTHORIZED","Invalid bearer token",401);
  }
  app.setErrorHandler((err,req,reply)=>{
    if (err instanceof LedgerError) {
      return reply.code(err.httpStatus).send({error:{code:err.code,message:err.message}});
    }
    if (err instanceof ZodError) return reply.code(400).send({error:{code:"VALIDATION",message:err.issues.map(x=>x.path.join(".")+": "+x.message).join("; ")}});
    if ((err as {statusCode?:number}).statusCode === 413) return reply.code(413).send({error:{code:"PAYLOAD_TOO_LARGE",message:"Payload exceeded configured limit"}});
    req.log.error({error:err instanceof Error ? err.message : String(err)},"Internal ledger error");
    return reply.code(500).send({error:{code:"INTERNAL",message:"Internal server error"}});
  });

  app.get("/health",async()=>({ok:store.db.prepare("SELECT 1 AS n").get()!=null,service:"execution-ledger"}));
  app.get("/",async(_req,reply)=>{
    reply.type("text/html; charset=utf-8");
    return readFileSync(resolve(process.cwd(),"web/index.html"),"utf8");
  });
  app.post("/v1/events",async(req,reply)=>{
    authenticate(req.headers.authorization,true);
    const event=eventSchema.parse(req.body);
    const ack=store.recordEvent(event);
    return reply.code(ack.duplicate?200:201).send(ack);
  });
  app.post("/v1/usage",async(req,reply)=>{
    authenticate(req.headers.authorization,true);
    const sample=usageSchema.parse(req.body);
    const ack=store.recordUsage(sample);
    return reply.code(ack.duplicate?200:201).send(ack);
  });
  app.post("/v1/artifacts",async(req,reply)=>{
    authenticate(req.headers.authorization,true);
    if (process.env.LEDGER_ALLOW_ARTIFACT_UPLOAD !== "true") throw new LedgerError("UPLOAD_DISABLED","Artifact upload is opt-in via LEDGER_ALLOW_ARTIFACT_UPLOAD=true",403);
    const headers=req.headers;
    const id=stringHeader(headers["x-artifact-id"]);
    const runId=stringHeader(headers["x-run-id"]);
    const attemptId=stringHeader(headers["x-attempt-id"]) || null;
    const type=stringHeader(headers["x-artifact-type"]);
    const wantedSha=stringHeader(headers["x-sha256"]).toLowerCase();
    const encoding=stringHeader(headers["content-encoding"]) || null;
    const sanitized=stringHeader(headers["x-sanitized"]) === "true";
    if (![id,runId,type].every(validId) || (attemptId&&!validId(attemptId))) throw new LedgerError("VALIDATION","Invalid artifact ID, run ID or type");
    if (!/^[a-f0-9]{64}$/.test(wantedSha)) throw new LedgerError("VALIDATION","x-sha256 must be a lowercase hex SHA-256");
    if (!sanitized) throw new LedgerError("NOT_SANITIZED","Sanitized log declaration required",400);
    if (encoding && encoding !== "gzip") throw new LedgerError("VALIDATION","Only gzip encoding is accepted");
    if (!Buffer.isBuffer(req.body)) throw new LedgerError("VALIDATION","Binary body required");
    const bytes=req.body as Buffer;
    if (bytes.length > config.maxArtifactBytes) throw new LedgerError("PAYLOAD_TOO_LARGE","Artifact exceeds size limit",413);
    const digest=createHash("sha256").update(bytes).digest("hex");
    if (digest!==wantedSha) throw new LedgerError("SHA_MISMATCH","Artifact digest mismatch",400);
    const storageKey=createHash("sha256").update(id).digest("hex")+".bin";
    const target=join(config.artifactDir,storageKey);
    const existing=(()=>{try{return store.getArtifact(id)}catch(err){if(err instanceof LedgerError && err.code==="ARTIFACT_NOT_FOUND")return null;throw err}})();
    if (existing) {
      if (existing.sha256!==digest || existing.size_bytes!==bytes.length || existing.run_id!==runId || existing.attempt_id!==attemptId) throw new LedgerError("ARTIFACT_ID_CONFLICT","Artifact ID reused for different content or ownership",409);
      return reply.code(200).send({accepted:true,duplicate:true,id});
    }
    const temp=join(config.artifactDir,".upload-"+randomUUID());
    writeFileSync(temp,bytes,{flag:"wx",mode:0o600});
    try {
      if (existsSync(target)) throw new LedgerError("ARTIFACT_CONFLICT","Artifact path already exists",409);
      renameSync(temp,target);
      try {
        const ack=store.registerArtifact({id,runId,attemptId,type,key:storageKey,sha256:digest,bytes:bytes.length,contentType:stringHeader(headers["content-type"]) || "application/octet-stream",encoding,sanitized});
        return reply.code(ack.duplicate?200:201).send({...ack,id});
      } catch(err) {unlinkSync(target);throw err;}
    } finally {if(existsSync(temp))unlinkSync(temp);}
  });

  app.get("/v1/runs",async(req)=>{
    authenticate(req.headers.authorization,false);
    const q=req.query as {status?:string;limit?:string};
    const limit=Math.min(Math.max(Number(q.limit||50)||50,1),200);
    return {runs:store.listRuns(q.status,limit)};
  });
  app.get("/v1/runs/:id",async(req)=>{
    authenticate(req.headers.authorization,false);
    return store.getRun((req.params as {id:string}).id);
  });
  app.get("/v1/attempts/:id",async(req)=>{
    authenticate(req.headers.authorization,false);
    return store.getAttempt((req.params as {id:string}).id);
  });
  app.get("/v1/events",async(req)=>{
    authenticate(req.headers.authorization,false);
    const q=req.query as {run_id?:string;after_seq?:string;limit?:string};
    return {events:store.getEvents({runId:q.run_id,afterSeq:Number(q.after_seq||0),limit:Number(q.limit||100)})};
  });
  app.get("/v1/agents/active",async(req)=>{
    authenticate(req.headers.authorization,false);
    return {attempts:store.activeAttempts(config.heartbeatTtlMs)};
  });
  app.get("/v1/issues",async(req)=>{
    authenticate(req.headers.authorization,false);
    const q=req.query as {source?:string;repository?:string;external_id?:string};
    if (!q.source||!q.repository||!q.external_id) throw new LedgerError("VALIDATION","source,repository,external_id are required");
    return {runs:store.issueRuns(q.source,q.repository,q.external_id)};
  });
  app.get("/v1/usage/summary",async(req)=>{
    authenticate(req.headers.authorization,false);
    const q=req.query as {run_id?:string};
    return store.usageSummary(q.run_id);
  });
  app.get("/v1/artifacts/:id",async(req,reply)=>{
    authenticate(req.headers.authorization,false,true);
    const artifact=store.getArtifact((req.params as {id:string}).id);
    const path=join(config.artifactDir,artifact.storage_key as string);
    if (!existsSync(path)) throw new LedgerError("ARTIFACT_MISSING","Artifact metadata exists but file is missing",404);
    reply.type(artifact.content_type as string);
    if (artifact.encoding) reply.header("Content-Encoding",artifact.encoding);
    return readFileSync(path);
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config=loadConfig();
  const app=buildApp(config);
  app.listen({port:config.port,host:config.host}).then(address=>{
    process.stdout.write("Execution Ledger listening on "+address+"\n");
  }).catch(err=>{process.stderr.write(String(err)+"\n");process.exitCode=1;});
}
