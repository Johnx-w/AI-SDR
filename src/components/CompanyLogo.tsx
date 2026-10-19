import { useEffect, useState } from 'react';
import { Avatar } from './ui';

interface Mark {
  url: string;
  kind: 'logo' | 'website_icon';
  provider?: string;
}
const requests = new Map<string, Promise<Mark[]>>();
export function CompanyLogo({ id, name, real }: { id: string; name: string; real: boolean }) {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setMarks([]);
    setIndex(0);
    if (!real) return;
    let active = true;
    if (!requests.has(id))
      requests.set(
        id,
        fetch('/api/v1/leads/real/' + encodeURIComponent(id) + '/branding')
          .then((r) => (r.ok ? r.json() : { candidates: [] }))
          .then((r) => r.candidates)
          .catch(() => {
            requests.delete(id);
            return [];
          }),
      );
    requests.get(id)!.then((candidates) => {
      if (active) setMarks(candidates);
    });
    return () => {
      active = false;
    };
  }, [id, real]);
  const mark = marks[index];
  if (!real)
    return (
      <Avatar
        lead={{
          initials: name
            .split(' ')
            .map((s) => s[0])
            .slice(0, 2)
            .join(''),
          color: 'sage',
        }}
      />
    );
  return (
    <span
      className={
        'company-avatar website-brand' +
        (mark?.kind === 'website_icon' ? ' website-icon' : '') +
        (mark && /white|[-_]ko[._-]/i.test(mark.url) ? ' brand-on-dark' : '')
      }
      title={
        mark
          ? mark.kind === 'logo'
            ? '官网品牌 Logo'
            : mark.provider
              ? '网站图标 · ' + mark.provider
              : '官网网站图标'
          : name
      }
    >
      {mark ? (
        <img
          key={mark.url}
          src={mark.url}
          alt={name + (mark.kind === 'logo' ? ' Logo' : ' 网站图标')}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setIndex((i) => i + 1)}
        />
      ) : (
        name
          .split(' ')
          .map((s) => s[0])
          .slice(0, 2)
          .join('')
      )}
    </span>
  );
}
