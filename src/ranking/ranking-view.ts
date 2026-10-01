import type { RankingRow } from './ranking-client.ts';
export function createRankingView(host: HTMLElement, load: () => Promise<RankingRow[]>) {
  let disposed = false, generation = 0;
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const list = document.createElement('ol');
  const retry = document.createElement('button'); retry.textContent = 'ランキングを再読込';
  retry.style.minHeight = '48px'; retry.style.touchAction = 'manipulation';
  host.replaceChildren(status, list, retry);
  const refresh = async () => {
    const current = ++generation; retry.disabled = true; list.replaceChildren();
    status.textContent = '上位10位を読込中'; host.dataset.rankingStatus = 'loading';
    try {
      const rows = await load(); if (disposed || current !== generation) return;
      host.dataset.rankingStatus = rows.length ? 'success' : 'empty';
      status.textContent = rows.length ? '上位10位' : 'まだランキングの記録がありません';
      for (const row of rows) {
        const item = document.createElement('li');
        item.value = row.rank_no;
        item.textContent = `${row.rank_no}位 ${row.display_name} ${row.best_score}点`;
        list.append(item);
      }
    } catch { if (disposed || current !== generation) return; host.dataset.rankingStatus = 'failed'; status.textContent = 'ランキングを取得できませんでした'; }
    finally { if (!disposed && current === generation) retry.disabled = false; }
  };
  retry.addEventListener('click', refresh); void refresh();
  return { refresh, dispose() { disposed = true; generation++; retry.removeEventListener('click', refresh); } };
}
export function resultShareText(name: string, outcome: string, score: number, canonicalUrl: string): string {
  const url = new URL(canonicalUrl);
  if (url.protocol !== 'https:' || url.username || url.password || !Number.isSafeInteger(score) || score < 0) throw new Error('Invalid confirmed share result');
  return `セメコメ ${name}：${outcome} ${score}点\n${url.href}`;
}
