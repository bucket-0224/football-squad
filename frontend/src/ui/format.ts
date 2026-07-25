// PacksTab의 이벤트 배너와 EventTab에서 종료일을 같은 형식으로 보여주기
// 위한 작은 공용 포맷터 — 컴포넌트 파일에서 export하면 Vite Fast Refresh
// 경고가 뜨므로 별도 파일로 뺐다.
export function formatEventEnd(endsAt: number): string {
  const d = new Date(endsAt);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
