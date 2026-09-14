// 실측: claude --resume <id> 로 재개 → SessionStart(source=resume) + additionalContext 재주입 + 이전 맥락 유지?
process.env.CLAUDE_ARGS_EXTRA = JSON.stringify(['--resume', process.argv[3]]);
process.argv = [process.argv[0], process.argv[1], process.argv[2]];
require('./pty-claude.js');
