import { useEffect, useRef, useState } from 'react';
import type { AmazonAdapter } from '../adapter/amazon';

// ---------------------------------------------------------------------------
// Thumbnails: fetched through the adapter, a few at a time, held as object URLs.

const thumbCache = new Map<string, Promise<string>>();
let active = 0;
const queue: (() => void)[] = [];

function loadThumb(id: string, adapter: () => Promise<AmazonAdapter>): Promise<string> {
  let p = thumbCache.get(id);
  if (!p) {
    p = new Promise<void>((r) => (active < 4 ? (active++, r()) : queue.push(() => (active++, r()))))
      .then(async () => URL.createObjectURL(await (await adapter()).fetchThumbnail(id)))
      .finally(() => {
        active--;
        queue.shift()?.();
      });
    p.catch(() => thumbCache.delete(id));
    thumbCache.set(id, p);
  }
  return p;
}

export function Thumb({ id, adapter }: { id: string; adapter: () => Promise<AmazonAdapter> }) {
  const [src, setSrc] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      loadThumb(id, adapter).then((u) => live && setSrc(u), () => live && setSrc('')); // '' = no preview available
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [id, adapter]);
  return (
    <div ref={ref}>
      {src ? <img className="thumb" src={src} alt="" /> : src === '' ? <div className="thumb missing">No preview</div> : <div className="thumb loading" />}
    </div>
  );
}

