import { useToastStore } from '../store/useToastStore';

export default function Toast() {
  const message = useToastStore((s) => s.message);
  return <div id="toast" className={message ? '' : 'hidden'}>{message}</div>;
}
