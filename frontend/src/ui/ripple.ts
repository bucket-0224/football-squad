// Material 스타일 리플 효과 — 버튼마다 핸들러를 다는 대신, document 루트에
// 한 번만 리스너를 걸고 클릭 지점이 .btn/탭 버튼 안쪽인지 closest()로 찾아
// 그 요소 기준 좌표에 원을 하나 그려 넣는 방식이다. 카드/리스트 행처럼
// 배지가 테두리 밖으로 살짝 나오게 디자인된 요소(overflow 필요)는 대상에서
// 제외 — 버튼류만 겨냥한다.
const RIPPLE_SELECTOR = '.btn, #main-tabs button, #squad-mode button, .sub-tabs button, .pack-tile';

export function initRipple() {
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 && e.button !== undefined) return;
      const target = (e.target as HTMLElement).closest<HTMLElement>(RIPPLE_SELECTOR);
      if (!target || target.hasAttribute('disabled')) return;
      const rect = target.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height) * 2;
      const span = document.createElement('span');
      span.className = 'ripple-effect';
      span.style.width = `${size}px`;
      span.style.height = `${size}px`;
      span.style.left = `${e.clientX - rect.left - size / 2}px`;
      span.style.top = `${e.clientY - rect.top - size / 2}px`;
      target.appendChild(span);
      span.addEventListener('animationend', () => span.remove());
    },
    { passive: true }
  );
}
