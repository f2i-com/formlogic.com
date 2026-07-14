import { useEffect } from 'react';

/**
 * The landing page's display/mono/grid/reveal chrome, shared by the public
 * marketplace pages so /packs feels like the same product as /.
 *
 * Fonts reuse Landing.tsx's link element id (same href, so whichever public
 * page loads first fetches the stylesheet once). Styles get their OWN element
 * id: Docs.tsx injects a SUBSET of the landing rules under the landing id, so
 * reusing that id here could leave the marketplace without .fl-grid/.fl-reveal
 * when the user visits /docs first. Duplicate identical rules are harmless.
 */
export function useMarketplaceChrome() {
  useEffect(() => {
    if (!document.getElementById('fl-landing-fonts')) {
      const link = document.createElement('link');
      link.id = 'fl-landing-fonts';
      link.rel = 'stylesheet';
      link.href =
        'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=JetBrains+Mono:wght@400;500;600&display=swap';
      document.head.appendChild(link);
    }
    if (!document.getElementById('fl-market-styles')) {
      const style = document.createElement('style');
      style.id = 'fl-market-styles';
      style.textContent = `
        .fl-display{font-family:'Bricolage Grotesque','Plus Jakarta Sans',system-ui,sans-serif;font-weight:800;letter-spacing:-0.035em;line-height:1.04;}
        .fl-mono{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;}
        .fl-grad{background-image:linear-gradient(102deg,rgb(var(--primary-700)),rgb(var(--primary-500)) 52%,rgb(var(--primary-700)));-webkit-background-clip:text;background-clip:text;color:transparent;}
        :root.dark .fl-grad{background-image:linear-gradient(102deg,rgb(var(--primary-300)),rgb(var(--primary-400)) 48%,rgb(var(--primary-200)));}
        .fl-grid{background-image:linear-gradient(rgb(var(--primary-500)/0.09) 1px,transparent 1px),linear-gradient(90deg,rgb(var(--primary-500)/0.09) 1px,transparent 1px);background-size:54px 54px;}
        .fl-reveal{opacity:0;transform:translateY(26px);transition:opacity .8s cubic-bezier(.16,1,.3,1),transform .8s cubic-bezier(.16,1,.3,1);}
        .fl-reveal.fl-in{opacity:1;transform:none;}
        @media (prefers-reduced-motion:reduce){.fl-reveal{opacity:1!important;transform:none!important;transition:none!important}}
      `;
      document.head.appendChild(style);
    }
  }, []);
}

/**
 * Reveal-on-scroll: add `.fl-in` to every [data-reveal] element when it enters
 * the viewport (same behavior as Landing.tsx). Only apply data-reveal to
 * elements present at mount — content that renders later is never observed and
 * would stay invisible.
 */
export function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (els.length === 0) return;
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('fl-in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('fl-in');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -48px 0px' }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}
