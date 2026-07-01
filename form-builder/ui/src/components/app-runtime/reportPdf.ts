import type { AppReport, AppReportResult } from '../../types/app';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const fmt = (n: unknown): string => {
  const v = Number(n || 0);
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

/**
 * Export a report to PDF via a clean, self-contained print window (browser "Save as PDF"). Isolated
 * from the SPA so there's no print-CSS conflict; charts render as labelled bars that print reliably.
 */
export function exportReportPdf(report: AppReport, result: AppReportResult, appName: string): boolean {
  let body = '';
  if (result.viz === 'kpi') {
    body = `<div class="kpi">${fmt(result.value)}</div>`;
  } else if ((result.viz === 'bar' || result.viz === 'pie') && result.series) {
    const max = Math.max(1, ...result.series.map((s) => s.value));
    body = `<table class="t"><tbody>${result.series
      .map(
        (s) =>
          `<tr><td>${esc(s.label)}</td><td class="barcell"><div class="bar" style="width:${Math.max(2, Math.round((s.value / max) * 100))}%"></div></td><td class="num">${fmt(s.value)}</td></tr>`
      )
      .join('')}</tbody></table>`;
  } else {
    const cols = result.columns ?? [];
    body = `<table class="t"><thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${(result.rows ?? [])
      .map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c.id])}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`;
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(report.name)}</title><style>
    body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#111827;margin:32px;}
    h1{font-size:20px;margin:0 0 4px;} .sub{color:#6b7280;font-size:13px;margin:0 0 6px;}
    .meta{color:#9ca3af;font-size:11px;margin:0 0 20px;}
    .kpi{font-size:56px;font-weight:800;letter-spacing:-.02em;}
    table.t{border-collapse:collapse;width:100%;font-size:13px;}
    .t th,.t td{border-bottom:1px solid #e5e7eb;padding:8px 10px;text-align:left;vertical-align:middle;}
    .t th{color:#6b7280;font-weight:600;}
    .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;} .barcell{width:55%;}
    .bar{height:10px;border-radius:5px;background:#6366f1;min-width:2px;}
    @media print{body{margin:12mm;}}
  </style></head><body>
    <h1>${esc(report.name)}</h1>${report.description ? `<p class="sub">${esc(report.description)}</p>` : ''}
    <p class="meta">${esc(appName)} &middot; generated ${esc(new Date().toLocaleString())}</p>
    ${body}
    <script>window.onload=function(){setTimeout(function(){window.print();},150);};</script>
  </body></html>`;

  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  return true;
}
