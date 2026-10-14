import type { Principal } from './events';
export const POLL_MS = 30_000;
export const PERMISSION_MS = 3_600_000;
export interface Grant { id: string; clientId: string; scope: string[]; expiresAt?: number }
export interface PermissionSnapshot { checkedAt: number; grants: Grant[] }
export class PermissionCache {
  constructor(private d: {load(): Promise<PermissionSnapshot | undefined>; save(value: PermissionSnapshot): Promise<void>; fetch(): Promise<Grant[]>; now?: () => number}) {}
  async authorized(p: Principal, fresh = false) {
    if (p.userId !== 'owner') return false;
    const now = this.d.now?.() ?? Date.now();
    let snapshot = await this.d.load();
    if (fresh || !snapshot || now < snapshot.checkedAt || now - snapshot.checkedAt >= PERMISSION_MS) {
      snapshot = { checkedAt: now, grants: await this.d.fetch() };
      await this.d.save(snapshot);
    }
    return snapshot.grants.some(g => g.id === p.grantId && g.clientId === p.clientId && g.scope.includes('mail') && (!g.expiresAt || g.expiresAt > now / 1000));
  }
}
export function pollDelay(failures: number) { return Math.min(POLL_MS * 2 ** Math.min(failures, 5), 900_000); }
