import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/serve.mjs runs the dev server in the foreground with a pidfile, so `npm run stop`
// can end exactly that process. Each test serves a temporary directory on a free port.
const script = new URL('../scripts/serve.mjs', import.meta.url).pathname;

const freePort = () => new Promise((resolve) => {
  const srv = createServer().listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

const responds = (port) => fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'serve-'));
  writeFileSync(join(dir, 'index.html'), '<p>hi</p>');
  return { dir, port: await freePort() };
};

const start = (dir, port) => spawn(process.execPath, [script], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: 'pipe' });
const run = (dir, port, ...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, env: { ...process.env, PORT: String(port) }, encoding: 'utf8' });

test('serve answers on PORT and writes its pid to .serve.pid', async (t) => {
  const { dir, port } = await setup();
  const child = start(dir, port);
  t.after(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });
  assert.ok(await until(() => responds(port)), 'server never answered');
  assert.equal(Number(readFileSync(join(dir, '.serve.pid'), 'utf8')), child.pid);
});

test('stop ends the server and its python child, and removes the pidfile', async (t) => {
  const { dir, port } = await setup();
  const child = start(dir, port);
  t.after(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });
  assert.ok(await until(() => responds(port)));
  const res = run(dir, port, 'stop');
  assert.equal(res.status, 0, res.stderr);
  assert.ok(await until(() => !alive(child.pid)), 'server process still alive');
  assert.ok(await until(async () => !(await responds(port))), 'port still answers');
  assert.equal(existsSync(join(dir, '.serve.pid')), false);
});

test('a second serve while one runs exits 0 and says so, without a second server', async (t) => {
  const { dir, port } = await setup();
  const child = start(dir, port);
  t.after(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });
  assert.ok(await until(() => responds(port)));
  const res = run(dir, port);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /already serving/);
  assert.equal(Number(readFileSync(join(dir, '.serve.pid'), 'utf8')), child.pid);
});

test('stop with no server running exits 0', async (t) => {
  const { dir, port } = await setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const res = run(dir, port, 'stop');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /not running/);
});

test('a stale pidfile is ignored and replaced', async (t) => {
  const { dir, port } = await setup();
  writeFileSync(join(dir, '.serve.pid'), '999999');
  const child = start(dir, port);
  t.after(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });
  assert.ok(await until(() => responds(port)));
  assert.equal(Number(readFileSync(join(dir, '.serve.pid'), 'utf8')), child.pid);
});

test('serve fails clearly when the port is taken by another process', async (t) => {
  const { dir, port } = await setup();
  const blocker = createServer().listen(port, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  t.after(() => { blocker.close(); rmSync(dir, { recursive: true, force: true }); });
  const res = run(dir, port);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, new RegExp(`port ${port} is in use`));
  assert.equal(existsSync(join(dir, '.serve.pid')), false);
});
