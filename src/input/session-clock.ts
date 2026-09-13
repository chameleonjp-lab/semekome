/** Fixed 60 Hz clock. Pause discards elapsed wall time and held input. */
export class SessionClock {
  private previous: number | null = null;
  private remainder = 0;

  reset(): void { this.previous = null; this.remainder = 0; }

  advance(now: number): { ticks: number; interrupted: boolean } {
    if (this.previous === null) { this.previous = now; return { ticks: 0, interrupted: false }; }
    const elapsed = now - this.previous;
    this.previous = now;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 250) {
      this.reset(); return { ticks: 0, interrupted: true };
    }
    this.remainder += elapsed * 60 / 1000;
    const ticks = Math.floor(this.remainder + 1e-8);
    this.remainder -= ticks;
    return { ticks, interrupted: false };
  }
}

export function validatePlayerName(raw: string): { name: string; error: string | null } {
  const name = raw.trim();
  const length = Array.from(name).length;
  return { name, error: length < 1 || length > 20 ? '名前は前後の空白を除いて1〜20文字で入力してください。' : null };
}
