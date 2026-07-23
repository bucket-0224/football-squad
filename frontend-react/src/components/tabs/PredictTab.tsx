import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../../store/useToastStore';
import type { Fixture, Pick as BetPick, User } from '../../types';

const PICK_LABEL: Record<BetPick, string> = { home: '홈 승', draw: '무승부', away: '원정 승' };

function kickoffLabel(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return '킥오프';
  if (diff < 3600e3) return `⏱ ${Math.max(1, Math.ceil(diff / 60000))}분 후 킥오프`;
  return (
    new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) +
    ' 킥오프'
  );
}

function FixtureTeam({ name, logo }: { name: string; logo?: string | null }) {
  return (
    <span className="fx-team">
      {logo ? <img src={logo} alt="" onError={(e) => e.currentTarget.remove()} /> : null}
      {name}
    </span>
  );
}

function FixtureCard({ fx, onBet }: { fx: Fixture; onBet: () => void }) {
  const [sh, setSh] = useState(fx.myBet?.score ? String(fx.myBet.score.home) : '');
  const [sa, setSa] = useState(fx.myBet?.score ? String(fx.myBet.score.away) : '');

  const topRight =
    fx.status === 'done' && fx.result ? (
      <span className="fx-score">
        {fx.result.score.home} - {fx.result.score.away}
      </span>
    ) : fx.status === 'live' ? (
      <>
        <span className="fx-score fx-live">{fx.live ? `${fx.live.home} - ${fx.live.away}` : '⚽'}</span>
        <span className="fx-count fx-live-min">{fx.elapsedMin != null ? fx.elapsedMin + "'" : '진행 중'}</span>
      </>
    ) : (
      <span className="fx-count">{kickoffLabel(fx.kickoffAt)}</span>
    );

  const submit = async (pick: BetPick) => {
    const score = sh !== '' && sa !== '' ? { home: Number(sh), away: Number(sa) } : null;
    try {
      await api.post('/api/predictions/bet', { fixtureId: fx.id, pick, score });
      toast('예측 완료! 실제 경기 종료 후 자동 정산됩니다.');
      onBet();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="fixture">
      <div className="fx-top">
        <span className="fx-league">{fx.leagueLabel}</span>
        <FixtureTeam name={fx.home} logo={fx.homeLogo} />
        <span className="fx-vs">vs</span>
        <FixtureTeam name={fx.away} logo={fx.awayLogo} />
        {topRight}
      </div>
      <div className="fx-actions">
        {fx.status === 'done' && fx.result ? (
          <>
            <span className="dim small-text">결과: {PICK_LABEL[fx.result.outcome]}</span>
            {fx.myBet ? (
              <>
                <span className="fx-bet-tag">
                  내 예측: {PICK_LABEL[fx.myBet.pick]}
                  {fx.myBet.score ? ` (${fx.myBet.score.home}-${fx.myBet.score.away})` : ''}
                </span>
                <span className="fx-reward">+{(fx.myBet.reward || 0).toLocaleString()} 코인</span>
              </>
            ) : (
              <span className="dim small-text">참여하지 않음</span>
            )}
          </>
        ) : fx.status !== 'open' ? (
          <>
            <span className="dim small-text">경기 종료 후 자동 정산됩니다</span>
            {fx.myBet ? (
              <span className="fx-bet-tag">
                내 예측: {PICK_LABEL[fx.myBet.pick]}
                {fx.myBet.score ? ` (${fx.myBet.score.home}-${fx.myBet.score.away})` : ''}
              </span>
            ) : (
              <span className="dim small-text">참여하지 않음</span>
            )}
          </>
        ) : (
          <>
            {(['home', 'draw', 'away'] as BetPick[]).map((pick) => (
              <button
                key={pick}
                type="button"
                className={'btn small fx-pick' + (fx.myBet?.pick === pick ? ' picked' : '')}
                onClick={() => submit(pick)}
              >
                {PICK_LABEL[pick]}
              </button>
            ))}
            <span>
              <input
                className="fx-score-in fx-sh"
                type="number"
                min={0}
                max={9}
                placeholder="홈"
                value={sh}
                onChange={(e) => setSh(e.target.value)}
              />{' '}
              :{' '}
              <input
                className="fx-score-in fx-sa"
                type="number"
                min={0}
                max={9}
                placeholder="원정"
                value={sa}
                onChange={(e) => setSa(e.target.value)}
              />
              <span className="dim small-text">(선택) 정확한 스코어</span>
            </span>
            {fx.myBet && (
              <span className="fx-bet-tag">
                내 예측: {PICK_LABEL[fx.myBet.pick]}
                {fx.myBet.score ? ` (${fx.myBet.score.home}-${fx.myBet.score.away})` : ''}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function PredictTab() {
  const { setMe } = useAppStore();
  const [current, setCurrent] = useState<Fixture[]>([]);
  const [last, setLast] = useState<Fixture[]>([]);

  const load = async () => {
    try {
      const data = await api.get<{ current: Fixture[]; last: Fixture[] }>('/api/predictions');
      setCurrent(data.current);
      setLast(data.last);
      const { user } = await api.get<{ user: User }>('/api/me'); // 헤더 코인 갱신 (보상 반영)
      setMe(user);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div id="tab-predict" className="tab-panel">
      <div className="packs-intro dim">
        실제 리그 경기의 결과를 예측하고 코인을 받으세요 — 정확한 스코어 <b>200~350</b>(스코어가 화끈할수록 보너스) ·
        무승부 적중 <b>160</b> · 승/패 적중 <b>100</b> · 참여 <b>50</b> 코인. 킥오프 전까지 예측 가능하며 실제 경기
        종료 후 자동 정산됩니다.
      </div>
      <h3 className="predict-h">
        예정 · 진행 중인 경기{' '}
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            load();
            toast('예측 보드를 새로고침했습니다');
          }}
        >
          🔄 새로고침
        </button>
      </h3>
      <div id="predict-list">
        {!current.length ? (
          <p className="dim">실제 경기 일정을 불러오는 중입니다… 잠시 후 자동 갱신됩니다.</p>
        ) : (
          current.map((fx) => <FixtureCard key={fx.id} fx={fx} onBet={load} />)
        )}
      </div>
      <h3 className="predict-h">지난 경기 결과</h3>
      <div id="predict-last" className="dim">
        {!last.length ? (
          <p className="dim">아직 정산된 경기가 없습니다.</p>
        ) : (
          last.map((fx) => <FixtureCard key={fx.id} fx={fx} onBet={load} />)
        )}
      </div>
    </div>
  );
}
