export type TabId = 'squad' | 'market' | 'packs' | 'match' | 'predict' | 'rank' | 'news';

const TABS: { id: TabId; label: string }[] = [
  { id: 'squad', label: '스쿼드' },
  { id: 'market', label: '이적시장' },
  { id: 'packs', label: '뽑기' },
  { id: 'match', label: '대전' },
  { id: 'predict', label: '예측' },
  { id: 'rank', label: '랭킹 · 기록' },
  { id: 'news', label: '뉴스' },
];

export default function TabNav({ active, onChange }: { active: TabId; onChange: (id: TabId) => void }) {
  return (
    <nav id="main-tabs">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={active === t.id ? 'active' : ''}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
