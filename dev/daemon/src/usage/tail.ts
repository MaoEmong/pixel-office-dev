// 기록 파일(transcript · rollout)의 **꼬리만** 읽는다(T43, D-45).
//
// 왜 꼬리인가: 한 세션의 transcript/rollout 은 수 MB 까지 자란다. 우리가 쓰는 줄은 **마지막 `cost-state`**
// 하나이거나 **마지막 `token_count`** 하나뿐이라 전체를 읽을 이유가 없다(설계 문서: "rollout 은 파일 끝에서
// 64KB 만 읽는다").
//
// 규칙 셋:
//   1. **비동기**다 — 데몬 이벤트 루프를 막으면 그 사이 hook 응답이 늦어진다.
//   2. **경계가 있다** — 최대 64KB. 파일이 더 크면 앞쪽 첫 줄은 잘려 있으므로 **버린다**(잘린 JSON 을 파서에
//      흘리면 안 되고, 깨진 UTF-8 선두 바이트도 그 줄과 함께 사라진다).
//   3. **실패해도 던지지 않는다** — 파일이 없거나(아직 안 만들어짐) 잠겨 있으면 `''` 를 돌려주고, 호출자는
//      **이전 값을 그대로 유지**한다(값을 지우지 않는다).
import fs from 'node:fs/promises';

/** 꼬리에서 읽을 최대 바이트. 설계 문서의 64KB. */
export const TAIL_BYTES = 64 * 1024;

/**
 * `file` 의 마지막 `maxBytes` 바이트를 UTF-8 로 읽는다. 파일이 그보다 크면 **첫 줄(잘린 줄)을 버린다**.
 * 읽지 못하면 `''`.
 */
export async function readTail(file: string, maxBytes: number = TAIL_BYTES): Promise<string> {
  if (typeof file !== 'string' || file === '') return '';
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    if (size <= 0) return '';
    const length = Math.min(size, Math.max(1, maxBytes));
    const start = size - length;
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    if (start === 0) return text;
    // 앞이 잘렸다: 첫 줄바꿈 전까지는 반쪽 줄이다.
    const nl = text.indexOf('\n');
    return nl < 0 ? '' : text.slice(nl + 1);
  } catch {
    return ''; // 파일 없음 · 권한 · 잠김 — 이전 값을 유지한다
  } finally {
    await handle?.close().catch(() => {});
  }
}
