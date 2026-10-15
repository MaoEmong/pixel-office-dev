/** CLI output only. Never match an ordinary user's sentence about login errors. */
export function authenticationFailed(output:string):boolean {
 const clean=output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r/g,'\n');
 return /(?:^|\n)\s*[●■]?\s*(?:Login expired\s*[·.:-]\s*Please run \/login|Not logged in\s*[·.:-]\s*Please run \/login|(?:Error:\s*)?(?:Your )?(?:authentication|refresh|access) token (?:has expired|expired|has been revoked|has already been used)|(?:Error:\s*)?Your access token could not be refreshed)/im.test(clean)
  || /"(?:status|status_code)"\s*:\s*401\b[^\n]*"(?:message|error)"/i.test(clean)
  || /(?:^|\n)\s*(?:Error:\s*)?(?:401 Unauthorized|Authentication failed)\b/i.test(clean);
}
