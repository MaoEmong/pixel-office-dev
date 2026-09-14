// 테스트 공통: 스파이크 로그에서 복사한 화면 텍스트(fixtures/*.txt)를 ScreenModel 에 넣는다.
// 픽스처는 ANSI 가 아닌 평문이라 줄을 "\r\n" 으로 이어 붙여 넣으면 같은 화면이 된다.
import fs from 'node:fs';
import { ScreenModel } from '../../src/screen/ScreenModel.js';
import type { Engine } from '../../src/screen/ScreenModel.js';

export function loadFixture(name: string): string[] {
  const raw = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface FixtureOpts {
  cols?: number;
  /** 기본: max(40, 픽스처 줄 수). 스파이크 화면은 120x40 이지만 온보딩 화면 로그는 46줄이라 잘리지 않게 키운다. */
  rows?: number;
}

export async function screenFrom(engine: Engine, fixture: string, opts: FixtureOpts = {}): Promise<ScreenModel> {
  const lines = loadFixture(fixture);
  const sm = new ScreenModel({ engine, cols: opts.cols ?? 120, rows: opts.rows ?? Math.max(40, lines.length) });
  await sm.feed(lines.join('\r\n'));
  return sm;
}
