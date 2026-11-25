/**
 * Checks of the TikTok accounts store and the pasted-cookie reader (tiktokAccounts.ts), offline:
 * a temporary folder stands in for the server's, with a pretend main profile that nothing here may touch.
 *
 * Alone: `npx tsx src/tests/tiktokAccounts.ts` from server/.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { accountProfileDir, accountRecords, activeAccountId, activeProfileDir, configureTikTokAccounts, createAccount, forgetAccountIdentity, MAIN_ACCOUNT, parseTikTokCookies, rememberAccount, removeAccount, setActiveAccount, TikTokAccountError, toBrowserCookies, unlinkHosts } from '../tiktokAccounts';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const refused = (fn: () => unknown): TikTokAccountError | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof TikTokAccountError ? e : undefined;
  }
  return undefined;
};

export async function tiktokAccountsChecks(check: Check): Promise<void> {
  console.log('\n== 2h. TikTok accounts: the store, the main account left alone, pasted cookies (offline)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamanywhere-accounts-'));
  const main = path.join(dir, 'tiktok-profile');
  fs.mkdirSync(path.join(main, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(main, 'Default', 'Cookies'), 'the main account');
  configureTikTokAccounts(main);
  try {
    check('a server without an index has one account, the main one, in the folder it always had', activeAccountId() === MAIN_ACCOUNT && accountRecords().length === 1 && activeProfileDir() === main && !fs.existsSync(path.join(dir, 'tiktok-accounts.json')));

    const spare = createAccount('  Spare  ');
    check('a new account gets an id and a folder of its own, and is not active yet', /^[a-z0-9]{8}$/.test(spare.id) && spare.label === 'Spare' && activeAccountId() === MAIN_ACCOUNT && accountProfileDir(spare.id) === path.join(dir, 'tiktok-accounts', spare.id, 'profile'), spare);

    setActiveAccount(spare.id);
    fs.mkdirSync(path.join(activeProfileDir(), 'Default'), { recursive: true });
    rememberAccount(spare.id, { username: 'spare.acct', via: 'cookies' });
    configureTikTokAccounts(main); // as after a restart: read back from the index
    check('the active account and who it is survive a restart', activeAccountId() === spare.id && activeProfileDir() === accountProfileDir(spare.id) && accountRecords().find((a) => a.id === spare.id)?.username === 'spare.acct' && accountRecords().find((a) => a.id === spare.id)?.via === 'cookies');

    check('the active account cannot be removed (switch away first)', refused(() => removeAccount(spare.id))?.status === 409 && fs.existsSync(accountProfileDir(spare.id)));
    check('the main account cannot be removed at all', refused(() => removeAccount(MAIN_ACCOUNT))?.status === 409);
    check('an id that is not an account (or tries to leave the folder) is refused', refused(() => removeAccount('../tiktok-profile')) !== undefined && refused(() => accountProfileDir('..')) !== undefined && refused(() => setActiveAccount('nobody00'))?.status === 404);

    setActiveAccount(MAIN_ACCOUNT);
    removeAccount(spare.id);
    check('removing another account deletes its folder and nothing of the main one', !fs.existsSync(path.join(dir, 'tiktok-accounts', spare.id)) && fs.readFileSync(path.join(main, 'Default', 'Cookies'), 'utf8') === 'the main account' && accountRecords().length === 1 && activeProfileDir() === main);

    rememberAccount(MAIN_ACCOUNT, { username: 'the.real.one', via: 'browser' });
    forgetAccountIdentity(MAIN_ACCOUNT);
    check('signing the main account out forgets who it was, and keeps the account', accountRecords()[0].id === MAIN_ACCOUNT && accountRecords()[0].username === undefined);

    for (let i = 0; i < 7; i++) createAccount();
    check('eight accounts are the limit', accountRecords().length === 8 && refused(() => createAccount())?.status === 409);
  } finally {
    configureTikTokAccounts(process.env.TIKTOK_PROFILE_DIR || path.join(os.homedir(), '.streamanywhere', 'tiktok-profile'));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const future = Math.floor(Date.now() / 1000) + 86400 * 90;
  const line = (domain: string, name: string, value: string, exp = future, secure = 'TRUE'): string => [domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', '/', secure, String(exp), name, value].join('\t');
  const txt = ['# Netscape HTTP Cookie File', '', line('.tiktok.com', 'sessionid', 'abc123def456'), line('.tiktok.com', 'sid_guard', 'abc123def456%7C1'), line('.[www.tiktok.com](https://www.tiktok.com)', 'tiktok_webapp_theme', 'light'), line('[www.tiktok.com](https://www.tiktok.com)', 'msToken', 'tok=='), line('.tiktok.com', 'tt_csrf_token', 'csrf', 0), line('[www.tiktok.com](https://www.tiktok.com)', 'tt_ticket_guard_has_set_public_key', '1'), line('.[www.tiktok.com](https://www.tiktok.com)', 'perf_feed_cache', '{%22a%22:1}'), line('.example.com', 'other', 'x'), line('.tiktok.com', 'sessionid', 'newer-session-value')].join('\n');
  check('host names that a chat turned into links are read as host names', unlinkHosts('.[www.tiktok.com](https://www.tiktok.com)\tTRUE') === '.www.tiktok.com\tTRUE' && unlinkHosts('[www.tiktok.com](https://www.tiktok.com)') === 'www.tiktok.com' && unlinkHosts('value [not a host](x) stays') === 'value [not a host](x) stays');
  const parsed = parseTikTokCookies(txt);
  const by = (n: string) => parsed.cookies.filter((c) => c.name === n);
  check('a pasted cookies.txt: tiktok.com only, the later line wins, browser-only cookies left out', parsed.cookies.length === 5 && by('sessionid').length === 1 && by('sessionid')[0].value === 'newer-session-value' && by('tiktok_webapp_theme')[0].domain === '.www.tiktok.com' && by('msToken')[0].domain === 'www.tiktok.com' && !by('tt_ticket_guard_has_set_public_key').length && !by('perf_feed_cache').length && !by('other').length && /1 cookie of other sites ignored/.test(parsed.warnings.join(' ')), { n: parsed.cookies.length, names: parsed.cookies.map((c) => c.name), warnings: parsed.warnings });
  const forBrowser = toBrowserCookies(parsed.cookies);
  check('for the browser: a cookie with an expiry keeps it, one without stays a session cookie', forBrowser.find((c) => c.name === 'sessionid')?.expires === future && !('expires' in forBrowser.find((c) => c.name === 'tt_csrf_token')!) && forBrowser.every((c) => c.path === '/'));
  check('a Cookie: header and a JSON export work too', parseTikTokCookies('Cookie: sessionid=abc; ttwid=1%7Cx').cookies.length === 2 && parseTikTokCookies(JSON.stringify([{ name: 'sessionid', value: 'abc', domain: '.tiktok.com', expirationDate: future + 0.5 }, { name: 'x', value: 'y', domain: '.other.com' }])).cookies.length === 1);
  check('cookies without a sign-in, an expired sign-in and empty text are refused with the reason', /no "sessionid"/.test(refused(() => parseTikTokCookies(line('.tiktok.com', 'ttwid', 'x')))?.message || '') && /run out/.test(refused(() => parseTikTokCookies(line('.tiktok.com', 'sessionid', 'old', 1700000000)))?.message || '') && /Paste the cookies first/.test(refused(() => parseTikTokCookies('  '))?.message || '') && /No cookies found/.test(refused(() => parseTikTokCookies('hello there'))?.message || ''));
}

if (require.main === module) {
  let failures = 0;
  const check: Check = (name, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`);
    if (!cond) failures++;
  };
  tiktokAccountsChecks(check)
    .then(() => {
      console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
      process.exit(failures ? 1 : 0);
    })
    .catch((e) => {
      console.error('crashed:', e);
      process.exit(1);
    });
}
