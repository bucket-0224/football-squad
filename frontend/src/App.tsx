import { useEffect, useState } from 'react';
import { useAppStore } from './store/useAppStore';
import AuthView from './components/AuthView';
import Header from './components/Header';
import Toast from './components/Toast';
import TabNav, { SubTabNav, type TopTabId, type ShopSubTab, type InfoSubTab } from './components/TabNav';
import SquadTab from './components/tabs/SquadTab';
import MarketTab from './components/tabs/MarketTab';
import PacksTab from './components/tabs/PacksTab';
import EventTab from './components/tabs/EventTab';
import PredictTab from './components/tabs/PredictTab';
import RankTab from './components/tabs/RankTab';
import NewsTab from './components/tabs/NewsTab';
import MatchTab from './components/tabs/MatchTab';

// 요청: "뽑기 탭을 구매 탭으로 변경해주고... 뽑기 탭 옆에 이벤트 탭 만들어
// 주고" — id는 그대로 'packs'로 두고(백엔드/CSS 등 다른 참조와 무관하게
// 라벨만 바꾸면 되므로) 표시 텍스트만 "구매"로 바꿨다.
const SHOP_SUBS: { id: ShopSubTab; label: string }[] = [
  { id: 'market', label: '이적시장' },
  { id: 'packs', label: '구매' },
  { id: 'event', label: '이벤트' },
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
      {tab === 'shop' && shopSub === 'event' && <EventTab />}
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
