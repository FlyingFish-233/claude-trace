/** @file replay.ts @description Same-protocol replay selection, concurrency and raw output capture. */
import * as http from "http";
import * as https from "https";
import * as path from "path";
import { adapters } from "../protocols/registry";
import { Json, TraceRecord } from "../protocols/types";
import { TraceWriter, Exchange, readRecords, writeJson, LocatedRecord } from "./store";
import { createOutboundAgent } from "../intercept/reverse-proxy";

/** Explicit replay policy; target credentials never come from the source capture. */
export interface ReplayOptions {
  input: string; output: string; baseUrl: string; lines?: number[]; seed?: number; count?: number;
  concurrency?: number; timeoutMs?: number; stream?: "preserve" | "on" | "off";
  model?: string; maxTokens?: number; apiKeyEnv?: string; authScheme?: "protocol" | "bearer" | "x-api-key";
}
/** Build exactly one operation below a complete API prefix. */
export function replayUrl(base: string, operation: string): string {
  const url=new URL(base);
  if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash) throw new Error("invalid_base_url");
  url.pathname=url.pathname.replace(/\/+$/,"")+"/"+operation; return url.toString();
}
/** Run one request with an absolute timeout and persist success or partial failure exactly once. */
async function attempt(writer: TraceWriter, source: LocatedRecord, url: string, body: Json, headers: Json, timeout: number, signal: AbortSignal): Promise<TraceRecord> {
  const exchange: Exchange={method:"POST",url,requestHeaders:headers,requestBody:Buffer.from(JSON.stringify(body)),
    requestTimestamp:Date.now(),responseChunks:[],protocol:source.record.protocol,
    source:{file:source.file,line:source.line,request_id:source.record.request_id}};
  return new Promise(resolve=>{
    let done=false; let response: http.IncomingMessage | undefined;
    const finish=(error?:string)=>{
      if(done)return; done=true; clearTimeout(timer); signal.removeEventListener("abort",cancel); exchange.status=error==="replay_cancelled"?"aborted":error?"error":"complete";
      if(error)exchange.error={code:error,message:error}; resolve(writer.write(exchange));
    };
    const request=(url.startsWith("https:")?https:http).request(url,{method:"POST",headers,agent:createOutboundAgent(url)},res=>{
      response=res; exchange.responseTimestamp=Date.now();exchange.statusCode=res.statusCode;exchange.responseHeaders=res.headers;
      res.on("data",chunk=>{exchange.firstChunkTimestamp??=Date.now();exchange.responseChunks.push(Buffer.from(chunk));});
      res.on("end",()=>finish());res.on("aborted",()=>finish("upstream_stream_interrupted"));res.on("error",()=>finish("upstream_stream_error"));
    });
    const timer=setTimeout(()=>{finish("timeout");request.destroy();response?.destroy();},timeout);
    const cancel=()=>{finish("replay_cancelled");request.destroy();response?.destroy();};
    signal.addEventListener("abort",cancel,{once:true});
    request.on("error",(error:NodeJS.ErrnoException)=>finish(error.code||"connection_error"));request.end(exchange.requestBody);
  });
}
/** Validate selection before sending traffic, then process requests through bounded workers. */
export async function replayTraces(options: ReplayOptions): Promise<Json> {
  for (const [name, value] of Object.entries({ concurrency: options.concurrency ?? 1, timeout: options.timeoutMs ?? 120000, count: options.count ?? 1, maxTokens: options.maxTokens ?? 1 })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid_${name}`);
  }
  if (options.stream && !["preserve","on","off"].includes(options.stream)) throw new Error("invalid_stream");
  if (options.authScheme && !["protocol","bearer","x-api-key"].includes(options.authScheme)) throw new Error("invalid_auth_scheme");
  const all=readRecords([options.input]);
  if((options.lines!==undefined)===(options.seed!==undefined))throw new Error("choose_lines_or_seed");
  if(new Set(all.map(r=>r.file)).size!==1)throw new Error("replay_requires_one_trace_file");
  let chosen: LocatedRecord[];
  if(options.lines) chosen=options.lines.map(line=>{const entry=all.find(r=>r.line===line);if(!entry)throw new Error(`line_not_found:${line}`);return entry;});
  else {
    let seed=options.seed!>>>0;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    chosen=[...all]; for(let i=chosen.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[chosen[i],chosen[j]]=[chosen[j],chosen[i]];}
    chosen=chosen.slice(0,options.count??1);
  }
  if(!chosen.length)throw new Error("empty_selection");
  const token=options.apiKeyEnv?process.env[options.apiKeyEnv]:undefined;
  if(options.apiKeyEnv&&!token)throw new Error(`missing_api_key_env:${options.apiKeyEnv}`);
  const jobs=chosen.map(source=>{
    if(source.record.protocol==="unknown"||!adapters[source.record.protocol])throw new Error("unknown_protocol");
    const adapter=adapters[source.record.protocol];
    const body=adapter.replay(source.record.request.body,{stream:options.stream||"preserve",model:options.model,maxTokens:options.maxTokens});
    const headers:Json={"content-type":"application/json"};
    if(adapter.id==="anthropic-messages") {
      headers["anthropic-version"]=source.record.request.headers["anthropic-version"]||"2023-06-01";
      if(source.record.request.headers["anthropic-beta"])headers["anthropic-beta"]=source.record.request.headers["anthropic-beta"];
    }
    const authScheme=options.authScheme && options.authScheme!=="protocol" ? options.authScheme : adapter.id==="anthropic-messages"?"x-api-key":"bearer";
    if(token) {
      if(authScheme==="x-api-key")headers["x-api-key"]=token;
      else headers.authorization=`Bearer ${token}`;
    }
    for (const [name, value] of Object.entries(headers)) http.validateHeaderValue(name, value);
    return {source,body,headers,url:replayUrl(options.baseUrl,adapter.operation),adapter};
  });
  const writer=new TraceWriter(options.output,{config:{operation:"replay",base_url:options.baseUrl}});
  const controller=new AbortController();
  const cancel=()=>controller.abort();process.on("SIGINT",cancel);process.on("SIGTERM",cancel);
  let cursor=0;
  const results:Json[]=[];
  try {
    await Promise.all(Array.from({length:Math.min(options.concurrency??1,jobs.length)},async()=>{
      while(cursor<jobs.length&&!controller.signal.aborted){const index=cursor++,job=jobs[index];const record=await attempt(writer,job.source,job.url,job.body,job.headers,options.timeoutMs??120000,controller.signal);
        results.push({index,source:record.source,request_id:record.request_id,...job.adapter.validate(record)});}
    }));
  }finally{process.off("SIGINT",cancel);process.off("SIGTERM",cancel);writer.stop(!controller.signal.aborted&&results.length===jobs.length&&results.every(r=>r.capture_complete)?"complete":"incomplete");}
  results.sort((a,b)=>a.index-b.index);
  const report={schema_version:2,run_id:writer.runId,results};writeJson(path.join(options.output,"replay.json"),report);return report;
}
