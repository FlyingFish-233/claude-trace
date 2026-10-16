/** @file unified-trace.test.ts @description Three-protocol capture, export, validation and replay acceptance matrix. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { gzipSync } from "node:zlib";
import { once } from "node:events";
import { spawnSync, spawn } from "node:child_process";
import { adapters, parseSSE } from "../src/protocols/registry";
import { PROTOCOLS, Protocol, Json, TraceRecord } from "../src/protocols/types";
import { TraceWriter, readRecords } from "../src/trace/store";
import { exportTraces, validateTraces, transformMessages } from "../src/trace/offline";
import { replayTraces, replayUrl } from "../src/trace/replay";
import { ReverseProxyServer } from "../src/intercept/reverse-proxy";
import { ForwardProxyServer } from "../src/intercept/forward-proxy";
import { reportTraces } from "../src/trace/report";

/** Isolate every capture and generated artifact. */
function workspace(t:any):string {const dir=fs.mkdtempSync(path.join(os.tmpdir(),"trace-v2-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
/** Minimal complete protocol-native fixtures, with unknown extensions preserved. */
function fixture(protocol:Protocol):{request:Json;response:Json} {
  const request:Json={model:"test-model",stream:false,extension:{keep:true}};
  if(protocol==="anthropic-messages")return {request:{...request,max_tokens:64,system:"policy",messages:[{role:"user",content:"hi"}]},response:{type:"message",role:"assistant",content:[{type:"thinking",thinking:"full reasoning",signature:"sig"},{type:"text",text:"hello"}],stop_reason:"end_turn",usage:{input_tokens:3,output_tokens:4},extra:"keep"}};
  if(protocol==="openai-responses")return {request:{...request,instructions:"policy",input:[{role:"user",content:"hi"}]},response:{id:"resp",status:"completed",output:[{id:"r",type:"reasoning",summary:[{type:"summary_text",text:"short summary"}],encrypted_content:"opaque",content:[{type:"reasoning_text",text:"full reasoning"}]},{type:"message",role:"assistant",content:[{type:"output_text",text:"hello"}]}],usage:{input_tokens:3,output_tokens:4},extra:"keep"}};
  return {request:{...request,messages:[{role:"system",content:"policy"},{role:"user",content:"hi"}]},response:{choices:[{index:0,message:{role:"assistant",content:"hello",reasoning_content:"full reasoning"},finish_reason:"stop"}],usage:{prompt_tokens:3,completion_tokens:4},extra:"keep"}};
}
/** Protocol-native SSE fixtures contain actual completion markers. */
function sse(protocol:Protocol,response:Json):string {
  const frame=(v:Json)=>`data: ${JSON.stringify(v)}\n\n`;
  if(protocol==="openai-responses")return frame({type:"response.completed",response});
  if(protocol==="openai-chat-completions")return frame({choices:[{index:0,delta:response.choices[0].message,finish_reason:null}]})+frame({choices:[{index:0,delta:{},finish_reason:"stop"}]})+frame({choices:[],usage:response.usage})+"data: [DONE]\n\n";
  return frame({type:"message_start",message:{...response,content:[],stop_reason:null}})+response.content.map((b:Json,index:number)=>frame({type:"content_block_start",index,content_block:b})+frame({type:"content_block_stop",index})).join("")+frame({type:"message_delta",delta:{stop_reason:response.stop_reason},usage:response.usage})+frame({type:"message_stop"});
}
/** Start a loopback upstream and register deterministic teardown. */
async function server(t:any,handler:http.RequestListener):Promise<{server:http.Server;url:string}> {
  const server=http.createServer(handler);server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(()=>{server.closeAllConnections();server.close();});return {server,url:`http://127.0.0.1:${(server.address() as any).port}`};
}
/** Read the exact incoming bytes for transparent forwarding assertions. */
async function read(req:http.IncomingMessage):Promise<string>{const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));return Buffer.concat(chunks).toString();}
/** Construct a native trace fixture using the real writer rather than maintaining another schema. */
function write(writer:TraceWriter,protocol:Protocol,request:Json,response:Json,status=200):TraceRecord {
  const now=Date.now();return writer.write({method:"POST",url:`http://mock/v1/${adapters[protocol].operation}`,requestHeaders:{authorization:"secret"},requestBody:Buffer.from(JSON.stringify(request)),responseHeaders:{"content-type":"application/json"},statusCode:status,responseChunks:[Buffer.from(JSON.stringify(response))],requestTimestamp:now,responseTimestamp:now,firstChunkTimestamp:now});
}

for(const protocol of PROTOCOLS)for(const streaming of [false,true])test(`${protocol}: ${streaming?"SSE":"JSON"} byte-preserving capture, export, validate and replay`,async t=>{
  const root=workspace(t),f=fixture(protocol);f.request.stream=streaming;
  const wire=streaming?sse(protocol,f.response):JSON.stringify(f.response);
  const received:Array<{url:string;body:string;headers:http.IncomingHttpHeaders}>=[];
  const upstream=await server(t,async(req,res)=>{received.push({url:req.url!,body:await read(req),headers:req.headers});res.writeHead(200,{"content-type":streaming?"text/event-stream":"application/json"});res.write(wire.slice(0,20));setTimeout(()=>res.end(wire.slice(20)),5);});
  const proxy=new ReverseProxyServer({targetBaseUrl:upstream.url+"/v1",logDirectory:path.join(root,"capture")});
  const info=await proxy.start();t.after(()=>proxy.stop());
  const requestBody=JSON.stringify(f.request,null,2);
  const response=await fetch(info.url+"/v1/"+adapters[protocol].operation,{method:"POST",headers:{"content-type":"application/json",authorization:"source-secret"},body:requestBody});
  assert.equal(await response.text(),wire);proxy.stop();
  assert.equal(received[0].body,requestBody);assert.equal(received[0].url,"/v1/"+adapters[protocol].operation);
  const [{record}]=readRecords([path.join(root,"capture")]);assert.equal(record.protocol,protocol);assert.equal(record.response!.body_raw,wire);assert.deepEqual(record.request.body,f.request);
  assert.equal(record.request.headers.authorization,"[REDACTED]");assert.equal((record.request as any).body_raw,requestBody);
  if(!streaming)assert.deepEqual(record.response!.body,f.response);else assert.equal(record.response!.body,undefined);
  assert.equal(record.response!.events,undefined);assert.ok(record.timing.first_chunk_ms!>=record.timing.headers_ms!);
  assert.deepEqual(fs.readdirSync(path.join(root,"capture")).sort(),["manifest.json","trace.jsonl"]);
  const validation=validateTraces([path.join(root,"capture")],path.join(root,"validation.json"));assert.equal(validation.capture_complete,true);assert.equal(validation.protocol_valid,true);assert.equal(validation.counts.model_complete,1);
  exportTraces([path.join(root,"capture")],path.join(root,"training.jsonl"),{mergeSystemMessages:true});
  const train=JSON.parse(fs.readFileSync(path.join(root,"training.jsonl"),"utf8"));assert.equal(train.messages.at(-1).content,"hello");assert.equal(train.messages.at(-1).reasoning_content,"full reasoning");assert.equal(train.messages.at(-1).trainable,true);
  if(protocol==="openai-responses"){assert.equal(train.metadata.reasoning_metadata[0].summary[0].text,"short summary");assert.equal(train.metadata.reasoning_metadata[0].encrypted,true);}
  process.env.TRACE_TEST_TARGET_KEY="target-secret";t.after(()=>delete process.env.TRACE_TEST_TARGET_KEY);
  const replay=await replayTraces({input:proxy.writer.file,output:path.join(root,"replay"),lines:[1],baseUrl:upstream.url+"/v1",apiKeyEnv:"TRACE_TEST_TARGET_KEY",model:"replacement",maxTokens:77});
  assert.equal(replay.results[0].model_complete,true);assert.equal(received[1].url,received[0].url);
  const replayed=JSON.parse(received[1].body);assert.equal(replayed.stream,streaming);assert.equal(replayed.extension.keep,true);assert.equal(replayed.model,"replacement");assert.equal(replayed[protocol==="openai-responses"?"max_output_tokens":"max_tokens"],77);
  assert.equal(received[1].headers[protocol==="anthropic-messages"?"x-api-key":"authorization"],protocol==="anthropic-messages"?"target-secret":"Bearer target-secret");
  if(protocol==="anthropic-messages")assert.equal(received[1].headers.authorization,undefined);
  assert.equal(validateTraces([path.join(root,"replay")],path.join(root,"replay-validation.json")).protocol_valid,true);
  exportTraces([path.join(root,"replay")],path.join(root,"replay-training.jsonl"));
  await reportTraces([root],path.join(root,"report.html"));assert.ok(fs.readFileSync(path.join(root,"report.html"),"utf8").includes(protocol));
  assert.equal(readRecords([root]).length,2,"directory discovery ignores exports and replay summaries");
});

test("replay explicit authentication replaces source credentials and redacts target credentials",async t=>{
  const root=workspace(t),writer=new TraceWriter(path.join(root,"capture")),f=fixture("anthropic-messages");
  write(writer,"anthropic-messages",f.request,f.response);writer.stop();
  const received:http.IncomingHttpHeaders[]=[];
  const upstream=await server(t,async(req,res)=>{await read(req);received.push(req.headers);res.setHeader("content-type","application/json");res.end(JSON.stringify(f.response));});
  process.env.TRACE_AUTH_OVERRIDE_KEY="new-target-secret";t.after(()=>delete process.env.TRACE_AUTH_OVERRIDE_KEY);
  for(const authScheme of ["bearer","x-api-key"] as const){
    const output=path.join(root,authScheme);
    const result=await replayTraces({input:writer.file,output,lines:[1],baseUrl:upstream.url+"/v1",apiKeyEnv:"TRACE_AUTH_OVERRIDE_KEY",authScheme});
    assert.equal(result.results[0].model_complete,true);
    const headers=received.at(-1)!;
    assert.equal(headers.authorization,authScheme==="bearer"?"Bearer new-target-secret":undefined);
    assert.equal(headers["x-api-key"],authScheme==="x-api-key"?"new-target-secret":undefined);
    assert.equal(headers["anthropic-version"],"2023-06-01");
    assert.ok(!fs.readFileSync(path.join(output,"trace.jsonl"),"utf8").includes("new-target-secret"));
  }
  await assert.rejects(replayTraces({input:writer.file,output:path.join(root,"invalid"),lines:[1],baseUrl:upstream.url,authScheme:"invalid" as any}),/invalid_auth_scheme/);
  assert.equal(received.length,2);
});

for(const protocol of PROTOCOLS)test(`${protocol}: HTTP errors, truncation and malformed tool arguments are independent outcomes`,t=>{
  const root=workspace(t),writer=new TraceWriter(path.join(root,"capture")),f=fixture(protocol);
  const error=write(writer,protocol,f.request,{error:{message:"no credentials"}},401);writer.stop();
  const result=adapters[protocol].validate(error);assert.equal(result.capture_complete,true);assert.equal(result.protocol_valid,true);assert.equal(result.http_success,false);assert.equal(result.model_complete,false);
  assert.equal(validateTraces([writer.file],path.join(root,"valid.json")).protocol_valid,true);
  assert.equal(validateTraces([writer.file],path.join(root,"incomplete.json"),"incomplete").capture_complete,false);
  assert.equal(exportTraces([writer.file],path.join(root,"train.jsonl")).counts.skipped,1);
  const truncated=structuredClone(error);truncated.response!.status_code=200;truncated.response!.body=f.response;
  if(protocol==="anthropic-messages")f.response.stop_reason="max_tokens";
  else if(protocol==="openai-responses")f.response.status="incomplete";
  else f.response.choices[0].finish_reason="length";
  assert.equal(adapters[protocol].validate(truncated).model_complete,false);
  if(protocol==="anthropic-messages"){f.response.stop_reason="tool_use";f.response.content=[{type:"tool_use",id:"a",name:"f",input:"{"}];}
  else if(protocol==="openai-responses"){f.response.status="completed";f.response.output=[{type:"function_call",call_id:"a",name:"f",arguments:"{"}];}
  else {f.response.choices[0]={message:{role:"assistant",content:null,tool_calls:[{id:"a",type:"function",function:{name:"f",arguments:"{"}}]},finish_reason:"tool_calls"};}
  assert.equal(adapters[protocol].validate(truncated).protocol_valid,false);
});

test("all system-policy combinations preserve developer order and do not require conversion",()=>{
  const messages=[{role:"system",content:"one"},{role:"user",content:"q"},{role:"developer",content:"dev"},{role:"system",content:"two"}];
  for(const convertDeveloperToSystem of [false,true])for(const filterSystemMessages of [false,true])for(const mergeSystemMessages of [false,true]){
    const out=transformMessages(messages,{convertDeveloperToSystem,filterSystemMessages,mergeSystemMessages});
    assert.equal(out.some(m=>m.role==="developer"),!convertDeveloperToSystem);
    const systems=out.filter(m=>m.role==="system");assert.equal(systems.length,filterSystemMessages||mergeSystemMessages?1:convertDeveloperToSystem?3:2);
    if(filterSystemMessages)assert.equal(systems[0].content,"one");
    else if(mergeSystemMessages)assert.equal(systems[0].content,convertDeveloperToSystem?"one\n\ndev\n\ntwo":"one\n\ntwo");
  }
  assert.equal(messages[2].role,"developer");assert.throws(()=>transformMessages([{role:"developer",content:"x",tools:[]}],{convertDeveloperToSystem:true}),/developer_metadata/);
});

test("Chat tool closure joins turns using raw history; forks, sessions, runs and changed tools segment",t=>{
  const root=workspace(t),w=new TraceWriter(path.join(root,"one")),f=fixture("openai-chat-completions");
  f.request.messages=[{role:"user",content:"q"}];f.request.tools=[{type:"function",function:{name:"search",parameters:{type:"object"}}}];
  const call={role:"assistant",content:"",tool_calls:[{id:"call",type:"function",function:{name:"search",arguments:'{"q":"x"}'}}]};
  const first={choices:[{message:call,finish_reason:"tool_calls"}]};write(w,"openai-chat-completions",f.request,first);
  f.request.messages.push(call,{role:"tool",tool_call_id:"call",content:"found"});write(w,"openai-chat-completions",f.request,f.response);
  f.request.messages.push(f.response.choices[0].message,{role:"user",content:"next"});write(w,"openai-chat-completions",f.request,f.response);
  f.request.messages=[{role:"user",content:"branch"}];write(w,"openai-chat-completions",f.request,f.response);
  f.request.tools=[];write(w,"openai-chat-completions",f.request,f.response);w.stop();
  const other=new TraceWriter(path.join(root,"two"));write(other,"openai-chat-completions",f.request,f.response);other.stop();
  const result=exportTraces([root],path.join(root,"train.jsonl"));assert.equal(result.counts.assigned,6);assert.equal(result.counts.trajectories,4);
  const chains=fs.readFileSync(path.join(root,"train.jsonl"),"utf8").trim().split("\n").map(JSON.parse as any);
  assert.equal(chains[0].messages.filter((m:Json)=>m.trainable).length,3);assert.equal(chains[0].messages[2].role,"tool");
  assert.ok(result.requests.some((r:Json)=>r.reason==="tools_changed"));assert.ok(result.requests.some((r:Json)=>r.reason==="divergent_history"));
});

test("Responses empty terminal envelope reconstructs full reasoning, not summary",t=>{
  const root=workspace(t),w=new TraceWriter(root),f=fixture("openai-responses");const record=write(w,"openai-responses",f.request,f.response);w.stop();
  delete record.response!.body;
  record.response!.body_raw=[{type:"response.output_item.added",output_index:0,item:{type:"reasoning",content:[],summary:[{type:"summary_text",text:"short"}]}},{type:"response.reasoning_text.delta",output_index:0,content_index:0,delta:"full"},{type:"response.output_item.done",output_index:1,item:{type:"message",role:"assistant",content:[{type:"output_text",text:"answer"}]}},{type:"response.completed",response:{status:"completed",output:[]}}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join("");
  const turn=adapters["openai-responses"].convert(record);assert.equal(turn.answer[0].reasoning_content,"full");assert.equal(turn.reasoning_metadata[0].summary[0].text,"short");
});

for(const mode of ["upstream-abort","client-cancel","shutdown","connection-error"])test(`capture persists exactly once on ${mode}`,async t=>{
  const root=workspace(t);let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
  let observed!:()=>void;const firstData=new Promise<void>(r=>observed=r);
  const upstream=await server(t,async(req,res)=>{await read(req);res.writeHead(200,{"content-type":"text/event-stream"});res.write('data: {"partial":true}\n\n');entered();if(mode==="upstream-abort")setTimeout(()=>res.destroy(),10);});
  if(mode==="connection-error")await new Promise<void>(resolve=>upstream.server.close(()=>resolve()));
  const proxy=new ReverseProxyServer({targetBaseUrl:upstream.url,logDirectory:root});const info=await proxy.start();t.after(()=>proxy.stop());
  const request=http.request(info.url+"/v1/responses",{method:"POST"},res=>{res.once("data",observed);res.resume();res.on("error",()=>{});if(mode==="client-cancel")res.destroy();});request.on("error",()=>{});request.end(JSON.stringify(fixture("openai-responses").request));
  if(mode!=="connection-error")await ready;
  if(mode==="shutdown"){await firstData;proxy.stop();}
  for(let i=0;i<100&&!fs.readFileSync(proxy.writer.file,"utf8").trim();i++)await new Promise(r=>setTimeout(r,5));
  proxy.stop();const records=readRecords([root]);assert.equal(records.length,1);assert.notEqual(records[0].record.status,"complete");assert.ok(records[0].record.error);
  if(mode!=="connection-error")assert.ok(records[0].record.response?.body_raw?.includes("partial"));
  else {
    const validated=adapters["openai-responses"].validate(records[0].record);
    assert.equal(validated.capture_complete,true);assert.equal(validated.protocol_valid,true);assert.equal(validated.model_complete,false);
  }
});

test("forward proxy uses raw schema-v2 capture and preserves unknown protocols",async t=>{
  const root=workspace(t);const upstream=await server(t,async(req,res)=>{await read(req);res.end('{"custom":true}');});
  const proxy=new ForwardProxyServer({logDirectory:root,disableMitm:true,includeAllRequests:true});const info=await proxy.start();t.after(()=>proxy.stop());
  await new Promise<void>((resolve,reject)=>{const req=http.request({host:"127.0.0.1",port:info.port,path:upstream.url+"/other",method:"POST"},res=>{res.resume();res.on("end",resolve);});req.on("error",reject);req.end('{"foo":1}');});
  proxy.stop();const [{record}]=readRecords([root]);assert.equal(record.protocol,"unknown");assert.deepEqual(record.response!.body,{custom:true});assert.equal(validateTraces([root],path.join(root,"validation.json")).protocol_valid,false);
});

test("replay stream controls, state refusal, deterministic sampling and concurrency",async t=>{
  const root=workspace(t),w=new TraceWriter(path.join(root,"source"));const f=fixture("openai-responses");
  for(let i=0;i<4;i++)write(w,"openai-responses",{...f.request,model:`m${i}`},f.response);w.stop();
  let active=0,maximum=0;const bodies:Json[]=[];
  const upstream=await server(t,async(req,res)=>{bodies.push(JSON.parse(await read(req)));active++;maximum=Math.max(maximum,active);setTimeout(()=>{active--;res.setHeader("content-type","application/json");res.end(JSON.stringify(f.response));},15);});
  const opts={input:w.file,baseUrl:upstream.url+"/prefix/v1",seed:0,count:4,concurrency:2,stream:"on" as const};
  const a=await replayTraces({...opts,output:path.join(root,"a")});assert.equal(maximum,2);assert.ok(bodies.every(b=>b.stream===true));
  const b=await replayTraces({...opts,output:path.join(root,"b"),stream:"off"});assert.deepEqual(a.results.map((r:Json)=>r.source.line),b.results.map((r:Json)=>r.source.line));assert.ok(bodies.slice(4).every(b=>b.stream===false));
  for(const field of ["conversation","previous_response_id","previous_input_messages"])assert.throws(()=>adapters["openai-responses"].replay({...f.request,[field]:"server-state"},{stream:"preserve"}),/requires_server_history/);
  assert.equal(replayUrl("https://host/prefix/v1/","chat/completions"),"https://host/prefix/v1/chat/completions");
  assert.equal(adapters["openai-chat-completions"].replay({model:"m",messages:[],max_completion_tokens:10},{stream:"preserve",maxTokens:20}).max_completion_tokens,20);
});

test("strict SSE parsing rejects malformed JSON and missing terminators",t=>{
  assert.throws(()=>parseSSE('data: {broken}\n\n'),/invalid_sse_json/);
  const root=workspace(t),w=new TraceWriter(root);
  for(const protocol of PROTOCOLS){const f=fixture(protocol),record=write(w,protocol,f.request,f.response);delete record.response!.body;record.response!.body_raw='data: {"choices":[]}\n\n';assert.equal(adapters[protocol].validate(record).protocol_valid,false);}
  w.stop();
});

for(const client of ["claude","codex","opencode"])test(`${client} launcher: controlled child uses profile overlay and leaves original config unchanged`,async t=>{
  const root=workspace(t),home=path.join(root,"home");fs.mkdirSync(home);
  const protocol:Protocol=client==="claude"?"anthropic-messages":client==="codex"?"openai-responses":"openai-chat-completions";
  const f=fixture(protocol);let hits=0;
  const upstream=await server(t,async(req,res)=>{assert.deepEqual(JSON.parse(await read(req)),f.request);hits++;res.setHeader("content-type","application/json");res.end(JSON.stringify(f.response));});
  const configDir=path.join(home,"config");fs.mkdirSync(configDir);
  const env:NodeJS.ProcessEnv={...process.env,HOME:home,USERPROFILE:home,NO_PROXY:"127.0.0.1",TRACE_CLIENT:client,TRACE_REQUEST:JSON.stringify(f.request)};
  let configFile:string,configText:string;
  if(client==="claude"){
    configFile=path.join(configDir,"settings.json");configText=JSON.stringify({env:{ANTHROPIC_BASE_URL:upstream.url}});env.CLAUDE_CONFIG_DIR=configDir;
  }else if(client==="codex"){
    configFile=path.join(configDir,"config.toml");configText=`model = "test-model"\nmodel_provider = "mock"\n[model_providers.mock]\nname = "mock"\nbase_url = "${upstream.url}/v1"\nwire_api = "responses"\n`;env.CODEX_HOME=configDir;
  }else{
    configFile=path.join(configDir,"opencode.json");configText=JSON.stringify({provider:{mock:{npm:"@ai-sdk/openai-compatible",options:{baseURL:upstream.url+"/v1"},models:{"test-model":{}}}}});env.OPENCODE_CONFIG=configFile;delete env.OPENCODE_CONFIG_CONTENT;
  }
  fs.writeFileSync(configFile,configText);
  const binary=path.join(root,"mock-client");
  fs.writeFileSync(binary,`#!${process.execPath}\nconst fs=require('fs');if(process.argv.includes('--version')){console.log('mock 1.0');process.exit(0)};let base;const name=process.env.TRACE_CLIENT;if(name==='claude'){base=process.env.ANTHROPIC_BASE_URL;const config=JSON.parse(fs.readFileSync(process.env.CLAUDE_CONFIG_DIR+'/settings.json'));if(config.env?.ANTHROPIC_BASE_URL)throw Error('overlay did not remove upstream override');}else if(name==='codex'){const config=require(${JSON.stringify(require.resolve('smol-toml'))}).parse(fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8'));base=config.model_providers.mock.base_url;}else{base=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).provider.mock.options.baseURL;}fetch(base.replace(/\\/$/,'')+'/${client==="claude"?"v1/messages":client==="codex"?"responses":"chat/completions"}',{method:'POST',headers:{'content-type':'application/json'},body:process.env.TRACE_REQUEST}).then(async r=>{await r.text();if(!r.ok)process.exitCode=1}).catch(e=>{console.error(e);process.exitCode=1});\n`,{mode:0o755});
  const script=client==="claude"?"cli":client+"-cli";
  const child=spawn(process.execPath,["--import","tsx",`src/cli/${script}.ts`,"--binary",binary,"--log-dir",path.join(root,"capture"),"--"],{env,cwd:process.cwd(),stdio:["ignore","pipe","pipe"]});
  let output="";child.stdout.on("data",b=>output+=b);child.stderr.on("data",b=>output+=b);
  const [code]=await once(child,"exit");assert.equal(code,0,output);assert.equal(hits,1);assert.equal(fs.readFileSync(configFile,"utf8"),configText);
  const [{record}]=readRecords([path.join(root,"capture")]);assert.equal(record.protocol,protocol);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,"capture","manifest.json"),"utf8"));assert.equal(manifest.client,client);assert.equal(manifest.client_version,"mock 1.0");
});

test("offline CLI does not discover clients, obeys exit codes and rejects removed modes",t=>{
  const root=workspace(t),w=new TraceWriter(path.join(root,"source")),f=fixture("openai-chat-completions");write(w,"openai-chat-completions",f.request,f.response);w.stop();
  const run=(args:string[])=>spawnSync(process.execPath,["--import","tsx","src/cli/llm-trace.ts",...args],{encoding:"utf8",env:{...process.env,PATH:"",HOME:root}});
  const before=fs.readFileSync(w.file);
  assert.equal(run(["validate","--input",w.file,"--output",path.join(root,"valid.json")]).status,0);
  assert.equal(run(["validate","--input",w.file,"--output",path.join(root,"incomplete.json"),"--outcome","incomplete"]).status,1);
  assert.equal(run(["validate","--input",w.file]).status,2);
  assert.equal(run(["replay","--input",w.file,"--base-url","http://localhost/v1"]).status,2);
  assert.equal(run(["export","--input",w.file,"--output",path.join(root,"train.jsonl"),"--merge-system-messages"]).status,0);
  assert.equal(run(["report","--input",w.file,"--output",path.join(root,"report.html")]).status,0);
  assert.deepEqual(fs.readFileSync(w.file),before);
  for(const script of ["cli","codex-cli","opencode-cli"]){
    const result=spawnSync(process.execPath,["--import","tsx",`src/cli/${script}.ts`,"--export-openai"],{encoding:"utf8",env:{...process.env,PATH:""}});assert.equal(result.status,2,result.stderr);
  }
});

test("compressed JSON is forwarded byte-for-byte and decoded only for storage",async t=>{
  const root=workspace(t),f=fixture("openai-chat-completions"),request=gzipSync(JSON.stringify(f.request)),response=gzipSync(JSON.stringify(f.response));
  const upstream=await server(t,async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(Buffer.from(c));assert.deepEqual(Buffer.concat(chunks),request);res.writeHead(200,{"content-type":"application/json","content-encoding":"gzip"});res.end(response);});
  const proxy=new ReverseProxyServer({targetBaseUrl:upstream.url,logDirectory:root});const info=await proxy.start();t.after(()=>proxy.stop());
  const actual=await new Promise<Buffer>((resolve,reject)=>{const req=http.request(info.url+"/v1/chat/completions",{method:"POST",headers:{"content-encoding":"gzip"}},res=>{const chunks:Buffer[]=[];res.on("data",c=>chunks.push(c));res.on("end",()=>resolve(Buffer.concat(chunks)));});req.on("error",reject);req.end(request);});
  assert.deepEqual(actual,response);proxy.stop();const [{record}]=readRecords([root]);assert.deepEqual(record.request.body,f.request);assert.deepEqual(record.response!.body,f.response);
});

for(const protocol of PROTOCOLS)test(`${protocol}: tool calls and results, including SSE`,t=>{
  const root=workspace(t),w=new TraceWriter(root),f=fixture(protocol);
  if(protocol==="anthropic-messages"){
    f.request.tools=[{name:"f",input_schema:{type:"object"}}];
    f.request.messages=[{role:"user",content:"q"},{role:"assistant",content:[{type:"tool_use",id:"old",name:"f",input:{x:1}}]},{role:"user",content:[{type:"tool_result",tool_use_id:"old",content:"ok"}]}];
    f.response.content=[{type:"tool_use",id:"new",name:"f",input:{x:2}}];f.response.stop_reason="tool_use";
  }else if(protocol==="openai-responses"){
    f.request.tools=[{type:"function",name:"f",parameters:{type:"object"}}];f.request.input=[{role:"user",content:"q"},{type:"function_call",call_id:"old",name:"f",arguments:'{"x":1}'},{type:"function_call_output",call_id:"old",output:"ok"}];
    f.response.output=[{type:"function_call",call_id:"new",name:"f",arguments:'{"x":2}'}];
  }else{
    f.request.tools=[{type:"function",function:{name:"f",parameters:{type:"object"}}}];f.request.messages=[{role:"user",content:"q"},{role:"assistant",content:null,tool_calls:[{id:"old",type:"function",function:{name:"f",arguments:'{"x":1}'}}]},{role:"tool",tool_call_id:"old",content:"ok"}];
    f.response.choices=[{index:0,message:{role:"assistant",content:null,tool_calls:[{index:0,id:"new",type:"function",function:{name:"f",arguments:'{"x":2}'}}]},finish_reason:"tool_calls"}];
  }
  const record=write(w,protocol,f.request,f.response);w.stop();assert.equal(adapters[protocol].validate(record).protocol_valid,true);
  const converted=adapters[protocol].convert(record);assert.equal(converted.history.at(-1)?.role,"tool");assert.deepEqual(converted.answer[0].tool_calls[0].function.arguments,{x:2});
  delete record.response!.body;record.response!.body_raw=sse(protocol,f.response);
  assert.deepEqual(adapters[protocol].convert(record).answer[0].tool_calls[0].function.arguments,{x:2});
});

test("explicit sessions and compaction boundaries isolate history independently of export options",t=>{
  const root=workspace(t),w=new TraceWriter(root),f=fixture("openai-chat-completions");
  f.request.messages=[{role:"developer",content:"policy"},{role:"user",content:"hi"}];
  f.request.metadata={session_id:"a"};write(w,"openai-chat-completions",f.request,f.response);
  f.request.messages.push(f.response.choices[0].message,{role:"user",content:"continue"});
  f.request.metadata={session_id:"b"};write(w,"openai-chat-completions",f.request,f.response);
  f.request.metadata={session_id:"a"};f.request.messages.push(f.response.choices[0].message,{role:"user",content:"<summary>compressed context</summary>"});write(w,"openai-chat-completions",f.request,f.response);w.stop();
  const plain=exportTraces([root],path.join(root,"plain.jsonl"));
  const changed=exportTraces([root],path.join(root,"changed.jsonl"),{convertDeveloperToSystem:true,filterSystemMessages:true,mergeSystemMessages:true});
  assert.equal(plain.counts.trajectories,3);assert.deepEqual(plain.requests,changed.requests);assert.equal(plain.requests.at(-1).reason,"compaction");
});

test("unknown multimodal and tool structures are retained raw and skipped with diagnostics",t=>{
  const root=workspace(t),w=new TraceWriter(root),f=fixture("openai-chat-completions");
  f.request.messages.push({role:"user",content:[{type:"image_url",image_url:{url:"data:image/png;base64,abcd"}}]});write(w,"openai-chat-completions",f.request,f.response);w.stop();
  const result=exportTraces([root],path.join(root,"training.jsonl"));assert.equal(result.counts.skipped,1);assert.match(result.requests[0].reason,/unsupported_content_image_url/);assert.ok(fs.readFileSync(w.file,"utf8").includes("abcd"));
});

test("model routing avoids duplicate Anthropic version prefixes",async t=>{
  const root=workspace(t),f=fixture("anthropic-messages");
  const upstream=await server(t,async(req,res)=>{assert.equal(req.url,"/v1/messages");await read(req);res.end(JSON.stringify(f.response));});
  const route={providerId:"mock",modelId:"test-model",upstreamBaseUrl:upstream.url+"/v1",npm:"@ai-sdk/anthropic",apiFormat:"anthropic-messages" as const};
  const proxy=new ReverseProxyServer({targetBaseUrl:upstream.url+"/v1",logDirectory:root,modelRoutes:{"test-model":route}});const info=await proxy.start();t.after(()=>proxy.stop());
  for(const endpoint of ["/messages","/v1/messages"]){const response=await fetch(info.url+endpoint,{method:"POST",body:JSON.stringify(f.request)});await response.text();assert.equal(response.status,200);}proxy.stop();assert.equal(readRecords([root]).length,2);
});

test("replay absolute timeout preserves partial response and marks incomplete",async t=>{
  const root=workspace(t),w=new TraceWriter(path.join(root,"source")),f=fixture("openai-chat-completions");write(w,"openai-chat-completions",f.request,f.response);w.stop();
  const upstream=await server(t,async(req,res)=>{await read(req);res.writeHead(200,{"content-type":"text/event-stream"});res.write('data: {"choices":[]}\n\n');});
  const report=await replayTraces({input:w.file,lines:[1],baseUrl:upstream.url+"/v1",output:path.join(root,"replay"),timeoutMs:100});
  assert.equal(report.results[0].capture_complete,false);assert.equal(report.results[0].model_complete,false);
  const [{record}]=readRecords([path.join(root,"replay")]);assert.equal(record.error?.code,"timeout");assert.ok(record.response!.body_raw!.includes("choices"));
});

test("failed attempt followed by retry keeps both raw records and exports only success",t=>{
  const root=workspace(t),w=new TraceWriter(root),f=fixture("anthropic-messages");write(w,"anthropic-messages",f.request,{error:{type:"rate_limit_error"}},429);write(w,"anthropic-messages",f.request,f.response);w.stop();
  assert.equal(readRecords([root]).length,2);const result=exportTraces([root],path.join(root,"train.jsonl"));assert.equal(result.counts.assigned,1);assert.equal(result.counts.skipped,1);
});

test("streaming chat normalizes empty calls consistently with subsequent history",t=>{
  const root=workspace(t),w=new TraceWriter(root),f=fixture("openai-chat-completions");
  const record=write(w,"openai-chat-completions",f.request,f.response);w.stop();delete record.response!.body;record.response!.body_raw=sse("openai-chat-completions",f.response);
  const answer=adapters["openai-chat-completions"].convert(record).answer[0];assert.equal("tool_calls" in answer,false);
  f.request.messages.push(f.response.choices[0].message);record.request.body=f.request;
  assert.deepEqual(adapters["openai-chat-completions"].convert(record).history.at(-1),answer);
});

test("complete SSE error termination is a model failure rather than malformed wire data",t=>{
  const root=workspace(t),w=new TraceWriter(root);
  for(const protocol of PROTOCOLS){const f=fixture(protocol),record=write(w,protocol,f.request,f.response);delete record.response!.body;record.response!.body_raw='event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"retry"}}\n\n';const result=adapters[protocol].validate(record);assert.equal(result.capture_complete,true);assert.equal(result.protocol_valid,true);assert.equal(result.model_complete,false);}
  w.stop();
});
