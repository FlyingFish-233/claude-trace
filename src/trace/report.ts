/** @file report.ts @description Offline reports generated with the conversation viewer. */
import { RawPair } from "../types";
import { HTMLGenerator } from "../report/html-generator";
import { readRecords, assertNewOutput } from "./store";

/** Produce the self-contained conversation viewer from schema-v2 trace records. */
export async function reportTraces(inputs: string[], output: string): Promise<void> {
  assertNewOutput(output);
  const pairs = readRecords(inputs).map(({ record }) => record as RawPair);
  await new HTMLGenerator().generateHTML(pairs, output, {
    includeAllRequests: true,
  });
}
