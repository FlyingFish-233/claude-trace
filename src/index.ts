/** @file index.ts @description Client-independent public trace API. */
export * from "./protocols/types";
export { adapters, detectProtocol, parseSSE } from "./protocols/registry";
export { TraceWriter, readRecords, inputFiles } from "./trace/store";
export { exportTraces, validateTraces, transformMessages } from "./trace/offline";
export { replayTraces } from "./trace/replay";
export type { ReplayOptions } from "./trace/replay";
export { reportTraces } from "./trace/report";
export { ReverseProxyServer } from "./intercept/reverse-proxy";
export { ForwardProxyServer } from "./intercept/forward-proxy";
