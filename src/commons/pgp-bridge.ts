/**
 * pgp-bridge.ts — one-time token handshake with carbonio-pgp-ui.
 *
 * On load, calls window.__encedoPgpRegister() to obtain a call secret.
 * The function self-deletes after the first call, so only this module holds the secret.
 * All crypto window globals require the secret as a second argument.
 */

let _callSecret: string | null = null;

function ensureToken(): string {
  if (_callSecret) return _callSecret;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const register = (window as any).__encedoPgpRegister;
  if (typeof register !== 'function') {
    throw new Error('carbonio-pgp-ui not loaded — __encedoPgpRegister unavailable');
  }
  _callSecret = register() as string;
  return _callSecret;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pgpCall(name: string, ...args: unknown[]): Promise<any> {
  const token = ensureToken();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (window as any)[name];
  if (typeof fn !== 'function') {
    throw new Error(`carbonio-pgp-ui not loaded — ${name} unavailable`);
  }
  return fn(...args, token) as Promise<unknown>;
}
