import type { CatalogPlayer } from '../types';
import { tierOf } from '../game/cards';

export const PLACEHOLDER_IMG = '/img/players/_placeholder.svg';

export type CardSize = 'xs' | 'sm' | 'md';

interface PlayerCardProps {
  player: CatalogPlayer;
  size: CardSize;
  stats?: boolean;
  flag?: string;
  badge?: string;
}

export default function PlayerCard({ player: p, size, stats, flag, badge }: PlayerCardProps) {
  const img = p.img || PLACEHOLDER_IMG;
  const isRemote = /^https?:/.test(img);
  return (
    <div className={`fut-card sz-${size} ${tierOf(p)}`}>
      {flag ? <span className="fc-flag">{flag}</span> : null}
      {badge ? <span className="fc-cap-badge">{badge}</span> : null}
      <div className="fc-head">
        <span className="fc-ovr">{p.ovr}</span>
        <span className="fc-pos">{p.pos}</span>
        {p.teamLogo ? (
          <img
            className="fc-club"
            src={p.teamLogo}
            alt=""
            loading="lazy"
            onError={(e) => e.currentTarget.remove()}
          />
        ) : null}
        {p.flag ? <span className="fc-nat">{p.flag}</span> : null}
        {p.up ? <span className="fc-up">+{p.up}</span> : null}
      </div>
      <div className="fc-photo">
        <img
          className={'fc-img' + (isRemote ? ' remote' : '')}
          src={img}
          alt=""
          loading="lazy"
          onError={(e) => {
            const el = e.currentTarget;
            el.onerror = null;
            el.classList.remove('remote');
            el.src = PLACEHOLDER_IMG;
          }}
        />
      </div>
      <div className="fc-name">{p.name}</div>
      {stats && p.attrs ? (
        <div className="fc-stats">
          <span>
            <b>{p.attrs.pace}</b> PAC
          </span>
          <span>
            <b>{p.attrs.shooting}</b> SHO
          </span>
          <span>
            <b>{p.attrs.passing}</b> PAS
          </span>
          <span>
            <b>{p.attrs.dribbling}</b> DRI
          </span>
          <span>
            <b>{p.attrs.defending}</b> DEF
          </span>
          <span>
            <b>{p.attrs.physical}</b> PHY
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function EmptySlotCard({ pos }: { pos: string }) {
  return (
    <div className="fut-card sz-xs empty">
      <span className="fc-plus">+</span>
      <span className="fc-pos-label">{pos}</span>
    </div>
  );
}
