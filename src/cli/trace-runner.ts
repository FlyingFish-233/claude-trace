/** @file trace-runner.ts @description Capture-only client lifecycle using profile configuration. */
import { spawn, spawnSync } from "child_process";
import * as path from "path";
import { randomUUID } from "crypto";
import { ReverseProxyServer } from "../intercept/reverse-proxy";
import { ToolProfile, TraceOptions } from "../tools/types";

/** Launch any supported client through the same proxy, forwarding child exit status. */
export async function runWithTracing(profile: ToolProfile, args: string[] = [], options: TraceOptions = {}): Promise<void> {
  const binary = profile.getBinaryPath(options.customBinaryPath);
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5000 });
  const providers = profile.listProviderRoutes?.() || [];
  const models = profile.listModelRoutes?.() || {};
  const proxy = new ReverseProxyServer({
    targetBaseUrl: providers[0]?.upstreamBaseUrl || profile.readUpstreamBaseUrl(),
    routes: Object.fromEntries(providers.map(r => [r.id,r.upstreamBaseUrl])), providerRoutes: providers,
    modelRoutes: Object.keys(models).length ? models : undefined,
    logDirectory: options.logDirectory || path.join(profile.logDirectory, `${Date.now()}-${randomUUID().slice(0,8)}`),
    client: profile.name, clientVersion: version.status === 0 ? version.stdout.trim() : undefined,
    logSensitiveHeaders: options.logSensitiveHeaders, apiFormat: options.apiFormat,
  });
  let tmpDir: string | null = null;
  let child: ReturnType<typeof spawn> | undefined;
  const signal = (name: NodeJS.Signals) => { child?.kill(name); proxy.stop(); };
  const onInt = () => signal("SIGINT"), onTerm = () => signal("SIGTERM");
  try {
    const info = await proxy.start(); console.error(`Capture: ${proxy.writer.file}\nAPI: ${info.url}`);
    const prepared = profile.prepareSpawnEnv(info.url); tmpDir = prepared.tmpDir;
    child = spawn(binary,args,{env:prepared.spawnEnv,stdio:"inherit"});
    process.on("SIGINT",onInt); process.on("SIGTERM",onTerm);
    process.exitCode = await new Promise<number>((resolve,reject) => {
      child!.once("error",reject); child!.once("exit",(code, sig) => resolve(code ?? (sig ? 1 : 0)));
    });
  } finally {
    process.off("SIGINT",onInt); process.off("SIGTERM",onTerm);
    proxy.stop(); profile.cleanupTempConfig(tmpDir);
  }
}
