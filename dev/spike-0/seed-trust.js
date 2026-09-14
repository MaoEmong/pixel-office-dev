// ~/.claude.json 에 폴더 신뢰 플래그를 미리 넣는다 (데몬이 멤버 출근 시 할 일의 실측)
const fs = require('fs');
const os = require('os');
const path = require('path');
const f = path.join(os.homedir(), '.claude.json');
const b = JSON.parse(fs.readFileSync(f, 'utf8'));
const key = path.join(__dirname, 'sandbox'); // 'D:\\myproject\\pixel-office\\dev\\spike-0\\sandbox'
delete b.projects['D:myprojectpixel-officedevspike-0sandbox']; // 이전 실수 정리
b.projects[key] = Object.assign(
  { allowedTools: [], mcpContextUris: [], enabledMcpjsonServers: [], disabledMcpjsonServers: [], hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false },
  b.projects[key] || {},
  { hasTrustDialogAccepted: true },
);
fs.writeFileSync(f, JSON.stringify(b, null, 2));
console.log('seeded trust for', key, 'onboarding:', b.hasCompletedOnboarding);
