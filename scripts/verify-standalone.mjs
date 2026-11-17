// Standalone acceptance probe. Talks to the built server over real loopback HTTP.
// Only synthetic data; credentials are generated in memory and never saved.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const output = resolve(process.argv[2] || 'docs/verification-evidence/standalone');
mkdirSync(output, { recursive: true });
const storage = mkdtempSync(join(tmpdir(), 'ledger-standalone-'));
const dbPath = join(storage, 'ledger.db'), artifactDir = join(storage, 'artifacts');
const dispatcher = randomBytes(24).toString('hex'), reader = randomBytes(24).toString('hex');
const prefix = randomUUID(), issue = 'synthetic-' + prefix, run = 'lifecycle-' + prefix;
const port = Number(process.env.LEDGER_VERIFY_PORT || 4196), base = 'http://127.0.0.1:' + port;
const records = [], checks = [], commands = [], logs = [];
const environment = {...process.env, HOST:'127.0.0.1', PORT:String(port), LEDGER_DB_PATH:dbPath,
  LEDGER_ARTIFACT_DIR:artifactDir, LEDGER_DISPATCHER_TOKEN:dispatcher, LEDGER_READ_TOKEN:reader,
  LEDGER_HEARTBEAT_TTL_MS:'200', LEDGER_MAX_ARTIFACT_BYTES:'4096'};
delete environment.LEDGER_ALLOW_ARTIFACT_UPLOAD;
let child, inspector;
const delay = ms => new Promise(r => setTimeout(r, ms));
const check = (name, detail = {}) => { checks.push({name, pass:true, ...detail}); };
const sha = value => createHash('sha256').update(value).digest('hex');
async function http(path, {method='GET', body, token=reader, headers={}} = {}) {
  const sent = body instanceof Buffer ? body : body === undefined ? undefined : JSON.stringify(body);
  const response = await fetch(base + path, {method, headers:{...(token ? {Authorization:'Bearer '+token}:{}),
    ...(body !== undefined ? {'Content-Type':body instanceof Buffer ? 'application/octet-stream':'application/json'}:{}), ...headers}, body:sent,
    signal:AbortSignal.timeout(5000)});
  const bytes = Buffer.from(await response.arrayBuffer());
  let payload; try { payload = JSON.parse(bytes.toString()); } catch { payload = {bytes:bytes.length, sha256:sha(bytes)}; }
  records.push({method,path,request:body instanceof Buffer ? {bytes:body.length,sha256:sha(body)} : body,
    status:response.status,response:payload});
  return {status:response.status,body:payload,bytes};
}
async function start(uploads=false) {
  const env = {...environment}; if (uploads) env.LEDGER_ALLOW_ARTIFACT_UPLOAD='true';
  child = spawn(process.execPath, ['dist/src/server.js'], {env, cwd:process.cwd(), stdio:['ignore','pipe','pipe'], windowsHide:true});
  const processLog = {command:'node dist/src/server.js (npm start)', uploads, stdout:'', stderr:''}; logs.push(processLog);
  child.stdout.on('data', d => processLog.stdout += d); child.stderr.on('data', d => processLog.stderr += d);
  for (let n=0;n<100;n++) {
    if (child.exitCode !== null) throw new Error('Server exited: '+processLog.stderr);
    try { const h = await http('/health',{token:null}); if (h.status===200) return; } catch {}
    await delay(50);
  }
  throw new Error('Server startup timeout');
}
async function stop() {
  if (!child || child.exitCode!==null) return;
  const p = child; const ended = once(p,'exit'); p.kill('SIGTERM');
  const [code,signal] = await ended;
  logs.at(-1).exit={code,signal,method:process.platform==='win32'?'Windows TerminateProcess (crash-recovery probe)':'SIGTERM'};
  child = undefined;
}
const event = (type, run_id, attempt_id, data={}, event_id=randomUUID()) => ({event_id,type,actor:'standalone-verification',
  ...(run_id?{run_id}:{}), ...(attempt_id?{attempt_id}:{}), occurred_at:new Date().toISOString(),data});
async function emit(type, runId, attemptId, data={}, eventId) {
  const payload=event(type,runId,attemptId,data,eventId), response=await http('/v1/events',{method:'POST',body:payload,token:dispatcher});
  assert.equal(response.status,201,JSON.stringify(response.body)); return {payload,...response};
}
async function newRun(id,external_id=issue) {
  await emit('run.created',id,undefined,{work_item:{source:'github',repository:'Dzikle/Multi-agent-flow',external_id,title:'Synthetic verification only'},phase:'coordination'});
  await emit('run.started',id);
}
const rows = table => inspector.prepare('SELECT * FROM '+table+' ORDER BY 1').all();
function snapshot() { return JSON.stringify(['work_items','runs','attempts','events','artifacts','usage_samples'].map(rows)); }
async function rejected(name,payload,status=409) {
  const before=snapshot(); const result=await http('/v1/events',{method:'POST',body:payload,token:dispatcher});
  assert.equal(result.status,status,name); assert.equal(snapshot(),before,name+' modified database'); check(name,{status,code:result.body.error.code});
}
async function cli(args, token=reader, extra={}) {
  const p=spawn(process.execPath,['client/agent-ledger.mjs',...args],{env:{...process.env,LEDGER_URL:base,LEDGER_TOKEN:token,
    LEDGER_SPOOL_DIR:join(storage,'spool'),LEDGER_HTTP_TIMEOUT_MS:'1000',...extra},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='';p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);
  const [exit_code]=await once(p,'exit');
  assert.ok(!stdout.includes(dispatcher)&&!stderr.includes(dispatcher)&&!stdout.includes(reader)&&!stderr.includes(reader));
  commands.push({command:'node client/agent-ledger.mjs '+args.join(' '),exit_code,stdout,stderr});
  return {exit_code,stdout,stderr,json:stdout?JSON.parse(stdout):undefined};
}

try {
  assert.ok(!existsSync(dbPath)); await start();
  inspector = new Database(dbPath,{readonly:true}); inspector.pragma('foreign_keys=ON');
  const tables=inspector.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  assert.equal(tables.length,7); // six domain tables, plus migration bookkeeping
  const schema={tables,indexes:inspector.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index'").all(),
    triggers:inspector.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all(),
    foreign_keys:Object.fromEntries(tables.map(t=>[t.name,inspector.pragma('foreign_key_list('+t.name+')')])),
    columns:Object.fromEntries(tables.map(t=>[t.name,inspector.pragma('table_info('+t.name+')')])),
    journal_mode:inspector.pragma('journal_mode'),sqlite_version:inspector.prepare('SELECT sqlite_version() AS version').get()};
  writeFileSync(join(output,'schema.json'),JSON.stringify(schema,null,2));
  check('clean startup creates SQLite and all six domain tables plus schema_migrations');
  const disabled=await http('/v1/artifacts',{method:'POST',body:Buffer.from('synthetic'),token:dispatcher});
  assert.equal(disabled.status,403);assert.equal(disabled.body.error.code,'UPLOAD_DISABLED'); check('artifact uploads disabled by default');
  await newRun(run);
  const attempts=['coordinator','developer','reviewer','qa-failed','correction','qa-retry'].map(x=>x+'-'+prefix);
  const roles=['coordinator','developer','reviewer','qa','developer','qa'];
  for (let i=0;i<attempts.length;i++) {
    await emit('attempt.started',run,attempts[i],{role:roles[i],provider:i%2?'synthetic-b':'synthetic-a',model:'synthetic-model-'+i,
      phase:['planning','implementation','review','qa','correction','qa'][i],...(i===4?{parent_attempt_id:attempts[3]}:{})});
    if (i===0||i===3) await emit('attempt.progress',run,attempts[i],{message:i===3?'Synthetic QA failure':'Synthetic coordination checkpoint'});
    if (i===1) {
      for (let j=0;j<3;j++) await emit('attempt.progress',run,attempts[i],{message:'Synthetic developer checkpoint '+j});
      for (let j=0;j<2;j++) await emit('attempt.heartbeat',run,attempts[i]);
    }
    await emit(i===3?'attempt.failed':'attempt.succeeded',run,attempts[i],{exit_code:i===3?1:0,...(i===3?{error_class:'qa-harness'}:{})});
    if(i===3) assert.equal((await http('/v1/runs/'+run)).body.status,'running');
  }
  await emit('run.completed',run,undefined,{result:'Synthetic standalone lifecycle verified',phase:'complete'});
  const finalRun=(await http('/v1/runs/'+run)).body;
  assert.equal(finalRun.status,'completed');assert.equal(finalRun.attempts.length,6);
  assert.equal(new Set(finalRun.attempts.map(a=>a.id)).size,6);
  assert.ok(finalRun.attempts.every(a=>a.run_id===run));assert.equal(finalRun.attempts.find(a=>a.id===attempts[3]).status,'failed');
  const history=(await http('/v1/events?run_id='+run+'&limit=500')).body.events;
  assert.equal(history.length,22);assert.ok(history.every((e,i)=>!i||e.seq>history[i-1].seq));
  writeFileSync(join(output,'lifecycle.json'),JSON.stringify({run:finalRun,events:history},null,2));
  check('complete 20-step lifecycle; QA failure preserves running run; six distinct attempts retained',{events:history.length,run_id:run});
  const dup=event('system.tick',undefined,undefined,{message:'retry test'});
  const first=await http('/v1/events',{method:'POST',body:dup,token:dispatcher});const before=snapshot();
  const again=await http('/v1/events',{method:'POST',body:dup,token:dispatcher});
  assert.equal(again.status,200);assert.equal(again.body.sequence,first.body.sequence);assert.equal(again.body.recorded_at,first.body.recorded_at);assert.equal(snapshot(),before);
  await rejected('same event ID changed payload', {...dup,data:{message:'different'}});
  await rejected('finish attempt twice',event('attempt.succeeded',run,attempts[1]));
  await rejected('heartbeat completed attempt',event('attempt.heartbeat',run,attempts[1]));
  await rejected('restart completed run',event('run.started',run));
  await rejected('reference nonexistent run',event('run.started','missing-'+prefix),404);
  const parallel='parallel-'+prefix; await newRun(parallel); const active=['alpha','beta','gamma'].map(x=>x+'-'+prefix);
  await Promise.all(active.map((id,i)=>emit('attempt.started',parallel,id,{role:['developer','reviewer','qa'][i],phase:'parallel'})));
  await rejected('finalize with active attempt',event('run.completed',parallel));
  await rejected('attempt belongs to different run',event('attempt.progress',parallel,attempts[0],{message:'wrong run'}));
  await rejected('parent belongs to different run',event('attempt.started',parallel,'bad-parent-'+prefix,{role:'developer',parent_attempt_id:attempts[0]}));
  for(let round=0;round<3;round++) await Promise.all(active.map(async(id,i)=>{
    await emit('attempt.progress',parallel,id,{message:'Specialist '+i+' checkpoint '+round}); await emit('attempt.heartbeat',parallel,id);
  }));
  const concurrent=event('attempt.progress',parallel,active[0],{message:'concurrent retry'});
  const retryResults=await Promise.all(Array.from({length:32},()=>http('/v1/events',{method:'POST',body:concurrent,token:dispatcher})));
  assert.equal(retryResults.filter(r=>r.status===201).length,1);assert.equal(retryResults.filter(r=>r.status===200).length,31);
  assert.equal(new Set(retryResults.map(r=>r.body.sequence)).size,1);
  assert.equal(inspector.prepare('SELECT COUNT(*) AS n FROM events WHERE event_id=?').get(concurrent.event_id).n,1);
  const pe=(await http('/v1/events?run_id='+parallel+'&limit=500')).body.events;assert.ok(pe.every((e,i)=>!i||e.seq>pe[i-1].seq));
  assert.equal((await http('/v1/runs/'+parallel)).body.attempts.filter(a=>a.status==='running').length,3);
  check('three concurrent specialists and 32 simultaneous identical retries; one committed event',{parallel_events:pe.length});
  await delay(300); const stale=(await http('/v1/agents/active')).body.attempts.filter(a=>a.run_id===parallel);
  assert.equal(stale.length,3);assert.ok(stale.every(a=>a.suspected_stale&&a.status==='running'));check('heartbeat expires diagnostically; stored status remains running');
  for(const [i,data] of [
    {input_tokens:100,output_tokens:20,cached_input_tokens:10,cost_usd_micros:40,source:'provider_reported'},
    {input_tokens:200,output_tokens:30,cost_usd_micros:900,source:'estimated'},
    {source:'provider_reported'}].entries()) {
    const sample={sample_id:'usage-'+prefix+'-'+i,attempt_id:attempts[i],provider:i===1?'synthetic-b':'synthetic-a',model:'synthetic-model-'+i,...data};
    assert.equal((await http('/v1/usage',{method:'POST',token:dispatcher,body:sample})).status,201);
    assert.equal((await http('/v1/usage',{method:'POST',token:dispatcher,body:sample})).status,200);
    assert.equal((await http('/v1/usage',{method:'POST',token:dispatcher,body:{...sample,input_tokens:999}})).status,409);
  }
  const summary=(await http('/v1/usage/summary?run_id='+run)).body;
  assert.equal(summary.samples,3);assert.equal(summary.input_tokens,300);assert.equal(summary.unknown_cost_samples,1);
  assert.equal(summary.by_source.provider_reported.cost_usd_micros,40);assert.equal(summary.by_source.estimated.cost_usd_micros,900);
  assert.equal(inspector.prepare('SELECT input_tokens,output_tokens,cost_usd_micros FROM usage_samples WHERE id=?').get('usage-'+prefix+'-2').input_tokens,null);
  const missing=(await http('/v1/usage/summary?run_id='+parallel)).body;assert.equal(missing.input_tokens,null);assert.equal(missing.cost_usd_micros,null);
  writeFileSync(join(output,'usage.json'),JSON.stringify({summary,missing},null,2));check('multi-provider usage, explicit estimates, NULL unknowns, idempotency and conflict');
  const beforeRestart=(await http('/v1/runs/'+parallel)).body, eventsBefore=(await http('/v1/events?run_id='+parallel+'&limit=500')).body;
  await stop();
  const queued=event('attempt.progress',parallel,active[1],{message:'offline event retained for replay'});const inputFile=join(storage,'event.json');writeFileSync(inputFile,JSON.stringify(queued));
  const failedCli=await cli(['emit',inputFile],dispatcher);assert.equal(failedCli.exit_code,1);assert.match(failedCli.stderr,/retained/i);
  const spoolFiles=readdirSync(join(storage,'spool')).filter(x=>x.endsWith('.json'));assert.equal(spoolFiles.length,1);
  assert.deepEqual(JSON.parse(readFileSync(join(storage,'spool',spoolFiles[0]),'utf8')),queued);
  await start(true);
  assert.deepEqual((await http('/v1/runs/'+parallel)).body,beforeRestart);assert.deepEqual((await http('/v1/events?run_id='+parallel+'&limit=500')).body,eventsBefore);
  assert.equal((await cli(['replay'],dispatcher)).exit_code,0);assert.equal((await cli(['replay'],dispatcher)).json.replayed,0);
  assert.equal(inspector.prepare('SELECT COUNT(*) AS n FROM events WHERE event_id=?').get(queued.event_id).n,1);
  check('restart preserves unfinished execution, attempts, events and timestamps; offline CLI spool replay exactly once');
  const bytes=Buffer.from('Synthetic sanitized test log only\n'), artId='artifact-'+prefix;
  const artifactHeaders={'X-Artifact-Id':artId,'X-Run-Id':run,'X-Attempt-Id':attempts[1],'X-Artifact-Type':'session-log','X-SHA256':sha(bytes),'X-Sanitized':'true'};
  const upload=(body=bytes,headers={})=>http('/v1/artifacts',{method:'POST',body,token:dispatcher,headers:{...artifactHeaders,...headers}});
  assert.equal((await upload()).status,201);assert.equal((await upload()).status,200);
  const artifactBefore=snapshot(); const changed=Buffer.from('changed synthetic bytes');assert.equal((await upload(changed,{'X-SHA256':sha(changed)})).status,409);assert.equal(snapshot(),artifactBefore);
  assert.equal((await upload(bytes,{'X-Artifact-Id':'bad-hash-'+prefix,'X-SHA256':'0'.repeat(64)})).status,400);
  assert.equal((await upload(bytes,{'X-Artifact-Id':'invalid-hash-'+prefix,'X-SHA256':'bad'})).status,400);
  assert.equal((await upload(Buffer.alloc(4097),{'X-Artifact-Id':'large-'+prefix,'X-SHA256':sha(Buffer.alloc(4097))})).status,413);
  assert.equal((await upload(bytes,{'X-Artifact-Id':'missing-'+prefix,'X-Run-Id':'absent-'+prefix})).status,404);
  assert.equal((await upload(bytes,{'X-Artifact-Id':'wrong-attempt-'+prefix,'X-Run-Id':parallel})).status,409);
  assert.equal((await upload(bytes,{'X-Artifact-Id':'unsanitized-'+prefix,'X-Sanitized':'false'})).status,400);
  assert.equal((await http('/v1/artifacts/'+artId,{token:null})).status,401);assert.equal((await http('/v1/artifacts/'+artId)).status,403);
  const downloaded=await http('/v1/artifacts/'+artId,{token:dispatcher});assert.equal(downloaded.status,200);assert.equal(sha(downloaded.bytes),sha(bytes));
  assert.equal(inspector.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE id=?').get(artId).n,1);
  assert.deepEqual(readdirSync(artifactDir).filter(n=>n.startsWith('.upload-')),[]);
  check('artifact SHA-256, identical replay, conflicting bytes, invalid hashes/parents, opt-in, size and access controls');
  for (const [args,path] of [[['runs'],'/v1/runs'],[['run',run],'/v1/runs/'+run],[['events',run],'/v1/events?run_id='+run],
    [['issue','Dzikle/Multi-agent-flow',issue],'/v1/issues?source=github&repository=Dzikle%2FMulti-agent-flow&external_id='+issue]]) {
    const result=await cli(args);assert.equal(result.exit_code,0);assert.deepEqual(result.json,(await http(path)).body);
  }
  const cliActive=await cli(['active']);assert.equal(cliActive.exit_code,0);
  const normalize=attempts=>attempts.map(({heartbeat_age_ms,...a})=>a);
  assert.deepEqual(normalize(cliActive.json.attempts),normalize((await http('/v1/agents/active')).body.attempts));
  const online=event('system.idle',undefined,undefined,{message:'online CLI event'});writeFileSync(inputFile,JSON.stringify(online));
  assert.equal((await cli(['emit',inputFile],dispatcher)).exit_code,0);
  assert.equal((await cli(['runs'],'invalid-test-credential')).exit_code,1);assert.equal((await cli(['run'])).exit_code,1);
  writeFileSync(inputFile,'{');assert.equal((await cli(['emit',inputFile],dispatcher)).exit_code,1);
  check('CLI runs/run/active/events/issue equal HTTP; emit/replay, invalid credentials and malformed input');
  const statuses=new Map(), attemptStatuses=new Map(), phases=new Map(), runTimes=new Map(), attemptTimes=new Map();
  for(const e of inspector.prepare('SELECT * FROM events ORDER BY seq').all()) {
    const p=JSON.parse(e.payload_json);
    assert.equal(e.event_hash,sha(e.payload_json),'event content hash');
    if(e.event_type.startsWith('run.')) statuses.set(e.run_id,({'run.created':'created','run.started':'running','run.resumed':'running'})[e.event_type]||e.event_type.slice(4));
    if(e.event_type.startsWith('attempt.')) attemptStatuses.set(e.attempt_id,e.event_type==='attempt.started'?'running':(['attempt.progress','attempt.heartbeat'].includes(e.event_type)?attemptStatuses.get(e.attempt_id):e.event_type.slice(8)));
    if((e.event_type.startsWith('run.')||e.event_type.startsWith('attempt.'))&&p.data?.phase)phases.set(e.run_id,p.data.phase);
    if(e.event_type.startsWith('run.')||e.event_type.startsWith('attempt.')) {
      const r=runTimes.get(e.run_id)||{started_at:null,finished_at:null};r.updated_at=e.recorded_at;
      if(e.event_type==='run.created')r.created_at=e.recorded_at;
      if(e.event_type==='run.started')r.started_at=e.recorded_at;
      if(['run.completed','run.failed','run.cancelled'].includes(e.event_type))r.finished_at=e.recorded_at;
      runTimes.set(e.run_id,r);
    }
    if(e.event_type.startsWith('attempt.')) {
      const a=attemptTimes.get(e.attempt_id)||{phase:null,finished_at:null};a.updated_at=e.recorded_at;
      if(e.event_type==='attempt.started'){a.started_at=e.recorded_at;a.last_heartbeat_at=e.recorded_at;}
      if(e.event_type==='attempt.heartbeat'||!['attempt.started','attempt.progress'].includes(e.event_type))a.last_heartbeat_at=e.recorded_at;
      if(!['attempt.started','attempt.progress','attempt.heartbeat'].includes(e.event_type))a.finished_at=e.recorded_at;
      if(p.data?.phase)a.phase=p.data.phase;attemptTimes.set(e.attempt_id,a);
    }
    assert.match(e.recorded_at,/^\d{4}-\d\d-\d\dT.*Z$/);if(e.occurred_at)assert.equal(e.occurred_at,p.occurred_at);
  }
  for(const r of rows('runs')) {assert.equal(r.status,statuses.get(r.id));assert.equal(r.phase,phases.get(r.id));for(const [field,value] of Object.entries(runTimes.get(r.id)))assert.equal(r[field],value,'run '+field);}
  for(const a of rows('attempts')) {assert.equal(a.status,attemptStatuses.get(a.id));for(const [field,value] of Object.entries(attemptTimes.get(a.id)))assert.equal(a[field],value,'attempt '+field);}
  const integrity=inspector.pragma('integrity_check');assert.deepEqual(integrity,[{integrity_check:'ok'}]);assert.deepEqual(inspector.pragma('foreign_key_check'),[]);
  const copyPath=join(storage,'constraint-probe.db');await inspector.backup(copyPath);const copy=new Database(copyPath);copy.pragma('foreign_keys=ON');
  assert.throws(()=>copy.prepare('UPDATE events SET actor=? WHERE seq=1').run('tamper'),/immutable/);
  assert.throws(()=>copy.prepare('DELETE FROM events WHERE seq=1').run(),/immutable/);
  assert.throws(()=>copy.prepare("INSERT INTO attempts(id,run_id,role,status,started_at,last_heartbeat_at,updated_at) VALUES ('fk-probe','absent','qa','running','x','x','x')").run(),/FOREIGN KEY/);
  const original=copy.prepare('SELECT status FROM runs WHERE id=?').get(parallel).status;
  assert.throws(()=>copy.transaction(()=>{copy.prepare("UPDATE runs SET status='failed' WHERE id=?").run(parallel);copy.prepare('DELETE FROM events WHERE seq=1').run();})(),/immutable/);
  assert.equal(copy.prepare('SELECT status FROM runs WHERE id=?').get(parallel).status,original);copy.close();
  const dbReport={integrity,foreign_key_check:[],row_counts:Object.fromEntries(['work_items','runs','attempts','events','artifacts','usage_samples'].map(t=>[t,rows(t).length])),
    projection_audit:'All lifecycle statuses and run phases match replayed immutable history',constraint_probe:'Append-only triggers, FK and rollback tested on SQLite backup; live DB never altered manually',storage};
  writeFileSync(join(output,'database.json'),JSON.stringify(dbReport,null,2));
  check('SQLite integrity, FKs, unique IDs, immutable triggers, rollback and projections match event history');
  check('startup logs have no warnings/exceptions',{starts:logs.length});assert.ok(logs.every(l=>l.stderr===''));
} catch(error) {
  checks.push({name:'acceptance probe',pass:false,error:String(error),stack:error.stack});process.exitCode=1;
} finally {
  await stop();if(inspector)inspector.close();
  const evidence={verified_at:new Date().toISOString(),node:process.version,platform:process.platform,base,storage,checks,commands,logs};
  writeFileSync(join(output,'results.json'),JSON.stringify(evidence,null,2));
  writeFileSync(join(output,'http.json'),JSON.stringify(records,null,2));
  process.stdout.write(JSON.stringify({pass:!process.exitCode,checks:checks.length,http_requests:records.length,evidence:output,storage},null,2)+'\n');
  if(process.exitCode)process.stderr.write(checks.filter(c=>!c.pass).map(c=>c.stack||c.error).join('\n')+'\n');
}
