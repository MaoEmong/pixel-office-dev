/** CLI output only. Never match an ordinary user's sentence about login errors. */
export function authenticationFailed(output:string):boolean {
 const clean=output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r/g,'\n');
 // TUI output contains thousands of padded blank cells. Matching two \s* groups
 // across all those lines causes catastrophic backtracking and blocks the daemon.
 return clean.split('\n').some(raw=>{
  const line=raw.trim().replace(/^[●■]\s*/, '');
  if(!line)return false;
  return /^(?:Login expired\s*[·.:-]\s*Please run \/login|Not logged in\s*[·.:-]\s*Please run \/login|(?:Error:\s*)?(?:Your )?(?:authentication|refresh|access) token (?:has expired|expired|has been revoked|has already been used)|(?:Error:\s*)?Your access token could not be refreshed)/i.test(line)
   || /"(?:status|status_code)"\s*:\s*401\b[^\n]*"(?:message|error)"/i.test(line)
   || /^(?:Error:\s*)?(?:401 Unauthorized|Authentication failed)\b/i.test(line);
 });
}
