import { useEffect, useRef, useState } from 'react';

interface CountUpProps {
  value: number;
  durationMs?: number;
  formatter?: (n: number) => string;
  className?: string;
}

// 코인/승점/OVR처럼 자주 바뀌는 숫자에 카운트업 애니메이션을 준다. 최초
// 마운트 시엔 애니메이션 없이 바로 스냅한다(페이지를 열 때마다 모든 숫자가
// 0에서부터 올라가면 불필요하고 산만하다) — 이후 값이 실제로 바뀔 때만
// 이전 값에서 새 값까지 ease-out으로 올라간다.
export default function CountUp({ value, durationMs = 600, formatter, className }: CountUpProps) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const mountedRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      fromRef.current = value;
      setDisplay(value);
      return;
    }
    if (value === fromRef.current) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const reducedMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const from = fromRef.current;
    const to = value;
    if (reducedMotion) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return <span className={className}>{formatter ? formatter(display) : display}</span>;
}
