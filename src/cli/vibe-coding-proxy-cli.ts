#!/usr/bin/env node
/** @file vibe-coding-proxy-cli.ts @description Standalone forward capture proxy. */
import { ForwardProxyServer } from "../intercept/forward-proxy";
import { parseOptions, integer, UsageError } from "./arguments";
/** Start the proxy without client discovery or offline tool modes. */
async function main():Promise<void>{
 const args=process.argv.slice(2);
 if(args.includes("--help")||args.includes("-h")){console.log("vibe-coding-proxy --log-dir DIR [--target-url URL...] [--mitm-host HOST...] [--no-mitm] [--ca-dir DIR] [--host HOST] [--port N] [--include-all-requests] [--include-sensitive-headers]\nReports: llm-trace report --input DIR --output FILE");return;}
 const o=parseOptions(args,["--log-dir","--target-url","--mitm-host","--ca-dir","--host","--port"],["--no-mitm","--include-all-requests","--include-sensitive-headers"],["--target-url","--mitm-host"]);
 const proxy=new ForwardProxyServer({logDirectory:o["--log-dir"]?.[0]||`.vibe-coding-proxy/${Date.now()}`,targetUrls:o["--target-url"],mitmHosts:o["--mitm-host"],caDir:o["--ca-dir"]?.[0],host:o["--host"]?.[0],port:integer(o["--port"]?.[0]||"0","port",0,65535),disableMitm:!!o["--no-mitm"],includeAllRequests:!!o["--include-all-requests"],logSensitiveHeaders:!!o["--include-sensitive-headers"]});
 try{const info=await proxy.start();console.log(JSON.stringify(info));}catch(error){proxy.stop();throw error;}
 const stop=()=>{proxy.stop();process.off("SIGINT",stop);process.off("SIGTERM",stop);};
 process.on("SIGINT",stop);process.on("SIGTERM",stop);
}
main().catch(error=>{console.error(error.message);process.exitCode=error instanceof UsageError?2:1;});
