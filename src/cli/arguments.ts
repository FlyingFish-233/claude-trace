/** @file arguments.ts @description Strict argument validation shared by command entry points. */
export class UsageError extends Error {}
/** Parse only supported flags and reject missing, duplicate or positional values. */
export function parseOptions(args: string[], values: string[], flags: string[] = [], repeated: string[] = []): Record<string,string[]> {
  const result: Record<string,string[]> = {};
  for(let i=0;i<args.length;i++) {
    const name=args[i];
    if (!values.includes(name) && !flags.includes(name)) throw new UsageError(`Unknown option: ${name}`);
    if(result[name] && !repeated.includes(name)) throw new UsageError(`Duplicate option: ${name}`);
    let value="true";
    if(values.includes(name)) { value=args[++i]; if(value===undefined || value.startsWith("--")) throw new UsageError(`Missing value: ${name}`); }
    (result[name] ||= []).push(value);
  }
  return result;
}
/** Require one option value. */
export function required(options: Record<string,string[]>, key: string): string {
  if(!options[key]?.[0]) throw new UsageError(`Required: ${key}`); return options[key][0];
}
/** Parse a bounded integer without silently accepting NaN or fractional values. */
export function integer(value: string, name: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  const n=Number(value); if(!Number.isSafeInteger(n)||n<minimum||n>maximum) throw new UsageError(`Invalid ${name}: ${value}`); return n;
}
