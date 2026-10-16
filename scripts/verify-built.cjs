#!/usr/bin/env node
/** @file verify-built.cjs @description Exercise compiled CLIs and packaged offline launchers without external services. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-trace-built-'));

/** Fail with useful child diagnostics and no client invocation. */
function run(binary, args, cwd = root) {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${binary} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
/** Verify compiled capture/offline flows, then an actual npm tarball and every offline bin. */
async function main() {
  let capture;
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) {}
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
  });
  try {
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const cli = path.join(root, 'dist/cli/llm-trace.js');
    const dir = path.join(temporary, 'capture');
    capture = spawn(process.execPath, [cli, 'capture', '--upstream', `http://127.0.0.1:${upstream.address().port}/v1`, '--log-dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; capture.stderr.on('data', c => errors += c);
    const info = await new Promise((resolve, reject) => {
      let buffer = ''; const timer = setTimeout(() => reject(Error('capture startup timed out: ' + errors)), 10000);
      capture.stdout.on('data', chunk => { buffer += chunk; if(buffer.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(buffer.split('\n')[0])); } });
      capture.once('exit', code => { clearTimeout(timer); reject(Error('capture exited: ' + code + errors)); });
    });
    const result = await fetch(info.url + '/chat/completions', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'mock',messages:[{role:'user',content:'hi'}]})});
    assert.equal(result.status, 200); await result.text();
    const exited = once(capture, 'exit'); capture.kill('SIGTERM'); await exited;
    for (const command of ['validate','export','report']) run(process.execPath,[cli,command,'--input',dir,'--output',path.join(temporary,command+'.out')]);
    // Replay must run asynchronously while the mock server is servicing HTTP.
    const replay = spawn(process.execPath,[cli,'replay','--input',info.trace,'--line-number','1','--base-url',`http://127.0.0.1:${upstream.address().port}/v1`,'--output',path.join(temporary,'replay')],{stdio:['ignore','pipe','pipe']});
    let replayOutput='';replay.stdout.on('data',b=>replayOutput+=b);replay.stderr.on('data',b=>replayOutput+=b);
    assert.equal((await once(replay,'exit'))[0],0,replayOutput);
    const packed = JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',temporary]));
    const pack = Object.values(packed)[0];
    assert.ok(pack.files.some(f=>f.path==='dist/cli/llm-trace.js'));
    assert.ok(!pack.files.some(f=>f.path==='dist/cli/replay.js'||f.path.startsWith('dist/export/')));
    const bundle=path.join(temporary,'bundle'); const modules=path.join(bundle,'package/node_modules/@uvl000');fs.mkdirSync(modules,{recursive:true});
    run('tar',['-xf',path.join(temporary,pack.filename),'-C',modules]);fs.renameSync(path.join(modules,'package'),path.join(modules,'claude-trace'));
    fs.mkdirSync(path.join(bundle,'node/bin'),{recursive:true});fs.symlinkSync(process.execPath,path.join(bundle,'node/bin/node'));
    fs.cpSync(path.join(root,'offline/bin'),path.join(bundle,'bin'),{recursive:true});
    for(const bin of ['llm-trace','claude-trace','codex-trace','opencode-trace','vibe-coding-proxy']) {
      const entry=path.join(bundle,'bin',bin);fs.chmodSync(entry,0o755);run(entry,['--help']);
    }
    run(path.join(bundle,'bin/llm-trace'),['validate','--input',dir,'--output',path.join(temporary,'packed-validation.json')]);
    const api=require(path.join(modules,'claude-trace'));assert.equal(typeof api.exportTraces,'function');assert.equal(api.exportCodexOpenAI,undefined);
    console.log('PASS: compiled capture/export/validate/report/replay; npm tarball; five offline launchers; public API');
  } finally {
    capture?.kill(); upstream.closeAllConnections(); upstream.close(); fs.rmSync(temporary,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
