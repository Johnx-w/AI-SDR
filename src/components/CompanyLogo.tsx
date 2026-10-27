import { useEffect, useState } from 'react';
import {
  companyBranding,
  logoContentBounds,
  prefersDarkLogoBackground,
} from '../services/companyBranding';
import type { CompanyMark } from '../services/companyBranding';

interface LogoState {
  identity: string;
  marks: CompanyMark[];
  index: number;
  loadedUrl: string;
  width?: number;
  height?: number;
  dark?: boolean;
  processedUrl?: string;
}

function prepareImage(image: HTMLImageElement, allowCrop: boolean) {
  let dark = false;
  try {
    const canvas = document.createElement('canvas');
    const scale = 128 / Math.max(image.naturalWidth, image.naturalHeight);
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return { dark };
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    dark = prefersDarkLogoBackground(pixels);
    const bounds = allowCrop ? logoContentBounds(pixels, canvas.width, canvas.height) : null;
    if (!bounds) return { dark };
    const crop = document.createElement('canvas');
    const outputScale = 512 / Math.max(bounds.width, bounds.height);
    crop.width = Math.max(1, Math.round(bounds.width * outputScale));
    crop.height = Math.max(1, Math.round(bounds.height * outputScale));
    const cropped = crop.getContext('2d');
    if (!cropped) return { dark };
    cropped.drawImage(
      image,
      (bounds.x / canvas.width) * image.naturalWidth,
      (bounds.y / canvas.height) * image.naturalHeight,
      (bounds.width / canvas.width) * image.naturalWidth,
      (bounds.height / canvas.height) * image.naturalHeight,
      0,
      0,
      crop.width,
      crop.height,
    );
    return { dark, processedUrl: crop.toDataURL('image/png') };
  } catch {
    // External or unsupported images may forbid pixel reads; the image still displays normally.
    return { dark };
  }
}

export function CompanyLogo({ id, name, website }: { id: string; name: string; website?: string }) {
  const identity = JSON.stringify([id, website || '', name]);
  const initial = (): LogoState => ({
    identity,
    marks: companyBranding.cached(id, identity),
    index: 0,
    loadedUrl: '',
  });
  const [state, setState] = useState<LogoState>(initial);
  const current = state.identity === identity ? state : initial();
  const mark = current.marks[current.index];
  const loaded = !!mark && current.loadedUrl === mark.url;
  useEffect(() => {
    let active = true;
    setState((previous) => (previous.identity === identity ? previous : initial()));
    companyBranding.load(id, identity).then((marks) => {
      if (!active) return;
      setState((previous) => {
        if (
          previous.identity === identity &&
          previous.marks.length === marks.length &&
          previous.marks.every((item, i) => item.url === marks[i].url)
        )
          return { ...previous, marks };
        return { identity, marks, index: 0, loadedUrl: '' };
      });
    });
    return () => {
      active = false;
    };
  }, [id, identity]);

  const next = () => {
    setState((previous) => {
      const value = previous.identity === identity ? previous : current;
      if (value.marks[value.index]?.url !== mark?.url) return value;
      return { ...value, index: value.index + 1, loadedUrl: '', processedUrl: undefined };
    });
  };
  useEffect(() => {
    if (!mark || loaded) return;
    const timer = setTimeout(next, 4500);
    return () => clearTimeout(timer);
  }, [identity, mark?.url, loaded]);

  const initials = name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('');
  return (
    <span
      className={
        'company-avatar website-brand' +
        (mark?.kind === 'website_icon' ? ' website-icon' : '') +
        (loaded &&
        (current.dark ||
          mark.background === 'dark' ||
          /white|[-_]ko[._-]/i.test(mark.sourceUrl || mark.url))
          ? ' brand-on-dark'
          : '')
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
      {!loaded && initials}
      {mark && (
        <img
          key={mark.url}
          src={current.processedUrl || mark.url}
          alt={name + (mark.kind === 'logo' ? ' Logo' : ' 网站图标')}
          loading="eager"
          decoding="async"
          referrerPolicy="no-referrer"
          style={
            loaded
              ? mark.kind === 'website_icon'
                ? {
                    width: Math.min(28, current.width || 28),
                    height: Math.min(28, current.height || 28),
                  }
                : undefined
              : { position: 'absolute', opacity: 0, width: 1, height: 1 }
          }
          onLoad={(event) => {
            if (current.processedUrl) return;
            const image = event.currentTarget;
            const { naturalWidth: width, naturalHeight: height } = image;
            if (!width || !height) return next();
            const prepared = prepareImage(
              image,
              mark.kind === 'logo' && mark.url.startsWith('/api/v1/branding/assets/'),
            );
            setState((previous) => {
              const value = previous.identity === identity ? previous : current;
              return value.marks[value.index]?.url === mark.url
                ? { ...value, loadedUrl: mark.url, width, height, ...prepared }
                : value;
            });
          }}
          onError={next}
        />
      )}
    </span>
  );
}
