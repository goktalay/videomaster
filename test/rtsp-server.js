'use strict';

// Testler için küçük bir RTSP sunucusu: ffmpeg'in ürettiği RTP paketlerini (yerel UDP) alır ve
// bağlanan istemciye TCP içinde araya eklemeli ($) olarak verir. İsteğe bağlı Basic kimlik doğrulama.

const net = require('net');
const dgram = require('dgram');

function createRtspServer({ sdp, ports, auth = null }) {
  // ports: [videoUdpPort, audioUdpPort?] — SDP'deki m= sırasıyla
  const clients = new Set();
  const socks = ports.map((port, i) => {
    const s = dgram.createSocket('udp4');
    s.on('message', (msg) => {
      for (const c of clients) {
        if (!c.playing || c.channels[i] === undefined) continue;
        const head = Buffer.alloc(4);
        head[0] = 0x24; head[1] = c.channels[i]; head.writeUInt16BE(msg.length, 2);
        c.sock.write(Buffer.concat([head, msg]));
      }
    });
    s.bind(port, '127.0.0.1');
    return s;
  });
  let track = 0;
  const body = sdp.replace(/^m=.*$/gm, (m) => `${m}\r\na=control:trackID=${track++}`).replace(/\r?\n/g, '\r\n').replace(/(\r\n)+/g, '\r\n');
  const requests = [];

  const server = net.createServer((sock) => {
    const c = { sock, playing: false, channels: {} };
    clients.add(c);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      for (;;) {
        if (buf[0] === '$') { // istemciden gelen RTCP: atla
          if (buf.length < 4) return;
          const len = (buf.charCodeAt(2) << 8) | buf.charCodeAt(3);
          if (buf.length < 4 + len) return;
          buf = buf.slice(4 + len);
          continue;
        }
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.slice(0, end);
        buf = buf.slice(end + 4);
        const [line, ...rest] = head.split('\r\n');
        const [method, url] = line.split(' ');
        const h = {};
        for (const r of rest) { const i = r.indexOf(':'); h[r.slice(0, i).toLowerCase()] = r.slice(i + 1).trim(); }
        requests.push({ method, url, headers: h });
        const reply = (code, text, extra = {}, payload = '') => {
          let out = `RTSP/1.0 ${code} ${text}\r\nCSeq: ${h.cseq}\r\nServer: MiniRTSP/1.0\r\n`;
          for (const [k, v] of Object.entries(extra)) out += `${k}: ${v}\r\n`;
          if (payload) out += `Content-Length: ${Buffer.byteLength(payload)}\r\n`;
          sock.write(out + '\r\n' + payload);
        };
        if (auth && method !== 'OPTIONS') {
          const want = 'Basic ' + Buffer.from(auth).toString('base64');
          if (h.authorization !== want) { reply(401, 'Unauthorized', { 'WWW-Authenticate': 'Basic realm="test"' }); continue; }
        }
        if (method === 'OPTIONS') reply(200, 'OK', { Public: 'OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN' });
        else if (method === 'DESCRIBE') reply(200, 'OK', { 'Content-Type': 'application/sdp', 'Content-Base': url + '/' }, body);
        else if (method === 'SETUP') {
          const tr = /trackID=(\d+)/.exec(url);
          const il = /interleaved=(\d+)-(\d+)/.exec(h.transport || '');
          if (!tr || !il) { reply(461, 'Unsupported Transport'); continue; }
          c.channels[Number(tr[1])] = Number(il[1]);
          reply(200, 'OK', { Transport: `RTP/AVP/TCP;unicast;interleaved=${il[1]}-${il[2]}`, Session: '12345678;timeout=60' });
        } else if (method === 'PLAY') { c.playing = true; reply(200, 'OK', { Session: '12345678', Range: 'npt=0.000-' }); }
        else if (method === 'TEARDOWN') { reply(200, 'OK'); sock.end(); }
        else reply(200, 'OK', { Session: '12345678' });
      }
    });
    const drop = () => clients.delete(c);
    sock.on('close', drop);
    sock.on('error', drop);
  });

  return {
    server, requests, clients,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => { for (const c of clients) c.sock.destroy(); for (const s of socks) s.close(); server.close(); },
  };
}

module.exports = { createRtspServer };
