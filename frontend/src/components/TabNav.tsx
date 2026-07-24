export type TopTabId = 'squad' | 'shop' | 'match' | 'predict' | 'info';
export type ShopSubTab = 'market' | 'packs';
export type InfoSubTab = 'rank' | 'news';

const TOP_TABS: { id: TopTabId; label: string; icon: string }[] = [
  { id: 'squad', label: '스쿼드', icon: '⚽' },
  { id: 'shop', label: '상점', icon: '🛒' },
  { id: 'match', label: '대전', icon: '⚔️' },
  { id: 'predict', label: '예측', icon: '🔮' },
  { id: 'info', label: '정보', icon: '📋' },
];

export default function TabNav({ active, onChange }: { active: TopTabId; onChange: (id: TopTabId) => void }) {
  return (
    <nav id="main-tabs">
      {TOP_TABS.map((t) => (
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

export function SubTabNav<T extends string>({
  options,
  active,
  onChange,
}: {
  options: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="sub-tabs">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={active === o.id ? 'active' : ''}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
