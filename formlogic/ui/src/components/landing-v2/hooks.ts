import { useEffect, useLayoutEffect } from 'react';

/** Align a bookmarked section after React mounts and as the two demo lists arrive. */
export function useLandingFragment() {
  useLayoutEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    const align = () => document.getElementById(id)?.scrollIntoView?.({ behavior: 'instant' });
    align();
    const observer = new MutationObserver(align);
    document.querySelectorAll('.lv2-demo-band').forEach(band => observer.observe(band, { childList: true }));
    const controller = new AbortController();
    const stop = () => { observer.disconnect(); controller.abort(); };
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown', 'hashchange']) {
      window.addEventListener(event, stop, { signal: controller.signal, passive: true });
    }
    return stop;
  }, []);
}

/**
 * Landing-v2 chrome: the marketing page's display face (Geist + Geist Mono),
 * injected on mount so the rest of the app never pays for marketing-only
 * fonts (same pattern the previous landing used for its fonts).
 */
export function useLandingFonts() {
  useEffect(() => {
    if (document.getElementById('lv2-fonts')) return;
    const link = document.createElement('link');
    link.id = 'lv2-fonts';
    link.rel = 'stylesheet';
    link.href =
      'https://fonts.googleapis.com/css2?family=Geist:wght@300..800&family=Geist+Mono:wght@400..700&display=swap';
    document.head.appendChild(link);
  }, []);
}

/**
 * Reveal-on-scroll: adds `.lv2-in` to every [data-reveal] element as it
 * enters the viewport. Falls back to instantly visible without
 * IntersectionObserver or with reduced motion preferred.
 */
export function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('.lv2 [data-reveal]'));
    if (els.length === 0) return;
    if (
      !('IntersectionObserver' in window) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      els.forEach((el) => el.classList.add('lv2-in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('lv2-in');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -32px 0px' }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}
