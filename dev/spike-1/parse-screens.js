// 캡처한 화면 텍스트에서 사용량을 뽑는 정규식 제안 + 실제 캡처로 검증.
// 사용: node parse-screens.js
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'out');
const read = (f) => { try { return fs.readFileSync(path.join(OUT, f), 'utf8'); } catch { return null; } };

// ---------- Claude /usage(= /cost 와 동일 화면, Usage 탭) ----------
// 블록 3개: "Current session" / "Current week (all models)" / "Current week (<모델명>)"
// 각 블록은 [막대] NN% used 다음 줄에 "Resets <시각 표현> (<TZ>)"
const CLAUDE_BLOCK = /^\s*(Current session|Current week \(([^)]+)\))\s*$\n^\s*\S*\s*(\d+)% used\s*$\n^\s*Resets ([^\n]+?)\s*$/gm;

function parseClaudeUsage(text) {
  const out = { session5h: null, weeklyAll: null, weeklyModel: null };
  let m;
  CLAUDE_BLOCK.lastIndex = 0;
  while ((m = CLAUDE_BLOCK.exec(text))) {
    const [, label, paren, pct, resets] = m;
    const tz = /\(([A-Za-z_]+\/[A-Za-z_]+)\)\s*$/.exec(resets);
    const rec = { usedPercent: Number(pct), resetsText: resets.replace(/\s*\([^)]*\)\s*$/, ''), tz: tz ? tz[1] : null };
    if (label === 'Current session') out.session5h = rec;
    else if (paren === 'all models') out.weeklyAll = rec;
    else out.weeklyModel = Object.assign({ model: paren }, rec);
  }
  return out;
}

// 세션 비용/모델별 토큰(같은 화면 위쪽)
const CLAUDE_COST = /^\s*Total cost:\s+\$([\d.]+)/m;
const CLAUDE_MODEL_ROW = /^\s*([a-z0-9.\-]+(?:\[[^\]]+\])?):\s+([\d.]+k?) input, ([\d.]+k?) output, ([\d.]+k?) cache read, ([\d.]+k?) cache write \(\$([\d.]+)\)/gim;

// ---------- Claude /context ----------
// 주의: 이 줄 앞에는 컨텍스트 보드 글리프(⛶ ⛁ …)가 같은 줄에 붙어 있어 행머리 앵커를 쓰면 안 된다.
const CLAUDE_CONTEXT = /([\d.]+k?)\/(\d+[km]?) tokens \((\d+)%\)/i;

// ---------- Codex /status ----------
const CODEX_ACCOUNT = /^\s*│?\s*Account:\s+(\S+)\s+\(([^)]+)\)/m;
const CODEX_CTX = /Context window:\s+(\d+)% left \(([\d.]+[KM]?) used \/ ([\d.]+[KM]?)\)/;
const CODEX_WEEK = /Weekly limit:\s+\[[^\]]*\]\s+(\d+)% left \(resets ([^)]+)\)/;
const CODEX_5H = /5h limit:\s+\[[^\]]*\]\s+(\d+)% left \(resets ([^)]+)\)/; // 플랜에 따라 나올 수 있음(미확인)

function parseCodexStatus(text) {
  const acc = CODEX_ACCOUNT.exec(text);
  const ctx = CODEX_CTX.exec(text);
  const wk = CODEX_WEEK.exec(text);
  const h5 = CODEX_5H.exec(text);
  return {
    account: acc ? { email: acc[1], plan: acc[2] } : null,
    context: ctx ? { leftPercent: Number(ctx[1]), used: ctx[2], window: ctx[3] } : null,
    weekly: wk ? { leftPercent: Number(wk[1]), usedPercent: 100 - Number(wk[1]), resetsText: wk[2] } : null,
    session5h: h5 ? { leftPercent: Number(h5[1]), resetsText: h5[2] } : null,
  };
}

const results = {};
for (const f of ['claude-screen-05-usage.txt', 'claude-screen-03-cost.txt', 'claude-full-usage-fresh.txt']) {
  const t = read(f);
  if (!t) continue;
  const cost = CLAUDE_COST.exec(t);
  const rows = [];
  CLAUDE_MODEL_ROW.lastIndex = 0;
  let r; while ((r = CLAUDE_MODEL_ROW.exec(t))) rows.push({ model: r[1], input: r[2], output: r[3], cacheRead: r[4], cacheWrite: r[5], usd: Number(r[6]) });
  results[f] = { limits: parseClaudeUsage(t), totalCostUSD: cost ? Number(cost[1]) : null, modelRows: rows };
}
{
  const t = read('claude-screen-02-context.txt');
  if (t) { const m = CLAUDE_CONTEXT.exec(t); results['claude-screen-02-context.txt'] = { context: m ? { used: m[1], window: m[2], percent: Number(m[3]) } : null }; }
}
for (const f of ['codex-full-03-status-after-turn.txt', 'codex-full-05-status-fresh.txt']) {
  const t = read(f);
  if (t) results[f] = parseCodexStatus(t);
}
console.log(JSON.stringify(results, null, 2));
