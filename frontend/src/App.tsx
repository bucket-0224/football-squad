import { useEffect, useState } from 'react';
import { useAppStore } from './store/useAppStore';
import AuthView from './components/AuthView';
import Header from './components/Header';
import Toast from './components/Toast';
import TabNav, { SubTabNav, type TopTabId, type ShopSubTab, type InfoSubTab } from './components/TabNav';
import SquadTab from './components/tabs/SquadTab';
import MarketTab from './components/tabs/MarketTab';
import PacksTab from './components/tabs/PacksTab';
import PredictTab from './components/tabs/PredictTab';
import RankTab from './components/tabs/RankTab';
import NewsTab from './components/tabs/NewsTab';
import MatchTab from './components/tabs/MatchTab';

const SHOP_SUBS: { id: ShopSubTab; label: string }[] = [
  { id: 'market', label: '이적시장' },
  { id: 'packs', label: '뽑기' },
];
const INFO_SUBS: { id: InfoSubTab; label: string }[] = [
  { id: 'rank', label: '랭킹 · 기록' },
  { id: 'news', label: '뉴스' },
];

function MainView() {
  const [tab, setTab] = useState<TopTabId>('squad');
  const [shopSub, setShopSub] = useState<ShopSubTab>('market');
  const [infoSub, setInfoSub] = useState<InfoSubTab>('rank');

  return (
    <section id="view-main" className="view">
      <Header />
      <TabNav active={tab} onChange={setTab} />
      {tab === 'shop' && <SubTabNav options={SHOP_SUBS} active={shopSub} onChange={setShopSub} />}
      {tab === 'info' && <SubTabNav options={INFO_SUBS} active={infoSub} onChange={setInfoSub} />}
      {tab === 'squad' && <SquadTab />}
      {tab === 'shop' && shopSub === 'market' && <MarketTab />}
      {tab === 'shop' && shopSub === 'packs' && <PacksTab />}
      {tab === 'predict' && <PredictTab />}
      {tab === 'info' && infoSub === 'rank' && <RankTab />}
      {tab === 'info' && infoSub === 'news' && <NewsTab />}
      {/* always mounted (not conditionally rendered like the tabs above) so
          a live match keeps animating/receiving WS events while the user
          browses other tabs — matches the vanilla app's CSS-hide behavior
          instead of unmounting mid-match. */}
      <MatchTab visible={tab === 'match'} />
    </section>
  );
}

export default function App() {
  const { booting, me, boot } = useAppStore();

  useEffect(() => {
    boot();
    // boot() is a stable store action reference; only run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (booting) return null;
  return (
    <>
      {me ? <MainView /> : <AuthView />}
      <Toast />
    </>
  );
}
