// `ClaudeTranscriptUsage` 의 얇은 겉껍질 — **새로 덧붙은 부분만** 파일에서 읽어 누적기에 먹인다(T43-5).
//
// transcript 는 한 세션에서 수 MB 까지 자란다. 턴이 끝날 때마다 전체를 다시 읽으면 데몬이 초당 몇 MB 를 파싱하게
// 되므로 **멤버마다 바이트 오프셋을 들고** 그 뒤만 읽는다. 규칙은 `tail.ts` 와 같다 — 비동기 · 상한 있음 ·
// **실패해도 던지지 않는다**(못 읽으면 `null`, 호출자는 이전 값을 그대로 둔다).
import fs from 'node:fs/promises';
import path from 'node:path';
import { advanceClaudeTranscript, emptyClaudeTranscriptState, type ClaudeTranscriptState } from './ClaudeTranscriptUsage.js';

/**
 * 한 번에 읽을 최대 바이트. 데몬을 재시작하면 오프셋이 없어 **0 부터 한 번 다시 훑는데**, 그때 20MB 를 넘는
 * 파일이면 **뒤 20MB 만** 읽고 `partial:true` 로 표시한다(합계가 모자란다는 내부 표식 — 와이어 모양은 그대로).
 */
export const MAX_SCAN_BYTES = 20 * 1024 * 1024;

/**
 * 한 멤버에게서 **동시에 따라갈** 서브에이전트 transcript 파일 수 상한(T45).
 *
 * 파일 하나당 `seenIds`(최대 2000개) + `counted` 를 들고 있으므로 무제한이면 메모리가 샌다.
 * 넘치면 **오래된 것부터** 놓아 주고 그때까지의 합계만 남긴다(`UsageTracker` 가 한다) —
 * 끝난 서브에이전트 파일은 더 자라지 않으므로 놓아 줘도 값이 모자라지 않는다.
 */
export const MAX_SUBAGENT_FILES = 50;

const LF = 0x0a;

/**
 * 본 transcript 경로 → 그 세션의 서브에이전트 폴더(T45).
 *
 * CLI 2.1.275 는 `…/<projectDir>/<sessionId>.jsonl` 옆에 `…/<projectDir>/<sessionId>/subagents/agent-*.jsonl`
 * 을 쓴다(실측). `.jsonl` 로 끝나지 않는 경로면 `null`.
 */
export function claudeSubagentsDir(transcriptPath: string): string | null {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return null;
  const base = path.basename(transcriptPath);
  if (!base.toLowerCase().endsWith('.jsonl')) return null;
  return path.join(path.dirname(transcriptPath), base.slice(0, -'.jsonl'.length), 'subagents');
}

/**
 * 그 세션의 서브에이전트 transcript 를 **새것부터** `cap` 개까지. 폴더가 없으면 빈 배열(정상 —
 * Task 도구를 한 번도 안 쓴 세션).
 *
 * `agent-*.meta.json` 은 usage 를 들고 있지 않으므로 거른다. 실패해도 던지지 않는다.
 */
export async function listClaudeSubagentFiles(transcriptPath: string, cap: number = MAX_SUBAGENT_FILES): Promise<string[]> {
  const dir = claudeSubagentsDir(transcriptPath);
  if (!dir || !(cap > 0)) return [];
  try {
    const names = await fs.readdir(dir);
    const stamped = await Promise.all(
      names
        .filter((n) => /^agent-.+\.jsonl$/i.test(n))
        .map(async (n) => {
          const full = path.join(dir, n);
          try {
            const st = await fs.stat(full);
            return st.isFile() ? { full, mtime: st.mtimeMs } : null;
          } catch {
            return null;
          }
        }),
    );
    return stamped
      .filter((x): x is { full: string; mtime: number } => x !== null)
      // 같은 ms 에 쓰인 파일이 순서를 뒤집지 않게 경로로 한 번 더 가른다(상한에서 누가 잘릴지 안정적이어야 한다).
      .sort((a, b) => b.mtime - a.mtime || (a.full < b.full ? -1 : a.full > b.full ? 1 : 0))
      .slice(0, cap)
      .map((x) => x.full);
  } catch {
    return []; // 폴더 없음 · 권한 — 서브에이전트가 없는 것으로 친다
  }
}

/**
 * 이어서 읽을 상태를 고른다. **경로가 바뀌었거나**(= `--resume` 이 새 transcript 를 팠다) **파일이 줄었으면**
 * (= 잘렸거나 회전했다) 처음부터 다시 센다.
 *
 * 경로가 바뀌면 왜 리셋인가: CLI 자신의 `/cost` 도 새 파일에서 0 부터 다시 센다(실측 —
 * `docs/worklog/T43-5-ClaudeTokens.md`). 우리가 파일을 넘어 더해 버리면 앱 숫자가 CLI 화면과 어긋난다.
 */
function baseState(prev: ClaudeTranscriptState | undefined, file: string, size: number): ClaudeTranscriptState {
  if (!prev || prev.path !== file || size < prev.offset) return emptyClaudeTranscriptState(file);
  return prev;
}

/**
 * `file` 에서 `prev.offset` 뒤로 덧붙은 부분을 읽어 새 상태를 돌려준다.
 * 읽지 못하면 `null` — 호출자는 **이전 상태·이전 값을 그대로 유지**한다.
 */
export async function readClaudeTranscriptUsage(
  file: string,
  prev?: ClaudeTranscriptState,
  maxScanBytes: number = MAX_SCAN_BYTES,
): Promise<ClaudeTranscriptState | null> {
  if (typeof file !== 'string' || file === '') return null;
  const cap = Math.max(1, maxScanBytes);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    // Windows 는 폴더도 열린다(크기 0) — 파일이 아니면 "못 읽었다" 로 친다.
    if (!stat.isFile()) return null;
    const size = stat.size;
    const state = baseState(prev, file, size);
    if (size <= state.offset) return state; // 새로 붙은 것이 없다(빈 파일 포함)

    // 재기동 뒤 첫 훑기가 너무 크면 뒤쪽만 본다. 이어 읽기(offset>0)일 때는 건너뛰지 않는다 — 한 판에 cap 만큼만
    // 읽고 나머지는 다음 턴 종료 때 이어 읽으면 된다(오프셋이 그만큼 올라간다).
    let start = state.offset;
    let jumped = false;
    if (start === 0 && size > cap) {
      start = size - cap;
      jumped = true;
    }
    const length = Math.min(size - start, cap);
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    let slice = buf.subarray(0, bytesRead);

    // 뛰어넘어 시작했으면 첫 줄은 반쪽이다 — 버린다(잘린 JSON 을 파서에 흘리지 않는다).
    let skipped = 0;
    if (jumped) {
      const nl = slice.indexOf(LF);
      if (nl < 0) return { ...state, offset: start + bytesRead, partial: true };
      skipped = nl + 1;
      slice = slice.subarray(skipped);
    }

    const lastNl = slice.lastIndexOf(LF);
    if (lastNl < 0) {
      // 완성된 줄이 하나도 없다. 상한까지 읽고도 줄바꿈이 없으면(한 줄이 20MB 넘는다) 그 구간은 포기한다 —
      // 그러지 않으면 같은 자리를 영원히 다시 읽는다. 아니면 다음 턴 종료에 줄이 완성된 뒤 다시 본다.
      if (bytesRead >= cap) return { ...state, offset: start + bytesRead, partial: true };
      return state;
    }

    const text = slice.subarray(0, lastNl + 1).toString('utf8');
    const consumed = skipped + lastNl + 1;
    const from: ClaudeTranscriptState = jumped ? { ...state, offset: start, partialLine: '' } : state;
    const next = advanceClaudeTranscript(from, text, consumed);
    return jumped ? { ...next, partial: true } : next;
  } catch {
    return null; // 파일 없음 · 권한 · 잠김 — 이전 값을 유지한다
  } finally {
    await handle?.close().catch(() => {});
  }
}
