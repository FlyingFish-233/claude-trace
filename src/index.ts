/**
 * @file index.ts
 * @description Public package entry point for programmatic use of claude-trace.
 *
 * Re-exports the traffic logger (V1 interceptor), HTML generator, offline SFT
 * exporters, Responses conversion and shared types for programmatic consumers.
 */

// Main exports for the package
export { ClaudeTrafficLogger, initializeInterceptor, getLogger, InterceptorConfig } from "./intercept/interceptor";
export { HTMLGenerator } from "./report/html-generator";
export { RawPair, ClaudeData, HTMLGenerationData, TemplateReplacements } from "./types";

// Re-export everything for convenience
export * from "./intercept/interceptor";
export * from "./report/html-generator";
export * from "./types";

// Offline conversion/export functions never launch a coding client.
export { exportOpenAI } from "./export/openai";
export type { ExportOpenAIOptions, ExportDiagnostics, ExportedTrajectory } from "./export/openai";
export { exportCodexOpenAI } from "./export/responses";
export type { ResponsesTrajectory } from "./export/responses";
export { convertResponsesRequest } from "./export/responses-conversion";
export type { ConvertedResponsesRequest, ExportCodexOpenAIOptions } from "./export/responses-conversion";
