// 중계기 가로채기 실측 — 설계 A'(2026-09-18) 조각 3.
//
// TeamClaude 의 MITM 프록시에는 내장 시험 호스트(www.example.org)가 있다: 그 호스트로
// CONNECT 하면 중계기가 업스트림으로 보내지 않고 자기 리프 증명서로 TLS 를 맺은 뒤
// `{"teamclaude":"mitm-proxy-ok"}` 를 돌려준다. 계정·토큰 없이도 "프록시 + CA" 가
// 끝까지 이어졌는지 잴 수 있고, 첫 CONNECT 가 CA 를 만들게 하는 방아쇠도 된다.
//
// Node 의 fetch 는 프록시를 모르므로 소켓으로 CONNECT 를 직접 쓴다. `ca` 를 주면
// 그 CA 로 검증(rejectUnauthorized)하고, 없으면 검증 없이 맺어 CA 를 만들게만 한다.
import net from 'node:net';
import tls from 'node:tls';

export const MITM_TEST_HOST = 'www.example.org';

export function mitmProbe({
  proxyHost = '127.0.0.1',
  proxyPort = 3456,
  host = MITM_TEST_HOST,
  ca = null,
  timeoutMs = 8000,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let sock = null;
    let tsock = null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { tsock?.destroy(); } catch { /* ignore */ }
      try { sock?.destroy(); } catch { /* ignore */ }
      resolve({ ok: false, status: null, body: '', verified: false, issuer: null, error: null, ...r });
    };
    const timer = setTimeout(() => done({ error: `timeout ${timeoutMs}ms` }), timeoutMs);

    sock = net.connect({ host: proxyHost, port: proxyPort });
    sock.on('error', (e) => done({ error: `proxy: ${e?.message ?? e}` }));
    sock.on('connect', () => sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));

    let head = '';
    const onData = (d) => {
      head += d.toString('latin1');
      const i = head.indexOf('\r\n\r\n');
      if (i < 0) return;
      sock.off('data', onData);
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
      if (!m || m[1] !== '200') return done({ error: `CONNECT ${m ? m[1] : '?'}` });
      // 헤더 뒤에 딸려 온 바이트가 있으면 TLS 쪽으로 넘겨야 하지만, CONNECT 200 응답에는
      // 본문이 없고 TLS 는 클라이언트가 먼저 말하므로 남는 바이트는 없다.
      tsock = tls.connect({
        socket: sock,
        servername: host,
        ca: ca ? [ca] : undefined,
        rejectUnauthorized: !!ca,
      }, () => {
        tsock.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
      let res = '';
      tsock.on('error', (e) => done({ error: `tls: ${e?.message ?? e}` }));
      tsock.on('data', (d) => { res += d.toString('utf8'); });
      tsock.on('end', () => {
        const sm = /^HTTP\/1\.[01] (\d{3})/.exec(res);
        const body = res.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        let issuer = null;
        try { issuer = tsock.getPeerCertificate()?.issuer?.CN ?? null; } catch { /* ignore */ }
        done({
          ok: sm?.[1] === '200',
          status: sm ? Number(sm[1]) : null,
          body: body.slice(0, 400),
          verified: !!ca && tsock.authorized === true,
          issuer,
        });
      });
    };
    sock.on('data', onData);
  });
}
