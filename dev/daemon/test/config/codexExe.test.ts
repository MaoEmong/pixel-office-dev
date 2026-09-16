// T22: config.codexExe 자동 탐지. node-pty 는 PATH 의 `codex.cmd`/`codex.ps1` 셰임을 못 띄우므로(T20 함정 4)
// npm 전역 설치 안의 **진짜 codex.exe** 를 찾아야 한다. 가짜 파일 트리로 우선순위를 고정한다.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexExe } from '../../src/config.js';

/** `<root>/node_modules/@openai/codex/node_modules/@openai/<pkg>/vendor/<target>/bin/codex.exe` 를 만든다. */
function makeVendor(root: string, pkg: string, target: string): string {
  const exe = path.join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', pkg, 'vendor', target, 'bin', 'codex.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'MZ');
  return exe;
}

describe('resolveCodexExe (T22)', () => {
  let dir: string;
  let appData: string;
  let pathDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t22-exe-'));
    appData = path.join(dir, 'Roaming');
    pathDir = path.join(dir, 'bin');
    fs.mkdirSync(pathDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
    APPDATA: appData,
    LOCALAPPDATA: path.join(dir, 'Local'),
    ProgramFiles: path.join(dir, 'ProgramFiles'),
    PATH: pathDir,
    ...over,
  });

  test('PIXEL_CODEX_EXE 가 있으면 그대로 쓴다(존재 여부를 따지지 않는다)', () => {
    assert.equal(resolveCodexExe(env({ PIXEL_CODEX_EXE: 'D:\\my\\codex.exe' }), 'win32'), 'D:\\my\\codex.exe');
  });

  test('%APPDATA%\\npm 의 vendor codex.exe 를 찾는다(플랫폼 패키지·타깃 폴더 이름은 스캔)', () => {
    const exe = makeVendor(path.join(appData, 'npm'), 'codex-win32-x64', 'x86_64-pc-windows-msvc');
    assert.equal(resolveCodexExe(env(), 'win32'), exe);
  });

  test('APPDATA 에 없으면 LOCALAPPDATA\\npm → ProgramFiles\\nodejs 순으로 본다', () => {
    const local = makeVendor(path.join(dir, 'Local', 'npm'), 'codex-win32-arm64', 'aarch64-pc-windows-msvc');
    assert.equal(resolveCodexExe(env(), 'win32'), local);
    fs.rmSync(path.join(dir, 'Local'), { recursive: true, force: true });
    const nodejs = makeVendor(path.join(dir, 'ProgramFiles', 'nodejs'), 'codex-win32-x64', 'x86_64-pc-windows-msvc');
    assert.equal(resolveCodexExe(env(), 'win32'), nodejs);
  });

  test('vendor 가 없으면 PATH 의 진짜 codex.exe — .cmd/.ps1 셰임만 있으면 무시하고 마지막 폴백 "codex"', () => {
    fs.writeFileSync(path.join(pathDir, 'codex.cmd'), '@echo off');
    fs.writeFileSync(path.join(pathDir, 'codex.ps1'), '#');
    assert.equal(resolveCodexExe(env(), 'win32'), 'codex', '셰임은 실행 파일로 치지 않는다');
    const real = path.join(pathDir, 'codex.exe');
    fs.writeFileSync(real, 'MZ');
    assert.equal(resolveCodexExe(env(), 'win32'), real);
  });

  test('이 기계의 실제 설치를 찾는다(있을 때만 — 없으면 skip)', (t) => {
    const vendor = path.join(
      process.env.APPDATA ?? '',
      'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64',
      'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe',
    );
    if (!process.env.APPDATA || !fs.existsSync(vendor)) return t.skip('npm 전역 @openai/codex 없음');
    const resolved = resolveCodexExe({ ...process.env, PIXEL_CODEX_EXE: undefined }, 'win32');
    assert.equal(resolved.toLowerCase(), vendor.toLowerCase());
  });
});
