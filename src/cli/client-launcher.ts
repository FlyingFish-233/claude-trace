/** @file client-launcher.ts @description Thin profile CLI; offline commands live in llm-trace. */
import { ToolProfile } from "../tools/types";
import { PROTOCOLS, Protocol } from "../protocols/types";
import { runWithTracing } from "./trace-runner";
import { parseOptions, UsageError } from "./arguments";
/** Parse capture options before -- and pass subsequent arguments to the client unchanged. */
export async function launchClient(profile: ToolProfile, argv = process.argv.slice(2)): Promise<void> {
  if(argv[0]==="--help" || argv[0]==="-h") {
    console.log(`${profile.name}-trace [--log-dir DIR] [--binary PATH] [--api-format auto|FORMAT] [--include-sensitive-headers] -- [client arguments]\nOffline operations: llm-trace export|validate|replay|report`); return;
  }
  const separator=argv.indexOf("--");
  const options=parseOptions(separator<0?argv:argv.slice(0,separator),["--log-dir","--binary","--api-format"],["--include-sensitive-headers"]);
  const format=options["--api-format"]?.[0] || "auto";
  if(format!=="auto" && !PROTOCOLS.includes(format as Protocol)) throw new UsageError(`Unknown API format: ${format}`);
  await runWithTracing(profile,separator<0?[]:argv.slice(separator+1),{
    logDirectory:options["--log-dir"]?.[0], customBinaryPath:options["--binary"]?.[0],
    logSensitiveHeaders:!!options["--include-sensitive-headers"], apiFormat:format==="auto"?undefined:format as Protocol,
  });
}
/** Shared CLI failure mapping. */
export function cliFailure(error: Error): void { console.error(error.message); process.exitCode=error instanceof UsageError?2:1; }
