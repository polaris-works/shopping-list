#!/usr/bin/env node
// Dev server with a pidfile.
//   npm run serve   serve the current directory on PORT (default 8080), in the foreground
//   npm run stop    end the server that `npm run serve` started here
//
// Run `npm run serve` in its own command (Claude: Bash with run_in_background) and stop it
// with `npm run stop`, never with `pkill -f`: a pkill pattern also matches the shell that
// runs it, and kills that shell.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const PIDFILE = join(process.cwd(), '.serve.pid');
const port = Number(process.env.PORT) || 8080;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const readPid = () => {
  if (!existsSync(PIDFILE)) return null;
  const pid = Number(readFileSync(PIDFILE, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
};

const portFree = () => new Promise((resolve) => {
  const probe = createServer()
    .once('error', () => resolve(false))
    .listen(port, () => probe.close(() => resolve(true)));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const serve = async () => {
  const running = readPid();
  if (running) {
    console.log(`already serving (pid ${running}); stop it with: npm run stop`);
    return 0;
  }
  if (!(await portFree())) {
    console.error(`port ${port} is in use by a process this script did not start; free it or set PORT`);
    return 1;
  }
  writeFileSync(PIDFILE, String(process.pid));
  const child = spawn('python3', ['-m', 'http.server', String(port)], { stdio: 'inherit' });
  const cleanup = () => {
    if (existsSync(PIDFILE) && readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) rmSync(PIDFILE);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => { child.kill('SIGTERM'); });
  }
  return new Promise((resolve) => {
    child.on('exit', (code) => { cleanup(); resolve(code ?? 0); });
    child.on('error', (err) => { cleanup(); console.error(err.message); resolve(1); });
  });
};

const stop = async () => {
  const pid = readPid();
  if (!pid) {
    rmSync(PIDFILE, { force: true });
    console.log('not running');
    return 0;
  }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 60 && alive(pid); i++) await sleep(50);
  if (alive(pid)) process.kill(pid, 'SIGKILL');
  rmSync(PIDFILE, { force: true });
  console.log(`stopped (pid ${pid})`);
  return 0;
};

process.exitCode = await (process.argv[2] === 'stop' ? stop() : serve());
