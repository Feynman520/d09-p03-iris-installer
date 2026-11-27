// 검진을 돌리는 자식 프로세스 — 넘겨받은 값(통신 없이 · 폴더 · 고른 묶음)으로 검진해 검진표(JSON)를 표준 출력에 낸다.
// 실행 입구(iris-doctor.mjs)가 이 파일을 띄우고 제한 시간 안에 답이 없으면 끝낸다.
import { childData, writeAndExit } from './deadline.mjs';
import { diagnose } from './diagnose.mjs';

// 검진의 바깥 연결 확인(fetch)이 윈도우 인증서 목록도 믿게 한다 — 부모가 넘긴 변수를 모르는 node 판에서도 되게 여기서 한 번 더 더한다(실패해도 검진은 계속).
try { (await import('./trust.mjs')).trustSystemRoots(); } catch {}
const d = childData();
const report = await diagnose({ offline: !!d.offline, root: typeof d.root === 'string' && d.root ? d.root : undefined, only: Array.isArray(d.only) && d.only.length ? d.only : undefined });
writeAndExit(JSON.stringify(report), 0, { graceMs: 20_000 }); // 받는 쪽(실행 입구)이 읽지 않아도 영영 남아 있지 않는다
