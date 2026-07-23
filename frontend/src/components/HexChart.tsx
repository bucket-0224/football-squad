import type { PlayerAttrs } from '../types';

const HEX_ATTRS: [keyof PlayerAttrs, string][] = [
  ['pace', 'PAC'],
  ['shooting', 'SHO'],
  ['passing', 'PAS'],
  ['dribbling', 'DRI'],
  ['defending', 'DEF'],
  ['physical', 'PHY'],
];

export default function HexChart({ attrs }: { attrs?: PlayerAttrs }) {
  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2 - 30;
  const n = HEX_ATTRS.length;
  const angleFor = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i: number, r: number): [number, number] => {
    const a = angleFor(i);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const dataPts = HEX_ATTRS.map(([key], i) => {
    const v = Math.max(0, Math.min(99, attrs?.[key] || 0));
    return pt(i, (v / 99) * maxR).join(',');
  }).join(' ');

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="hex-chart" role="img" aria-label="선수 능력치 육각형 차트">
      {[0.25, 0.5, 0.75, 1].map((frac, ri) => (
        <polygon
          key={ri}
          points={HEX_ATTRS.map((_, i) => pt(i, maxR * frac).join(',')).join(' ')}
          fill="none"
          stroke="var(--border)"
          strokeWidth={1}
        />
      ))}
      {HEX_ATTRS.map(([key], i) => {
        const [x, y] = pt(i, maxR);
        return <line key={key} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--border)" strokeWidth={1} />;
      })}
      <polygon points={dataPts} fill="var(--blue)" fillOpacity={0.32} stroke="var(--blue)" strokeWidth={2} strokeLinejoin="round" />
      {HEX_ATTRS.map(([key, label], i) => {
        const [x, y] = pt(i, maxR + 18);
        return (
          <text key={key} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="hex-label">
            {label} {attrs?.[key] || 0}
          </text>
        );
      })}
    </svg>
  );
}
