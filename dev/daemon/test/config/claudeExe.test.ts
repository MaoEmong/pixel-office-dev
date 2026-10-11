// T41: config.claudeExe 자동 탐지. 예전에는 데스크탑 앱 번들의 **버전 폴더를 박아** 뒀다
// (`%APPDATA%\Claude\claude-code\2.1.270\claude.exe`) — 앱이 업데이트되면 그 폴더가 사라지고
// `dept create` 가 `-32000 File not found: ...\2.1.270\claude.exe` 로 죽었다(실기).
// 가짜 파일 트리로 우선순위(env → PATH → 최신 버전 폴더 → 폴백)를 고정한다.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveClaudeExe, resolveClaudeExeDetailed } from '../../src/config.js';

describe('resolveClaudeExe (T41)', () => {
  let dir: string;
  let appData: string;
  let pathDir: string;
  let npmPrefix: string;
  /** `%APPDATA%\Claude\claude-code\<version>\claude.exe` 를 만든다. */
  const makeBundle = (version: string): string => {
    const exe = path.join(appData, 'Claude', 'claude-code', version, 'claude.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'MZ');
    return exe;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t41-claude-'));
    appData = path.join(dir, 'Roaming');
    pathDir = path.join(dir, 'bin');
    npmPrefix = path.join(dir, 'npm-prefix');
    fs.mkdirSync(pathDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** 유닉스 npm 전역 뿌리를 임시 폴더로 고정한다 — 안 그러면 **이 머신에 진짜 설치된 claude** 를 찾아
   *  테스트가 머신에 따라 달라진다(실제로 걸렸다). 윈도우 뿌리는 APPDATA 로 이미 고정돼 있다. */
  const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
    APPDATA: appData,
    PATH: pathDir,
    PIXEL_NPM_PREFIX: npmPrefix,
    ...over,
  });

  /** `<npmPrefix>/lib/node_modules/@anthropic-ai/claude-code/bin/<name>` 를 만든다(유닉스 모양). */
  const makeNpmUnix = (name: string, body = 'cafebabe'): string => {
    const exe = path.join(npmPrefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', name);
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, body);
    return exe;
  };

  test('PIXEL_CLAUDE_EXE 가 있으면 그대로 쓴다(존재 여부를 따지지 않는다)', () => {
    makeBundle('2.1.270');
    fs.writeFileSync(path.join(pathDir, 'claude.exe'), 'MZ');
    const r = resolveClaudeExeDetailed(env({ PIXEL_CLAUDE_EXE: 'D:\\my\\claude.exe' }), 'win32');
    assert.equal(r.exe, 'D:\\my\\claude.exe');
    assert.equal(r.found, true);
  });

  test('PATH 의 진짜 claude.exe 가 번들보다 먼저다 — .cmd/.ps1 셰임은 안 센다', () => {
    const bundle = makeBundle('2.1.270');
    fs.writeFileSync(path.join(pathDir, 'claude.cmd'), '@echo off');
    assert.equal(resolveClaudeExe(env(), 'win32'), bundle, '셰임만 있으면 번들로 간다');

    const real = path.join(pathDir, 'claude.exe');
    fs.writeFileSync(real, 'MZ');
    assert.equal(resolveClaudeExe(env(), 'win32'), real);
  });

  test('번들은 **가장 높은 버전** 폴더를 고른다(문자열 정렬이면 2.1.99 가 이긴다)', () => {
    makeBundle('2.1.266');
    makeBundle('2.1.270');
    makeBundle('2.1.99');
    const newest = makeBundle('2.1.301');
    assert.equal(resolveClaudeExe(env(), 'win32'), newest);

    // 가장 높은 버전 폴더에 exe 가 없으면 그다음 버전으로 내려간다(설치 중간 상태).
    fs.rmSync(newest);
    assert.equal(resolveClaudeExe(env(), 'win32'), path.join(appData, 'Claude', 'claude-code', '2.1.270', 'claude.exe'));
  });

  test('버전이 아닌 폴더는 무시한다', () => {
    const odd = path.join(appData, 'Claude', 'claude-code', 'current', 'claude.exe');
    fs.mkdirSync(path.dirname(odd), { recursive: true });
    fs.writeFileSync(odd, 'MZ');
    const real = makeBundle('2.1.270');
    assert.equal(resolveClaudeExe(env(), 'win32'), real);
  });

  test('npm 전역 설치의 bin/claude.exe 를 찾는다 — PATH 에는 .cmd 셰임뿐인 실제 설치 모양(2.1.278)', () => {
    const bundle = makeBundle('2.1.270');
    fs.writeFileSync(path.join(pathDir, 'claude.cmd'), '@echo off');
    const npmExe = path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    fs.mkdirSync(path.dirname(npmExe), { recursive: true });
    fs.writeFileSync(npmExe, 'MZ');
    const r = resolveClaudeExeDetailed(env(), 'win32');
    assert.equal(r.exe, npmExe, 'npm 전역이 번들보다 먼저다(사용자가 직접 설치한 쪽)');
    assert.equal(r.found, true);
    assert.ok(r.tried.at(-1)?.startsWith('npm 전역:'));
    fs.rmSync(npmExe);
    assert.equal(resolveClaudeExe(env(), 'win32'), bundle, 'npm 전역이 없으면 번들로 간다');
  });

  // 맥·리눅스: npm 패키지 **안**의 파일은 맥에서도 `claude.exe` 다(2.1.284 실측 — Mach-O arm64 네이티브인데
  // 이름만 .exe). PATH 로 보이는 확장자 없는 `claude` 는 `<prefix>/bin` 의 **심볼릭 링크**이지 패키지 안의
  // 파일이 아니다. 그래서 `claude` 만 찾으면 이 단계가 항상 빗나간다 — PATH 가 있을 때는 앞 단계에서 걸려
  // 안 드러나고, **Finder·Dock 으로 띄운 앱**(launchd 의 최소 PATH)에서만 "못 찾았습니다" 로 터졌다(실기).
  test('맥: npm 전역 패키지 안에 claude.exe 만 있어도 찾는다 — PATH 가 없을 때의 유일한 길', () => {
    const npmExe = makeNpmUnix('claude.exe');
    // Finder·Dock 으로 띄운 앱이 받는 환경: PATH 에 claude 가 없다(launchd 의 최소 PATH).
    const r = resolveClaudeExeDetailed(env({ PATH: '/usr/bin:/bin' }), 'darwin');
    assert.equal(r.found, true, r.tried.join(' | '));
    assert.equal(r.exe, npmExe);
  });

  test('맥: 확장자 없는 bin/claude 도 그대로 찾는다(옛 패키지 모양)', () => {
    const npmExe = makeNpmUnix('claude', '#!/usr/bin/env node\n');
    assert.equal(resolveClaudeExe(env({ PATH: '/usr/bin:/bin' }), 'darwin'), npmExe);
  });

  test('아무것도 못 찾으면 "claude" 폴백 + 찾아본 곳을 남긴다', () => {
    const r = resolveClaudeExeDetailed(env(), 'win32');
    assert.equal(r.exe, 'claude');
    assert.equal(r.found, false);
    assert.equal(r.tried.length, 4);
    assert.match(r.tried[0]!, /PIXEL_CLAUDE_EXE/);
    assert.match(r.tried[1]!, /PATH/);
    assert.match(r.tried[2]!, /claude-code/, '어느 폴더를 봤는지가 있어야 사용자가 고칠 수 있다');
  });

  test('win32 가 아니면 번들 폴더를 안 보고 PATH 의 claude 만 본다', () => {
    makeBundle('2.1.270');
    assert.equal(resolveClaudeExe(env(), 'linux'), 'claude');
    const real = path.join(pathDir, 'claude');
    fs.writeFileSync(real, '#!/bin/sh');
    assert.equal(resolveClaudeExe(env(), 'linux'), real);
  });
});
