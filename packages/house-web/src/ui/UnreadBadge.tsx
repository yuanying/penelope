export function UnreadBadge({ count }: { count: number }) {
  return count > 0 ? <span className="unread" aria-hidden>{count > 99 ? "99+" : count}</span> : null;
}
