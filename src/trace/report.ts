/** @file report.ts @description Offline reports generated with the conversation viewer. */
import { RawPair } from "../types";
import { HTMLGenerator } from "../report/html-generator";
import { readRecords, assertNewOutput, inputFiles } from "./store";
import { TrainTrajectory } from "../types";
import fs from "fs";

/** Produce the self-contained conversation viewer from schema-v2 trace records. */
export async function reportTraces(inputs: string[], output: string): Promise<void> {
  assertNewOutput(output);
  const files = inputFiles(inputs);
  const trajectories: TrainTrajectory[] = [];
  let format: "trace" | "train" | undefined;
  for (const file of files) {
    fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      let value: any;
      try { value = JSON.parse(line); } catch { throw new Error(`invalid_json: ${file}:${index + 1}`); }
      const kind = Array.isArray(value?.messages) ? "train" : "trace";
      if (format && format !== kind) throw new Error(`mixed_report_inputs: ${file}:${index + 1}`);
      format = kind;
      if (kind === "train") {
        if (!value.messages.every((message: any) => message && typeof message.role === "string" &&
          (message.trainable === undefined || typeof message.trainable === "boolean"))) {
          throw new Error(`invalid_train_record: ${file}:${index + 1}`);
        }
        trajectories.push({ ...value, source: { file, line: index + 1 } });
      }
    });
  }
  if (format === "train") {
    await new HTMLGenerator().generateHTML([], output, {
      includeAllRequests: true, trainTrajectories: trajectories,
      title: `train trace · ${trajectories.length} Trajectories`,
    });
    return;
  }
  const pairs = readRecords(inputs).map(({ record }) => record as RawPair);
  await new HTMLGenerator().generateHTML(pairs, output, {
    includeAllRequests: true,
  });
}
