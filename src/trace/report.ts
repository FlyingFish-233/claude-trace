/** @file report.ts @description Offline HTML reports with raw records and independent validation outcomes. */
import * as fs from "fs";
import { readRecords, assertNewOutput } from "./store";
import { adapters } from "../protocols/registry";

/** Produce a self-contained, searchable report without normalizing or mutating captured payloads. */
export async function reportTraces(inputs:string[],output:string):Promise<void> {
  assertNewOutput(output);
  const entries=readRecords(inputs).map(({record,file,line})=>{
    const adapter=record.protocol!=="unknown"?adapters[record.protocol]:undefined;
    let normalized: unknown;
    try { normalized=adapter?.convert(record); } catch(error) { normalized={diagnostic:(error as Error).message}; }
    return {record,file,line,normalized,validation:adapter?.validate(record)||{errors:["unknown_protocol"]}};
  });
  const escape=(value:any)=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const rows=entries.map(({record,file,line,validation,normalized})=>`<article data-search="${escape([record.run_id,record.protocol,record.request.body?.model,record.request.url].join(' '))}"><h2>${escape(record.protocol)} · ${escape(record.request_id)}</h2><p>Run ${escape(record.run_id)} · ${escape(file)}:${line}</p><p>HTTP ${record.response?.status_code??'—'} · ${escape(record.status)}</p><pre>${escape(JSON.stringify(validation,null,2))}</pre><details open><summary>Normalized messages / reasoning provenance</summary><pre>${escape(JSON.stringify(normalized,null,2))}</pre></details><details><summary>Request</summary><pre>${escape(JSON.stringify(record.request,null,2))}</pre></details><details><summary>Response (native JSON / raw SSE)</summary><pre>${escape(JSON.stringify(record.response,null,2))}</pre></details><details><summary>Timing (milliseconds)</summary><pre>${escape(JSON.stringify(record.timing,null,2))}</pre></details></article>`).join('');
  fs.writeFileSync(output,`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LLM trace report</title><style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:0 20px;background:#f6f7f9;color:#172335}article{background:white;padding:20px;margin:20px 0;border:1px solid #ddd;border-radius:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}h2{font-size:18px}input{padding:10px;width:80%}summary{cursor:pointer;padding:10px}p{overflow-wrap:anywhere}</style><h1>LLM trace report</h1><p>${entries.length} requests · raw capture and validation</p><input id="search" aria-label="Search" placeholder="Filter run, protocol, model, URL"><main>${rows}</main><script>document.getElementById('search').addEventListener('input',e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('article').forEach(a=>a.hidden=!a.dataset.search.toLowerCase().includes(q));});</script></html>`,{flag:"wx"});
}
