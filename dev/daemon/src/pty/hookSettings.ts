// 세션 단위 hooks 설정 파일 생성기 (순수 함수 + 파일 쓰기 헬퍼).
//
// 실측 ②④: Claude 는 `--settings <json>` 으로 그 세션에만 hooks 주입(전역 settings 와 병합),
// Codex 는 `<cwd>/.codex/hooks.json` + `--dangerously-bypass-hook-trust`. 두 CLI 모두 같은
// 형식 `{ hooks: { <Event>: [ { hooks: [ { type:'command', command, timeout } ] } ] } }` 이다.
// hook 명령은 Windows 에서 git-bash 로 실행되므로 경로는 슬래시(D-03, curl 은 Codex 에서 실패 → node 스크립트).
import { config } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';

/** Codex hooks.json 에 우리가 쓴 파일임을 표시하는 마커(description 필드). */
export const PIXEL_OFFICE_MARKER = 'pixel-office';

/** 세션 hooks timeout(초). D-16: 600이면 10분 뒤 CLI가 hook을 끊고 TUI 프롬프트로 폴백 → 기본 86400(config.hookTimeoutSec). */
export const HOOK_TIMEOUT_SEC = config.hookTimeoutSec;

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionEnd',
] as const;

export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  'Interrupt',
  'SessionEnd',
] as const;

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

export interface HookCommandEntry {
  type: 'command';
  command: string;
  timeout: number;
}

export interface HookMatcherGroup {
  hooks: HookCommandEntry[];
}

export type HooksMap = Record<string, HookMatcherGroup[]>;

/** Claude 세션 설정의 statusLine 항목(T43). Codex 에는 statusLine 이 없다 — 주입하지 않는다. */
export interface StatusLineSetting {
  type: 'command';
  command: string;
  padding: number;
}

export interface ClaudeSessionSettings {
  hooks: HooksMap;
  /** `statusLineScriptPath` 를 준 세션에만 붙는다. */
  statusLine?: StatusLineSetting;
}

export interface CodexHooksFile {
  description: string;
  hooks: HooksMap;
}

/** Windows 경로의 백슬래시를 슬래시로. git-bash 에서 `C:\...` 는 백슬래시가 먹혀 실패한다(실측 ②). */
export function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * hook 명령 한 줄: `node <슬래시경로> <port> <Event>`.
 * 경로에 공백이 있으면 bash 가 단어를 쪼개므로 그때만 큰따옴표로 감싼다.
 */
export function buildHookCommand(hookScriptPath: string, hookPort: number, event: string): string {
  const script = toForwardSlashes(hookScriptPath);
  const quoted = /\s/.test(script) ? `"${script}"` : script;
  return `node ${quoted} ${hookPort} ${event}`;
}

export function buildHooksMap(events: readonly string[], hookScriptPath: string, hookPort: number): HooksMap {
  const hooks: HooksMap = {};
  for (const event of events) {
    hooks[event] = [
      { hooks: [{ type: 'command', command: buildHookCommand(hookScriptPath, hookPort, event), timeout: HOOK_TIMEOUT_SEC }] },
    ];
  }
  return hooks;
}

/**
 * statusLine 명령 한 줄: `node <슬래시경로>/statusline.js <port>`(T43). hook 명령과 규칙이 같다
 * (공백 있는 경로만 큰따옴표). 이벤트 인자는 없다 — 경로가 곧 종류다.
 */
export function buildStatusLineCommand(statusLineScriptPath: string, hookPort: number): string {
  const script = toForwardSlashes(statusLineScriptPath);
  const quoted = /\s/.test(script) ? `"${script}"` : script;
  return `node ${quoted} ${hookPort}`;
}

/**
 * `claude --settings` 에 넘길 세션 설정 객체.
 * `statusLineScriptPath` 를 주면 `statusLine` 도 같이 넣는다 — 실측(T43-0 Q2)에서 hooks 와 충돌 없이 함께 동작했다.
 * **사용자 전역 statusLine 은 이 세션에서만 덮인다**(데몬이 띄운 세션이라 수용, D-45 한계 절).
 */
export function buildClaudeSessionSettings(
  hookScriptPath: string,
  hookPort: number,
  statusLineScriptPath?: string,
): ClaudeSessionSettings {
  const settings: ClaudeSessionSettings = { hooks: buildHooksMap(CLAUDE_HOOK_EVENTS, hookScriptPath, hookPort) };
  if (statusLineScriptPath) settings.statusLine = { type: 'command', command: buildStatusLineCommand(statusLineScriptPath, hookPort), padding: 0 };
  return settings;
}

/** `<cwd>/.codex/hooks.json` 내용. description 마커로 우리 파일임을 표시. */
export function buildCodexHooksFile(hookScriptPath: string, hookPort: number): CodexHooksFile {
  return { description: PIXEL_OFFICE_MARKER, hooks: buildHooksMap(CODEX_HOOK_EVENTS, hookScriptPath, hookPort) };
}

/**
 * 기존 hooks.json 이 우리가 쓴 것인지. description 이 "pixel-office" 로 시작하면 우리 것
 * (스파이크가 남긴 "pixel-office spike" 도 덮어써도 되는 파일로 본다). JSON 이 아니면 남의 것.
 */
export function isPixelOfficeHooksFile(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return false;
    const desc = (parsed as { description?: unknown }).description;
    return typeof desc === 'string' && desc.startsWith(PIXEL_OFFICE_MARKER);
  } catch {
    return false;
  }
}

/** 멤버별 Claude 세션 설정 파일 경로: `<dataDir>/sessions/<memberId>/claude-settings.json`. */
export function claudeSettingsPath(dataDir: string, memberId: string): string {
  return path.join(dataDir, 'sessions', memberId, 'claude-settings.json');
}

/** Codex 프로젝트 hooks 파일 경로: `<cwd>/.codex/hooks.json`. */
export function codexHooksPath(cwd: string): string {
  return path.join(cwd, '.codex', 'hooks.json');
}

/** Claude 세션 설정 파일을 쓰고 경로를 돌려준다. 폴더는 만들어 준다. 항상 덮어쓴다. */
export function writeClaudeSessionSettings(
  dataDir: string,
  memberId: string,
  hookScriptPath: string,
  hookPort: number,
  statusLineScriptPath?: string,
): string {
  const file = claudeSettingsPath(dataDir, memberId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(buildClaudeSessionSettings(hookScriptPath, hookPort, statusLineScriptPath), null, 2));
  return file;
}

export interface EnsureCodexHooksResult {
  path: string;
  /** false 면 남의 파일이 있어 건드리지 않았다는 뜻. */
  written: boolean;
  reason?: string;
}

/**
 * `<cwd>/.codex/hooks.json` 을 쓴다. 이미 있는데 우리 마커가 없으면 덮어쓰지 않고 written:false.
 * 같은 cwd 를 쓰는 팀원들은 파일을 공유한다 — 멤버 식별은 PIXEL_MEMBER env 로 하므로 내용이 같다.
 */
export function ensureCodexHooksFile(cwd: string, hookScriptPath: string, hookPort: number): EnsureCodexHooksResult {
  const file = codexHooksPath(cwd);
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8');
    if (!isPixelOfficeHooksFile(existing)) {
      return { path: file, written: false, reason: `${file} exists and was not written by pixel-office (no "description": "${PIXEL_OFFICE_MARKER}" marker); left untouched` };
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(buildCodexHooksFile(hookScriptPath, hookPort), null, 2));
  return { path: file, written: true };
}
