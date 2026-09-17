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
    fs.mkdirSync(pathDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
    APPDATA: appData,
    PATH: pathDir,
    ...over,
  });

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

  test('아무것도 못 찾으면 "claude" 폴백 + 찾아본 곳을 남긴다', () => {
    const r = resolveClaudeExeDetailed(env(), 'win32');
    assert.equal(r.exe, 'claude');
    assert.equal(r.found, false);
    assert.equal(r.tried.length, 3);
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
