import { describe, expect, test } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { originAllowed, clientIp, createGate } from '../src/gate.ts';

/** A real IncomingMessage on an unconnected socket whose remote address we choose. */
function req(headers: Record<string, string>, remote = '10.0.0.1'): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: remote });
  const msg = new IncomingMessage(socket);
  msg.headers = headers;
  return msg;
}

describe('originAllowed', () => {
  const prod = { allowedOrigins: [] as string[], production: true };
  test('same origin is allowed, a foreign page is not (cross-site WebSocket hijacking)', () => {
    expect(originAllowed('https://flyordie.onrender.com', 'flyordie.onrender.com', prod)).toBe(
      true,
    );
    expect(originAllowed('https://evil.example', 'flyordie.onrender.com', prod)).toBe(false);
  });
  test('no Origin header = not a browser: allowed (rate limits and IP caps handle it)', () => {
    expect(originAllowed(undefined, 'x', prod)).toBe(true);
  });
  test('localhost origins only outside production', () => {
    expect(
      originAllowed('http://localhost:5173', 'localhost:8787', { ...prod, production: false }),
    ).toBe(true);
    expect(originAllowed('http://localhost:5173', 'game.example', prod)).toBe(false);
  });
  test('an explicit allow-list replaces the defaults', () => {
    const cfg = { allowedOrigins: ['https://html-classic.itch.zone'], production: true };
    expect(originAllowed('https://html-classic.itch.zone', 'flyordie.onrender.com', cfg)).toBe(
      true,
    );
    expect(originAllowed('https://flyordie.onrender.com', 'flyordie.onrender.com', cfg)).toBe(
      false,
    );
  });
});

describe('clientIp', () => {
  test('behind a trusted proxy: the LAST X-Forwarded-For entry (earlier ones can be forged)', () => {
    const r = req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }, '10.0.0.1');
    expect(clientIp(r, true)).toBe('203.0.113.7');
    expect(clientIp(r, false)).toBe('10.0.0.1'); // not trusted: the socket's address
  });
});

describe('gate', () => {
  test('per-IP cap: the (n+1)th connection is refused with 429; closing frees a slot', () => {
    const gate = createGate({
      allowedOrigins: [],
      production: true,
      trustProxy: false,
      maxConnectionsPerIp: 2,
    });
    const r = req({}, '198.51.100.9');
    const a = gate.admit(r);
    const b = gate.admit(r);
    expect(a.ok && b.ok).toBe(true);
    expect(gate.admit(r)).toEqual({ ok: false, status: 429, reason: 'ip_cap' });
    gate.release('198.51.100.9');
    expect(gate.admit(r).ok).toBe(true);
    expect(gate.admit(req({}, '198.51.100.10')).ok).toBe(true); // other IPs unaffected
  });
  test('a foreign origin is refused with 403 before counting', () => {
    const gate = createGate({
      allowedOrigins: [],
      production: true,
      trustProxy: false,
      maxConnectionsPerIp: 1,
    });
    expect(gate.admit(req({ origin: 'https://evil.example', host: 'game.example' }))).toEqual({
      ok: false,
      status: 403,
      reason: 'origin',
    });
    expect(gate.openFrom('10.0.0.1')).toBe(0);
  });
});
