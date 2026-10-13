import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Engine } from './types.js';

/** Session IDs are internal identifiers, never filesystem paths. */
function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid session identifier');
  return id;
}

export function projectDataDir(cwd: string): string {
  return path.join(path.resolve(cwd), '.pixel-office');
}

export function projectMemberDir(cwd: string, memberId: string): string {
  return path.join(projectDataDir(cwd), 'sessions', safeId(memberId));
}

/** Keep generated session state out of Git, including native CLI login state. */
export function assertProjectFolder(cwd: string): void {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error('프로젝트 폴더를 찾지 못했습니다. 이동한 폴더를 원래 위치로 돌리거나, 부서의 모든 멤버를 퇴근시킨 뒤 작업 폴더를 변경하세요: '+cwd);
  }
}

export function ensureProjectDataDir(cwd: string): void {
  assertProjectFolder(cwd);
  const root = projectDataDir(cwd);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const ignore = path.join(root, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
}

function copyIfMissing(source: string, target: string): void {
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o600);
}

/** Seed only login/preferences, not unrelated conversations or the entire CLI home. */
export function prepareProjectSession(
  cwd: string, memberId: string, engine: Engine, resumeSessionId?: string,
  homes: { claude: string; codex: string; claudeConfig: string } = {
    claude: path.join(os.homedir(), '.claude'),
    codex: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    claudeConfig: path.join(os.homedir(), '.claude.json'),
  },
): Record<string, string> {
  ensureProjectDataDir(cwd);
  const localHome = path.join(projectMemberDir(cwd, memberId), engine);
  fs.mkdirSync(localHome, { recursive: true, mode: 0o700 });
  if (engine === 'claude') {
    copyIfMissing(path.join(homes.claude, '.credentials.json'), path.join(localHome, '.credentials.json'));
    copyIfMissing(path.join(homes.claude, 'settings.json'), path.join(localHome, 'settings.json'));
    copyIfMissing(homes.claudeConfig, path.join(localHome, '.claude.json'));
    if (resumeSessionId) {
      const sid = safeId(resumeSessionId);
      const projects = path.join(homes.claude, 'projects');
      if (fs.existsSync(projects)) {
        for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const source = path.join(projects, entry.name, `${sid}.jsonl`);
          if (!fs.existsSync(source)) continue;
          const dest = path.join(localHome, 'projects', entry.name);
          copyIfMissing(source, path.join(dest, `${sid}.jsonl`));
          const subagents = path.join(projects, entry.name, sid);
          if (fs.existsSync(subagents)) fs.cpSync(subagents, path.join(dest, sid), { recursive: true, force: false, errorOnExist: false });
        }
      }
    }
    return { CLAUDE_CONFIG_DIR: localHome };
  }
  copyIfMissing(path.join(homes.codex, 'auth.json'), path.join(localHome, 'auth.json'));
  copyIfMissing(path.join(homes.codex, 'config.toml'), path.join(localHome, 'config.toml'));
  if (resumeSessionId) {
    const sid = safeId(resumeSessionId);
    for (const folder of ['sessions', 'archived_sessions']) {
      const root = path.join(homes.codex, folder);
      if (!fs.existsSync(root)) continue;
      for (const file of fs.readdirSync(root, { recursive: true, encoding: 'utf8' })) {
        if (path.basename(file).endsWith(`${sid}.jsonl`)) copyIfMissing(path.join(root, file), path.join(localHome, folder, file));
      }
    }
  }
  return { CODEX_HOME: localHome, CODEX_SQLITE_HOME: localHome };
}
