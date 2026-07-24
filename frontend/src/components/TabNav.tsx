export type TabId = 'squad' | 'market' | 'packs' | 'match' | 'predict' | 'rank' | 'news';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'squad', label: '스쿼드', icon: '⚽' },
  { id: 'market', label: '이적시장', icon: '💱' },
  { id: 'packs', label: '뽑기', icon: '🎁' },
  { id: 'match', label: '대전', icon: '⚔️' },
  { id: 'predict', label: '예측', icon: '🔮' },
  { id: 'rank', label: '랭킹·기록', icon: '🏆' },
  { id: 'news', label: '뉴스', icon: '📰' },
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
          <span className="tab-icon">{t.icon}</span>
          <span className="tab-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
