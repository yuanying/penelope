const TTL_MS = 15_000;
const MAX_SOURCES = 16;

export class PluginNotes {
  private readonly entries = new Map<string, { note: unknown; expiresAt: number }>();

  set(source: string, note: unknown, now: number): boolean {
    this.expire(now);
    if (!this.entries.has(source) && this.entries.size >= MAX_SOURCES) return false;
    this.entries.set(source, { note, expiresAt: now + TTL_MS });
    return true;
  }

  delete(source: string): void {
    this.entries.delete(source);
  }

  snapshot(now: number): Record<string, unknown> | undefined {
    this.expire(now);
    if (this.entries.size === 0) return undefined;
    return Object.fromEntries(Array.from(this.entries, ([source, { note }]) => [source, note]));
  }

  private expire(now: number): void {
    for (const [source, { expiresAt }] of this.entries) {
      if (expiresAt <= now) this.entries.delete(source);
    }
  }
}
