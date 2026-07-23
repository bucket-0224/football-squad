import { useEffect, useState } from 'react';
import { useAppStore } from './store/useAppStore';
import AuthView from './components/AuthView';
import Header from './components/Header';
import Toast from './components/Toast';
import TabNav, { type TabId } from './components/TabNav';
import SquadTab from './components/tabs/SquadTab';
import MarketTab from './components/tabs/MarketTab';
import PacksTab from './components/tabs/PacksTab';
import PredictTab from './components/tabs/PredictTab';
import RankTab from './components/tabs/RankTab';
import NewsTab from './components/tabs/NewsTab';
import MatchTab from './components/tabs/MatchTab';

function MainView() {
  const [tab, setTab] = useState<TabId>('squad');

  return (
    <section id="view-main" className="view">
      <Header />
      <TabNav active={tab} onChange={setTab} />
      {tab === 'squad' && <SquadTab />}
      {tab === 'market' && <MarketTab />}
      {tab === 'packs' && <PacksTab />}
      {tab === 'predict' && <PredictTab />}
      {tab === 'rank' && <RankTab />}
      {tab === 'news' && <NewsTab />}
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
