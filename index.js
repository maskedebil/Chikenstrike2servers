const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'ChickenStrike2Servers', platform: 'Cloudflare' });

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      let code;
      for (let i = 0; i < 8; i++) {
        const candidate = makeCode();
        const id = env.ROOMS.idFromName(candidate);
        const stub = env.ROOMS.get(id);
        const check = await stub.fetch('https://room.internal/status');
        if (check.status === 404) { code = candidate; break; }
      }
      if (!code) return json({ error: 'Не удалось создать комнату. Попробуй ещё раз.' }, 503);
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      const created = await stub.fetch('https://room.internal/create', { method: 'POST', body: code });
      if (!created.ok) return json({ error: 'Не удалось создать комнату.' }, 500);
      const info = await created.json();
      const base = `${url.protocol}//${url.host}`;
      return json({ room: code, code, expiresAt: info.expiresAt, inviteUrl: `${base}/invite/${code}`, wsUrl: `wss://${url.host}/ws?room=${code}` }, 201);
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})$/i);
    if (roomMatch && request.method === 'GET') {
      const code = roomMatch[1].toUpperCase();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const response = await stub.fetch('https://room.internal/status');
      if (response.status === 404) return json({ error: 'Комната не найдена или срок её действия истёк.' }, 404);
      return response;
    }

    const wsRoom = url.pathname === '/ws' ? url.searchParams.get('room') : null;
    if (url.pathname === '/ws') {
      const code = String(wsRoom || '').toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) return json({ error: 'Укажи код комнаты.' }, 400);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(new Request(`https://room.internal/connect?room=${code}`, request));
    }

    const invite = url.pathname.match(/^\/invite\/([A-Z0-9]{6})$/i);
    if (invite) {
      const code = invite[1].toUpperCase();
      const page = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chicken Strike — приглашение</title><style>body{margin:0;background:#11151d;color:#fff;font:16px system-ui;display:grid;min-height:100vh;place-items:center}.card{max-width:420px;margin:20px;padding:28px;background:#202938;border-radius:20px;text-align:center}h1{color:#ff9d26}code{font-size:28px;letter-spacing:5px;color:#ffd08a}a{display:block;margin-top:20px;padding:14px;background:#ff941f;color:#1b1b1b;text-decoration:none;border-radius:12px;font-weight:700}</style><main class="card"><h1>🐔 Chicken Strike</h1><p>Тебя пригласили в комнату:</p><code>${code}</code><p>Открой игру и введи этот код в поле комнаты.</p><a href="/game/?room=${code}">Открыть игру</a></main></html>`;
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }

    return env.ASSETS.fetch(request);
  }
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/status') {
      const room = await this.ctx.storage.get('room');
      if (!room || room.expiresAt <= Date.now()) return json({ error: 'not found' }, 404);
      return json({ room: room.code, expiresAt: room.expiresAt, hostOnline: !!room.hostOnline, maxPeers: 8 });
    }
    if (url.pathname === '/create' && request.method === 'POST') {
      const existing = await this.ctx.storage.get('room');
      if (existing && existing.expiresAt > Date.now()) return json({ error: 'exists' }, 409);
      const code = new URL(request.url).searchParams.get('code') || await this.ctx.storage.get('code');
      // The Worker sends the room code in the request body for deterministic creation.
      const body = await request.text();
      const roomCode = body || code;
      if (!roomCode) return json({ error: 'missing code' }, 400);
      const room = { code: roomCode, createdAt: Date.now(), expiresAt: Date.now() + ROOM_TTL_MS, hostOnline: false };
      await this.ctx.storage.put('room', room);
      await this.ctx.storage.setAlarm(room.expiresAt);
      return json(room, 201);
    }
    if (url.pathname === '/connect') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required', { status: 426 });
      const room = await this.ctx.storage.get('room');
      if (!room || room.expiresAt <= Date.now()) return json({ error: 'Комната истекла или не существует.' }, 404);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ role: 'pending', pid: crypto.randomUUID().slice(0, 8) });
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { const raw = typeof message === 'string' ? message : (message instanceof ArrayBuffer ? new TextDecoder().decode(message) : String(message)); msg = JSON.parse(raw); }
    catch { ws.send(JSON.stringify({ type: 'error', msg: 'Некорректное сообщение.' })); return; }
    const data = ws.deserializeAttachment() || { role: 'pending', pid: crypto.randomUUID().slice(0, 8) };
    const room = await this.ctx.storage.get('room');
    if (!room || room.expiresAt <= Date.now()) { ws.send(JSON.stringify({ type: 'error', msg: 'Срок комнаты истёк.' })); ws.close(1008, 'expired'); return; }
    const sockets = this.ctx.getWebSockets();
    const host = sockets.find(s => (s.deserializeAttachment() || {}).role === 'host');

    if (msg.type === 'host') {
      if (host && host !== ws) { ws.send(JSON.stringify({ type: 'error', msg: 'В комнате уже есть хост.' })); return; }
      data.role = 'host'; ws.serializeAttachment(data);
      room.hostOnline = true; await this.ctx.storage.put('room', room);
      ws.send(JSON.stringify({ type: 'hosted', room: room.code }));
      for (const peer of sockets) {
        const p = peer.deserializeAttachment() || {};
        if (p.role === 'peer') { ws.send(JSON.stringify({ type: 'peer', pid: p.pid })); peer.send(JSON.stringify({ type: 'joined' })); }
      }
      return;
    }

    if (msg.type === 'join') {
      const currentHost = sockets.find(s => (s.deserializeAttachment() || {}).role === 'host');
      if (!currentHost) { ws.send(JSON.stringify({ type: 'error', msg: 'Хост ещё не подключился. Попроси его открыть игру.' })); return; }
      const peerCount = sockets.filter(s => (s.deserializeAttachment() || {}).role === 'peer').length;
      if (peerCount >= 8) { ws.send(JSON.stringify({ type: 'error', msg: 'Комната заполнена.' })); return; }
      data.role = 'peer'; ws.serializeAttachment(data);
      ws.send(JSON.stringify({ type: 'joined' }));
      currentHost.send(JSON.stringify({ type: 'peer', pid: data.pid }));
      return;
    }

    if (msg.type === 'signal') {
      if (data.role === 'host') {
        const target = sockets.find(s => { const a = s.deserializeAttachment() || {}; return a.role === 'peer' && a.pid === msg.to; });
        if (target) target.send(JSON.stringify({ type: 'signal', data: msg.data }));
      } else if (data.role === 'peer') {
        const currentHost = sockets.find(s => (s.deserializeAttachment() || {}).role === 'host');
        if (currentHost) currentHost.send(JSON.stringify({ type: 'signal', from: data.pid, data: msg.data }));
      }
    }
  }

  async webSocketClose(ws) {
    const data = ws.deserializeAttachment() || {};
    const sockets = this.ctx.getWebSockets();
    if (data.role === 'host') {
      const room = await this.ctx.storage.get('room');
      if (room) { room.hostOnline = false; await this.ctx.storage.put('room', room); }
      for (const peer of sockets) {
        const p = peer.deserializeAttachment() || {};
        if (p.role === 'peer') { try { peer.send(JSON.stringify({ type: 'error', msg: 'Хост отключился.' })); peer.close(1012, 'host disconnected'); } catch {} }
      }
    } else if (data.role === 'peer') {
      const host = sockets.find(s => (s.deserializeAttachment() || {}).role === 'host');
      if (host) try { host.send(JSON.stringify({ type: 'left', pid: data.pid })); } catch {}
    }
  }

  async webSocketError(ws) { try { ws.close(1011, 'socket error'); } catch {} }

  async alarm() {
    const room = await this.ctx.storage.get('room');
    if (room && room.expiresAt <= Date.now()) {
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, 'room expired'); } catch {} }
      await this.ctx.storage.deleteAll();
    } else if (room) {
      await this.ctx.storage.setAlarm(room.expiresAt);
    }
  }
}
