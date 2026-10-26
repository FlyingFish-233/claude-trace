#!/usr/bin/env node
/** @file llm-trace.ts @description Client-independent capture and offline commands. */
import { ReverseProxyServer } from "../intercept/reverse-proxy";
import { PROTOCOLS, Protocol } from "../protocols/types";
import { exportTraces, validateTraces } from "../trace/offline";
import { replayTraces } from "../trace/replay";
import { reportTraces } from "../trace/report";
import { parseOptions, required, integer, UsageError } from "./arguments";

const help=`llm-trace capture --upstream URL --log-dir DIR [--api-format auto|FORMAT] [--port N] [--host HOST]
llm-trace export --input PATH [--input PATH...] --output FILE
  [--convert-developer-to-system] [--filter-system-messages] [--merge-system-messages]
  [--merge-system-separator TEXT] (requires --merge-system-messages; default: two newlines)
llm-trace validate --input PATH [--input PATH...] --output FILE [--outcome complete|incomplete] [--strict]
llm-trace report --input PATH [--input PATH...] --output FILE
  Accepts schema-v2 trace.jsonl or train.jsonl (one training trajectory per line).
llm-trace replay --input FILE --base-url URL (--line-number N... | --seed N)
  [--output DIR] [--stream preserve|on|off] [--model MODEL] [--max-tokens N]
  [--api-key-env NAME] [--auth-scheme protocol|bearer|x-api-key]
  [--concurrency N] [--timeout-ms N] [--count N]
Formats: ${PROTOCOLS.join(", ")}
Capture writes trace.jsonl + manifest.json; export policy never modifies forwarded traffic.
Replay base URL is the full API prefix, e.g. https://host/v1. No tool execution.`;

/** Dispatch without loading a client profile or querying installed client versions. */
export async function main(argv=process.argv.slice(2)):Promise<void> {
  const [command,...args]=argv;
  if(!command||command==="--help"||command==="-h"||args.includes("--help")){console.log(help);return;}
  if(command==="capture") {
    const o=parseOptions(args,["--upstream","--log-dir","--api-format","--port","--host"],["--include-sensitive-headers"]);
    const format=o["--api-format"]?.[0]||"auto";
    if(format!=="auto"&&!PROTOCOLS.includes(format as Protocol))throw new UsageError("Invalid --api-format");
    const upstream=required(o,"--upstream");
    try {const u=new URL(upstream);if(!["http:","https:"].includes(u.protocol))throw new Error();}catch{throw new UsageError("Invalid --upstream URL");}
    const proxy=new ReverseProxyServer({targetBaseUrl:upstream,logDirectory:required(o,"--log-dir"),host:o["--host"]?.[0],
      port:integer(o["--port"]?.[0]||"0","port",0,65535),apiFormat:format==="auto"?undefined:format as Protocol,
      logSensitiveHeaders:!!o["--include-sensitive-headers"]});
    try {const info=await proxy.start();console.log(JSON.stringify({...info,trace:proxy.writer.file,manifest:proxy.writer.manifestPath}));}
    catch(error){proxy.stop();throw error;}
    const stop=()=>{proxy.stop();process.off("SIGINT",stop);process.off("SIGTERM",stop);};
    process.on("SIGINT",stop);process.on("SIGTERM",stop);return;
  }
  if(command==="replay") {
    const o=parseOptions(args,["--input","--output","--base-url","--line-number","--seed","--count","--stream","--model","--max-tokens","--api-key-env","--auth-scheme","--concurrency","--timeout-ms"],[],["--line-number"]);
    if(!!o["--line-number"]===!!o["--seed"])throw new UsageError("Choose --line-number or --seed (mutually exclusive)");
    if(o["--count"]&&!o["--seed"])throw new UsageError("--count requires --seed");
    const stream=o["--stream"]?.[0]||"preserve";
    if(!["preserve","on","off"].includes(stream))throw new UsageError("Invalid --stream");
    const authScheme=o["--auth-scheme"]?.[0]||"protocol";
    if(!["protocol","bearer","x-api-key"].includes(authScheme))throw new UsageError("Invalid --auth-scheme");
    const baseUrl=required(o,"--base-url");
    try {const u=new URL(baseUrl);if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error();}catch{throw new UsageError("Invalid --base-url");}
    const result=await replayTraces({input:required(o,"--input"),output:o["--output"]?.[0]||`replay-${Date.now()}`,baseUrl,
      lines:o["--line-number"]?.map(n=>integer(n,"line-number")),seed:o["--seed"]?integer(o["--seed"][0],"seed",0):undefined,
      count:o["--count"]?integer(o["--count"][0],"count"):undefined,stream:stream as "preserve"|"on"|"off",
      model:o["--model"]?.[0],maxTokens:o["--max-tokens"]?integer(o["--max-tokens"][0],"max-tokens"):undefined,
      apiKeyEnv:o["--api-key-env"]?.[0],authScheme:authScheme as "protocol"|"bearer"|"x-api-key",concurrency:integer(o["--concurrency"]?.[0]||"1","concurrency"),timeoutMs:integer(o["--timeout-ms"]?.[0]||"120000","timeout-ms")});
    console.log(JSON.stringify(result));if(result.results.some((r:any)=>!r.capture_complete||!r.protocol_valid||!r.http_success||!r.model_complete))process.exitCode=1;return;
  }
  if(!["export","validate","report"].includes(command))throw new UsageError(`Unknown command: ${command}`);
  const o=parseOptions(args,["--input","--output",...(command==="validate"?["--outcome"]:command==="export"?["--merge-system-separator"]:[])],command==="export"?["--convert-developer-to-system","--filter-system-messages","--merge-system-messages"]:command==="validate"?["--strict"]:[],["--input"]);
  if(o["--merge-system-separator"]&&!o["--merge-system-messages"])throw new UsageError("--merge-system-separator requires --merge-system-messages");
  required(o,"--input");const output=required(o,"--output");
  if(command==="validate") {
    const outcome=o["--outcome"]?.[0]||"complete";if(!["complete","incomplete"].includes(outcome))throw new UsageError("Invalid --outcome");
    const result=validateTraces(o["--input"],output,outcome as "complete"|"incomplete",!!o["--strict"]);console.log(JSON.stringify(result.counts));
    if(!result.capture_complete||!result.protocol_valid)process.exitCode=1;
  }else if(command==="export") console.log(JSON.stringify(exportTraces(o["--input"],output,{
    convertDeveloperToSystem:!!o["--convert-developer-to-system"],filterSystemMessages:!!o["--filter-system-messages"],mergeSystemMessages:!!o["--merge-system-messages"],mergeSystemSeparator:o["--merge-system-separator"]?.[0]}).counts));
  else await reportTraces(o["--input"],output);
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=error instanceof UsageError?2:1;});
