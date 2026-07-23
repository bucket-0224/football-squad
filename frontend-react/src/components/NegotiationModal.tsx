import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAppStore } from '../store/useAppStore';
import PlayerCard from './PlayerCard';
import type { CatalogPlayer, User } from '../types';

interface Negotiation {
  playerId: string;
  player: CatalogPlayer;
  stage: 'club' | 'personal';
  attemptsLeft: number;
  fee: number | null;
  bonus: number | null;
  counter: number | null;
  marketValue: number;
}

interface LogLine {
  text: string;
  cls: 'sys' | 'me' | 'good' | 'bad';
}

type OfferResult = 'accepted' | 'rejected' | 'counter' | 'failed' | 'signed';

export default function NegotiationModal({ player, onClose }: { player: CatalogPlayer; onClose: () => void }) {
  const { me, setMe } = useAppStore();
  const [neg, setNeg] = useState<Negotiation | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [amount, setAmount] = useState('');
  const [ended, setEnded] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .post<{ negotiation: Negotiation; message: string }>('/api/transfer/start', { playerId: player.id })
      .then((r) => {
        if (cancelled) return;
        setNeg(r.negotiation);
        addLine(r.message, 'sys');
      })
      .catch((err) => {
        if (cancelled) return;
        addLine(err instanceof Error ? err.message : String(err), 'bad');
        setEnded(true);
      });
    return () => {
      cancelled = true;
    };
    // start the negotiation exactly once when the modal opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.id]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  function addLine(text: string, cls: LogLine['cls']) {
    setLog((l) => [...l, { text, cls }]);
  }

  const submitOffer = async () => {
    const amt = Number(amount);
    if (!amt || amt <= 0) return;
    addLine(`🪙 ${amt.toLocaleString()} 제시`, 'me');
    setAmount('');
    try {
      const r = await api.post<{
        negotiation: Negotiation | null;
        result: OfferResult;
        message: string;
        user?: User;
      }>('/api/transfer/offer', { amount: amt });
      setNeg(r.negotiation);
      if (r.result === 'signed') {
        addLine(r.message, 'good');
        if (r.user) setMe(r.user);
        setEnded(true);
      } else if (r.result === 'failed') {
        addLine(r.message, 'bad');
        setEnded(true);
      } else {
        addLine(r.message, r.result === 'accepted' ? 'good' : r.result === 'rejected' ? 'bad' : 'sys');
      }
    } catch (err) {
      addLine(err instanceof Error ? err.message : String(err), 'bad');
    }
  };

  const close = () => {
    if (!ended) api.post('/api/transfer/cancel').catch(() => {});
    onClose();
  };

  const partyName = !neg
    ? ''
    : neg.stage === 'club'
      ? player.team
        ? `${player.team} 구단`
        : `${player.name} 측 (바이아웃)`
      : `${player.name} 에이전트`;
  const feeLabel = player.team ? '이적료' : '바이아웃';

  return (
    <div
      id="nego-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="nego-modal">
        <div className="picker-head">
          <span>이적 협상</span>
          <button type="button" className="btn ghost small" onClick={close}>
            ✕
          </button>
        </div>
        <div className="nego-body">
          <div id="nego-card-col">
            <PlayerCard player={player} size="md" stats />
          </div>
          <div className="nego-main">
            <div id="nego-stagebar">
              <span id="nego-stage-club" className={'nego-stage' + statusClass(neg, 'club')}>
                {player.team ? '🏟 구단 합의' : '💰 바이아웃'}
              </span>
              <span className="nego-arrow">→</span>
              <span id="nego-stage-personal" className={'nego-stage' + statusClass(neg, 'personal')}>
                🤝 개인 합의
              </span>
            </div>
            <div id="nego-party">
              {neg?.stage === 'club' && player.team && player.teamLogo ? <img src={player.teamLogo} alt="" /> : null}
              <span>{partyName}</span>
            </div>
            <div id="nego-log" ref={logRef}>
              {log.map((l, i) => (
                <div key={i} className={'nego-line ' + l.cls}>
                  {l.text}
                </div>
              ))}
            </div>
            <div className="nego-offer-row">
              <input
                id="nego-amount"
                type="number"
                min={0}
                step={10}
                placeholder="제시 금액"
                value={amount}
                disabled={ended || !neg}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitOffer();
                }}
              />
              <button type="button" className="btn primary" disabled={ended || !neg} onClick={submitOffer}>
                제시
              </button>
            </div>
            <div id="nego-info" className="dim small-text">
              {neg &&
                `시장 가치 🪙${neg.marketValue.toLocaleString()}${
                  neg.fee ? ` · 합의된 ${feeLabel} 🪙${neg.fee.toLocaleString()}` : ''
                } · 남은 시도 ${'●'.repeat(neg.attemptsLeft)}${'○'.repeat(3 - neg.attemptsLeft)} · 보유 🪙${(me?.coins || 0).toLocaleString()}`}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function statusClass(neg: Negotiation | null, stage: 'club' | 'personal'): string {
  if (!neg) return '';
  if (neg.stage === stage) return ' active';
  if (stage === 'club' && neg.stage === 'personal') return ' done';
  return '';
}
