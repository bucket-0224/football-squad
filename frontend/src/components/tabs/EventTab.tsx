import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../../store/useToastStore';
import { formatEventEnd } from '../../ui/format';
import type { EventGrid } from '../../types';

export default function EventTab() {
  const { bootstrap, fetchEventGrid, buyEventKey, openEventCell } = useAppStore();
  const [grid, setGrid] = useState<EventGrid | null>(null);
  const [busy, setBusy] = useState(false);

  // 요청: "이런건 유동적으로 변경될 것으로 비활성화 시키기" — active인 이벤트만
  // 다룬다. 지금은 하나뿐이지만 나중에 여러 이벤트가 동시에 존재할 수도
  // 있으니 첫 번째 활성 이벤트를 기본으로 보여준다.
  const activeEvent = bootstrap?.events?.find((e) => e.active) || null;
  const eventId = activeEvent?.id;

  useEffect(() => {
    if (!eventId) return;
    fetchEventGrid(eventId)
      .then(setGrid)
      .catch((err) => toast(err instanceof Error ? err.message : String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  if (!bootstrap) return null;

  if (!activeEvent) {
    return (
      <div id="tab-event" className="tab-panel">
        <p className="dim">진행 중인 이벤트가 없습니다.</p>
      </div>
    );
  }

  const buyKey = async (count: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await buyEventKey(activeEvent.id, count);
      toast(`열쇠 ${count}개를 구매했습니다.`);
      setGrid(await fetchEventGrid(activeEvent.id));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openCell = async (index: number) => {
    if (busy || !grid) return;
    if (grid.keys < 1) {
      toast('열쇠가 부족합니다. 먼저 열쇠를 구매하세요.');
      return;
    }
    setBusy(true);
    try {
      const { grade, grid: nextGrid, reset } = await openEventCell(activeEvent.id, index);
      setGrid(nextGrid);
      if (reset) {
        toast(`🎉 ${grade}급 보상 획득! 그리드가 새로 초기화되었습니다.`);
      } else {
        toast(`${grade}급 보상 획득! 우편함에서 수령하면 확인할 수 있습니다.`);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="tab-event" className="tab-panel">
      <div className="event-banner">
        <div className="event-banner-title">🔥 {activeEvent.name}</div>
        <div className="event-banner-sub">
          {formatEventEnd(activeEvent.endsAt)}까지 진행 · 열쇠로 그리드를 열어 보상을 받으세요
        </div>
      </div>
      <div className="event-key-count">🔑 보유 열쇠 {grid?.keys ?? 0}개</div>
      {/* 요청: "열쇠 구매를 약간 아이템 컴포넌트를 재활용해서 해당 이미지를
          삽입해줘" — 구매(PacksTab)의 팩 목록과 같은 .pack-tile 구조
          (이미지/이름·설명·가격/버튼)를 그대로 재사용했다. */}
      <div className="pack-tile pack-event-key">
        <img className="pk-img" src="/img/event/key.png" alt="" />
        <div className="pk-info">
          <span className="pk-name">🔑 럭키 열쇠</span>
          <span className="pk-desc">그리드 한 칸을 열 수 있는 이벤트 한정 열쇠</span>
          <span className="pk-price">🪙 {activeEvent.keyPrice.toLocaleString()}</span>
        </div>
        <div className="pk-actions">
          <button type="button" className="btn small primary" disabled={busy} onClick={() => buyKey(1)}>
            1개 구매
          </button>
          <button type="button" className="btn small" disabled={busy} onClick={() => buyKey(5)}>
            5개 🪙{(activeEvent.keyPrice * 5).toLocaleString()}
          </button>
        </div>
      </div>
      <div className="event-grid" style={{ gridTemplateColumns: `repeat(${activeEvent.cols}, 1fr)` }}>
        {grid?.cells.map((cell) => (
          <button
            type="button"
            key={cell.index}
            className={
              'event-cell' + (cell.opened ? ' opened' : '') + (cell.grade ? ` event-grade-${cell.grade}` : '')
            }
            disabled={busy || cell.opened}
            onClick={() => openCell(cell.index)}
          >
            {cell.opened ? cell.grade : '?'}
          </button>
        ))}
      </div>
      <p className="dim small-text">
        칸을 열면 보상이 우편함으로 전송됩니다 — 우편함에서 수령하면 무엇을 받았는지 바로 확인할 수 있습니다.
      </p>
    </div>
  );
}
