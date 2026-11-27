// IRIS Doctor — 치료 가드(도구 실행 직전 훅). Doctor 가 띄운 에이전트(클로드 · 코덱스)가 도구를 쓰기 직전에 불려, 정해 둔 "하지 않는 일"이면 거절한다.
//
// 정직한 한계: 이 가드는 **알려진 무늬**를 막는다. 에이전트는 Doctor 와 같은 윈도우 사용자로 돌고 명령 글은 얼마든지 돌려 쓸 수 있으므로
// "절대 못 한다"를 보장하지 않는다. 뒤를 받치는 것은 치료 전 기준 사본 · 다시 검진 · 자동 되돌리기 · 자기 파일 지킴이다(비밀의 바깥 전송은 되돌릴 수 없다 — 그래서 열쇠 쪽 무늬를 가장 넓게 잡는다).
//
// 이 파일은 혼자서 돈다(다른 파일을 불러오지 않는다): 치료 때마다 Doctor 가 메모리의 사본에서 이 파일을 실행 폴더에 새로 써 넣고, 같은 폴더의 policy.json 을 읽는다.
//   입력(표준 입력, JSON): { tool_name, tool_input: { command | file_path | path | … } }
//   거절: 표준 출력에 { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason } } 한 줄
//   통과: 아무것도 내지 않는다
// 가드 자신이 고장 나면(입력을 못 읽음 등): 읽기 도구는 통과, 그 밖은 거절(모르는 것을 실행하게 두지 않는다).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const norm = (s) => String(s ?? '').toLowerCase().replace(/\\+/g, '/').replace(/(^|[\s"'=(,;|&<>])\/([a-z])\//g, '$1$2:/'); // 역슬래시 → 슬래시, /c/… → c:/…
const READ_TOOLS = /^(read|grep|glob|ls|list|search|view|notebookread|webfetch|websearch|todowrite|task|agent)$/i;
const WRITE_TOOLS = /^(write|edit|multiedit|notebookedit|apply_patch|create|str_replace_editor)$/i;

const FROZEN = '바꾸기 전 사본을 뜨지 못한 파일이라 이번 치료에서는 건드리지 않습니다(되돌릴 수 없는 변경을 만들지 않습니다 — 꼭 바꿔야 하면 사람이 할 일로 적어 주세요)';
// ── 명령 글의 무늬(위에서부터 본다). [이름, 정규식, 사용자에게 · 에이전트에게 보일 까닭]
const RULES = [
  // 1. 열쇠: 읽기 · 찍기 · 보내기 · 고치기 — 공식 프로그램이 스스로 쓰는 것 말고는 건드리지 않는다
  ['secret-file', /(\.credentials\.json|iris-cli-token\.json|teamclaude\.json|(^|[/\s"'=])auth\.json|[/\\]secrets[/\\]|doctor[/\\]+cards|(^|[/\s"'=])\.env(\.[a-z0-9_-]+)?(\s|["')]|$))/, '열쇠가 든 파일을 직접 읽거나 고치지 않습니다(로그인은 공식 프로그램의 로그인 명령으로만)'],
  // 환경 변수: 열쇠 이름 · 환경 전체를 한꺼번에 찍기(셸 · node · 파이썬 · 닷넷). 이름 하나를 읽는 것(process.env.PATH · $env:TEMP)은 된다.
  ['secret-env', /(oauth_token|(^|[\s;|&(])(printenv|env)(\s*$|\s*[|;&])|(get-childitem|gci|dir|ls|get-item)\s+(-(literal)?path\s+)?["']?env:(\\|\/)?\*?["']?(\s|$|[|;&])|(^|[\s;|&("'])set\s*($|[|;&"'])|process\.env(?!\.[a-z_][a-z0-9_]*|\[\s*["'][a-z0-9_]+["']\s*\])|os\.environ(?!\s*(\[\s*["'][a-z0-9_]+["']\s*\]|\.get\(\s*["'][a-z0-9_]+["']))|getenvironmentvariables\s*\(|environmentvariables\b)/, '환경 변수의 열쇠나 환경 전체를 찍어 보지 않습니다(이름 하나를 읽는 것은 됩니다)'],
  // 2. 가드 · 사본 · 진료 기록 · Doctor 프로그램(가드의 파일 이름 · 실행 폴더 이름은 어디서 가리키든 — 상대 경로로도 — 건드리지 않는다)
  ['doctor-home', /_agent\/+doctor(?![\w-])|iris doctor\/(run-|guard)|guard-hook\.mjs|(^|[\s"'/=.])run-\d{6,}/, 'Doctor 의 자리(열쇠 · 진료 기록 · 사본 · 가드)를 건드리지 않습니다'],
  // 3. 프로세스: 이름으로 골라 끝내기
  ['kill-by-name', /(taskkill\b[^|;&]*\/(im|fi)\b|stop-process\b[^|;&]*-(name|processname)\b|get-process\b[^|;&]*\|\s*(stop-process|kill)\b|(^|[\s;|&(])(pkill|killall)\b|wmic\b[^|;&]*process[^|;&]*(delete|terminate))/, '프로세스를 이름으로 골라 끝내지 않습니다(번호와 명령줄을 확인한 그 하나만 번호로)'],
  // 4. 종량 과금 길
  ['billing', /((anthropic|openai)_api_key\s*=\s*["']?[^\s"';|&)]|setx\s+(\/m\s+)?(anthropic|openai)_|setenvironmentvariable\(\s*["'](anthropic|openai)_(api_key|base_url)["']\s*,\s*["'][^"']|apikeyhelper|api\.anthropic\.com|api\.openai\.com)/, 'API 키 종량 과금 길을 만들거나 그쪽으로 직접 통신하지 않습니다'],
  // 5. 인증서 검증 끄기
  ['tls-off', /(node_tls_reject_unauthorized|--insecure\b|strict-ssl\s*(=|\s)\s*false|skipcertificatecheck|servercertificatevalidationcallback|git_ssl_no_verify|sslverify\s*(=|\s)\s*false|--no-check-certificate)/, '인증서 검증을 끄지 않습니다'],
  // 6. 시스템 보안 설정 · 계정 · 전원
  ['system', /((set|add)-mppreference|netsh\s+advfirewall|set-executionpolicy\b[^|;&]*(localmachine|-scope\s+machine)|reg(\.exe)?\s+(add|delete|import)\s+["']?hklm|(set|new|remove|rename|clear|copy|move)-item(property)?\b[^|;&]*hklm:|bcdedit|(^|[\s;|&(])sc(\.exe)?\s+(stop|delete|config|create)\b|net\s+(user|localgroup)\b|takeown\b|(^|[\s;|&(])shutdown(\.exe)?\s|restart-computer|stop-computer|diskpart|(^|[\s;|&(])format\s+[a-z]:|vssadmin|cipher\s+\/w|schtasks\b[^|;&]*\/(create|change|delete)|register-scheduledtask|new-service|set-service)/, '윈도우의 보안 설정 · 계정 · 서비스 · 예약 작업 · 전원을 바꾸지 않습니다'],
  // 6b. 영구 환경 변수(사용자 · 시스템): 바꾸면 되돌릴 사본이 없다 — 에이전트가 바꾸지 않고 "사람이 할 일"로 적게 한다(이 실행 안에서만 쓰는 $env:X = … 는 된다)
  //     읽기(reg query · Get-ItemProperty · GetEnvironmentVariable)는 막지 않는다 — 원인 찾기에 필요하다. 저장 대상은 이름(User · Machine)으로도 숫자(1 · 2)로도 잡는다.
  ['persistent-env', /((^|[\s;|&("'\\/])setx(\.exe)?["']?\s|setenvironmentvariable\s*\([^)]*,\s*["']?(\[?[a-z.]*environmentvariabletarget\]?::)?(user|machine)|setenvironmentvariable\s*\([^,)]*,[^)]*,\s*[12]\s*\)|(reg(\.exe)?["']?\s+(add|delete|import|copy|restore|load)\b|(set|new|remove|rename|clear|copy|move)-item(property)?\b)[^|;&]*(hkcu|hkey_current_user)(:)?[\\/]+environment\b|currentuser\b[^|;&]*opensubkey\(\s*["']environment["']\s*,\s*\$?true)/, '윈도우에 저장되는 환경 변수는 바꾸지 않습니다(되돌릴 사본을 뜰 수 없습니다 — 바꿔야 하면 사람이 할 일로 적어 주세요)'],
  // 7. 계정 지우기 · 로그아웃
  ['account', /((^|[\s;|&("'])(teamclaude|claude|codex)(\.cmd|\.exe)?["']?\s+(logout|remove|rm|delete)\b|\/logout\b)/, '연결된 계정을 지우거나 로그아웃하지 않습니다'],
  // 8. 무엇을 하는지 읽을 수 없는 명령 · 받아서 곧바로 실행
  ['opaque', /((powershell|pwsh)(\.exe)?\b[^|;&]*\s-e(nc(odedcommand)?)?\s+[a-z0-9+/=]{20,}|frombase64string|(^|[\s;|&(])(iex|invoke-expression)\b|(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^;&]*\|\s*(sh|bash|zsh|cmd|powershell|pwsh|iex|node|python)\b|downloadstring\(|certutil\b[^|;&]*-(decode|urlcache)|(^|[\s;|&(])(mshta|rundll32|regsvr32)\b)/, '내용을 읽을 수 없는 명령이나 받아서 곧바로 실행하는 명령을 쓰지 않습니다'],
  // 9. 통째로 지우기 · 되돌릴 수 없는 정리
  ['mass-delete', /(remove-item\b[^|;&]*-recurse|(^|[\s;|&(])rm\s+(-[a-z]*r[a-z]*\b|--recursive)|(^|[\s;|&(])(rd|rmdir)\s+\/s|(^|[\s;|&(])del\s+[^|;&]*\/s|git\s+(reset\s+--hard|clean\s+-[a-z]*f)|rmtree\(|fs\.rm(sync)?\([^)]*recursive)/, '폴더를 통째로 지우지 않습니다(지우는 대신 이름을 바꿔 옆에 비켜 둡니다)'],
  // 10. 바깥으로 올려 보내기(파일 옮기는 프로그램)
  ['upload', /(^|[\s;|&(])(scp|sftp|ftp|rclone)\b/, '이 PC 의 내용을 바깥으로 올려 보내지 않습니다'],
];
// 대소문자를 가려야 하는 무늬(curl 의 -k 와 -K, -F 와 -f 는 다른 뜻이다) — 소문자로 바꾸지 않은 글에서 본다
const CURL_INSECURE = /[cC]url(\.exe)?\b[^|;&]*\s-[a-jl-zA-Z]*k[a-zA-Z]*(\s|$)/;
const CURL_SEND = /[cC]url(\.exe)?\b[^|;&]*\s(-T|--upload-file|-F|--form|--data-binary|-d|--data|--data-raw|--data-urlencode)(\s|=)/;
const PS_SEND = /invoke-(webrequest|restmethod)\b[^|;&]*-(infile|body)\b/;
// 글에 이 PC 가 아닌 곳의 주소가 있는가(이 PC 안의 중계기 · 창에 보내는 것은 막지 않는다)
const hasRemoteUrl = (text) => [...text.matchAll(/https?:\/\/(\[[^\]]+\]|[^/\s:"'`]+)/g)].some((m) => !/^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(m[1]));
// 묶음(Job) 없이 도는 PC 에서만: 뒤에 남는 실행을 막는다(Doctor 가 끝나도 남아 도는 프로세스를 만들지 않게)
const BACKGROUND = ['background', /(start-process\b|start-job\b|(^|[\s;|&(])start\s+("|\/)|(^|[\s;|&(])nohup\b|&\s*$|-windowstyle\s+hidden|detached\s*:\s*true)/, '뒤에 남아 도는 실행을 만들지 않습니다(이 PC 에서는 Doctor 가 끝날 때 함께 끝내 줄 수 없습니다)'];
// 원인 찾기(읽기만) 단계에서만: 바꾸는 명령
const WRITING = ['read-only', /((^|[^2&])>{1,2}\s*[^&\s]|(set|add|clear)-content\b|out-file\b|new-item\b|(^|[\s;|&(])(mkdir|md|touch|mv|move|cp|copy|ren|rename|del|erase|rm|tee)\b|(remove|move|copy|rename|set|clear)-item(property)?\b|setx\b|reg(\.exe)?\s+(add|delete)|writefilesync|appendfilesync|renamesync|\.write\(|npm\s+(i|install|ci|uninstall)\b|git\s+(commit|checkout|reset|pull|merge|stash)|stop-process\b|taskkill\b|(^|[\s;|&(])kill\s|\.kill\(|start-process\b|(start|stop|restart)-service\b|-method\s+["']?(post|put|delete|patch)|\s(-x|--request)\s*["']?(post|put|delete|patch)|\/api\/shutdown|(^|[\s;|&("'])(teamclaude|claude|codex)(\.cmd|\.exe)?["']?\s+(login|update|install|restart|start|stop)\b|teamclaude-manage|relay-ensure)/, '지금은 원인을 찾는 단계라 아무것도 바꾸지 않습니다(프로그램을 끝내거나 켜는 일 · 바꾸는 일은 치료 단계에서)'];

const strings = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach((x) => strings(x, out)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out)); return out; };
const under = (p, root) => { const a = norm(path.resolve(p)), b = norm(path.resolve(root)).replace(/\/+$/, ''); return a === b || a.startsWith(`${b}/`); };

/**
 * 도구 호출 하나를 가린다. → null(통과) | { rule, reason }
 * policy = { mode: 'diagnose' | 'treat', noBackground, writeRoots: [쓸 수 있는 폴더…], denyRoots: [그 안이어도 못 쓰는 폴더…] }
 */
export function decide(event, policy = {}) {
  const tool = String(event?.tool_name ?? '');
  const input = event?.tool_input;
  if (!tool || input === undefined || input === null) return READ_TOOLS.test(tool) ? null : { rule: 'unreadable', reason: '도구 호출의 내용을 읽지 못해 실행하지 않습니다' };
  const isWriteTool = WRITE_TOOLS.test(tool);
  // 파일을 고치는 도구는 "지워지는 옛 글"(old_string)은 보지 않는다 — 위험한 설정 줄을 지우려는 편집을 막지 않게. 새로 들어가는 글과 자리만 본다.
  const seen = isWriteTool && input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).filter(([k]) => !/^old_(string|str|text)$/i.test(k))) : input;
  const texts = strings(seen);
  const text = norm(texts.join('\n'));
  if (text.length > 200_000) return { rule: 'opaque', reason: '명령이 너무 길어 내용을 확인할 수 없습니다' };
  for (const [rule, re, reason] of RULES) if (re.test(text)) return { rule, reason };
  const rawText = texts.join('\n').replace(/\\+/g, '/');
  // 명령 글 안의 경로 조각을 작업 폴더 기준으로 풀어 본다 — 상대 경로(../…)로 Doctor 의 자리 · 가드 · 사본을 가리켜도 건드리지 못하게
  if (!isWriteTool && (policy.denyRoots || []).length) {
    const cwd = typeof event.cwd === 'string' && path.isAbsolute(event.cwd) ? event.cwd : policy.workDir || null;
    // 따옴표로 묶인 글은 통째로 한 조각(공백이 든 경로 — 이름에 공백이 있는 사용자 폴더 등 — 가 둘로 잘려 빠져나가지 않게) + 따옴표 밖은 공백 · 기호로 나눈 조각
    const quoted = [...rawText.matchAll(/"([^"\r\n]{1,400})"|'([^'\r\n]{1,400})'/g)].map((m) => m[1] ?? m[2]);
    for (const tok of [...quoted, ...rawText.split(/[\s"'`=;|&<>(),]+/)]) {
      if (!tok || tok.length > 400 || !/[/]|^\.\.?$/.test(tok)) continue;
      const t = tok.replace(/^\/([a-zA-Z])\//, '$1:/');
      let abs = null;
      try { abs = path.isAbsolute(t) ? path.resolve(t) : cwd ? path.resolve(cwd, t) : null; } catch {}
      const hit = abs ? policy.denyRoots.find((r) => under(abs, r)) : null;
      // 사본을 뜨지 못해 막아 둔 파일(frozen)은 까닭을 따로 말한다 — "Doctor 의 자리"라고 하면 에이전트도 사람도 헷갈린다(2026-11-26 시험장 실측)
      if (hit) return (policy.frozen || []).includes(hit) ? { rule: 'frozen-file', reason: FROZEN } : { rule: 'doctor-home', reason: 'Doctor 의 자리(열쇠 · 진료 기록 · 사본 · 가드)를 건드리지 않습니다' };
    }
  }
  if (CURL_INSECURE.test(rawText)) return { rule: 'tls-off', reason: '인증서 검증을 끄지 않습니다' };
  if ((CURL_SEND.test(rawText) || PS_SEND.test(text)) && hasRemoteUrl(text)) return { rule: 'upload', reason: '이 PC 의 내용을 바깥으로 올려 보내지 않습니다' };
  if (policy.noBackground && BACKGROUND[1].test(text)) return { rule: BACKGROUND[0], reason: BACKGROUND[2] };
  if (policy.mode === 'diagnose') {
    if (isWriteTool) return { rule: 'read-only', reason: WRITING[2] };
    if (!READ_TOOLS.test(tool) && (WRITING[1].test(text) || CURL_SEND.test(rawText))) return { rule: WRITING[0], reason: WRITING[2] };
    return null;
  }
  // 치료 단계: 파일을 쓰는 도구는 정해 둔 폴더 안에만(사용자의 작업 자료에 쓰지 않는다)
  if (isWriteTool) {
    const target = input.file_path ?? input.path ?? input.notebook_path ?? null;
    if (typeof target !== 'string' || !path.isAbsolute(target)) return { rule: 'write-scope', reason: '쓸 파일의 자리를 확인할 수 없습니다(절대 경로로 적어 주세요)' };
    if ((policy.frozen || []).some((r) => under(target, r))) return { rule: 'frozen-file', reason: FROZEN };
    if ((policy.denyRoots || []).some((r) => under(target, r))) return { rule: 'write-scope', reason: '그 자리는 치료 중에 고치지 않는 곳입니다' };
    if (!(policy.writeRoots || []).some((r) => under(target, r))) return { rule: 'write-scope', reason: 'IRIS 의 설정 · 프로그램 자리 밖(사용자의 작업 자료 등)에는 쓰지 않습니다' };
  }
  return null;
}

// ── 훅으로 불렸을 때
const isMain = (() => { try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; } })();
if (isMain) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let policy = null; try { policy = JSON.parse(fs.readFileSync(path.join(here, 'policy.json'), 'utf8')); } catch {}
  let raw = ''; try { raw = fs.readFileSync(0, 'utf8'); } catch {}
  let event = null; try { event = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); } catch {}
  let verdict;
  if (!policy) verdict = { rule: 'no-policy', reason: 'Doctor 가드의 규칙 파일을 읽지 못해 실행하지 않습니다' };
  else if (!event) verdict = { rule: 'unreadable', reason: '도구 호출의 내용을 읽지 못해 실행하지 않습니다' };
  else { try { verdict = decide(event, policy); } catch { verdict = { rule: 'guard-error', reason: 'Doctor 가드가 판단하지 못해 실행하지 않습니다' }; } }
  // 가드가 불린 사실을 적는다(도구 이름과 통과 · 거절만 — 명령 글은 싣지 않는다). Doctor 가 "가드가 실제로 돌았는가"를 이것으로 확인한다.
  try { fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({ at: new Date().toISOString(), tool: String(event?.tool_name ?? '').slice(0, 40), v: verdict ? 'deny' : 'allow' }) + '\n'); } catch {}
  if (verdict) {
    // 거절한 사실만 적는다(무슨 규칙인지 · 어느 도구인지 — 명령 글은 싣지 않는다)
    try { fs.appendFileSync(path.join(here, 'denied.jsonl'), JSON.stringify({ at: new Date().toISOString(), rule: verdict.rule, tool: String(event?.tool_name ?? '').slice(0, 40) }) + '\n'); } catch {}
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[IRIS Doctor 가드] ${verdict.reason}. 다른 방법을 써 주세요.` } }) + '\n');
  }
  process.exit(0);
}
