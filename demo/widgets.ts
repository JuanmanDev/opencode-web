// MCP UI widgets of the demo's `ui-demo` server, rendered in the browser
// (the real app gets them from its /mcp-demo server).

const SIZER = `<script>
parent.postMessage({type:'ui-lifecycle-iframe-ready'},'*');
const post=()=>parent.postMessage({type:'ui-size-change',payload:{height:Math.ceil(document.documentElement.getBoundingClientRect().height)}},'*');
addEventListener('load',post);new ResizeObserver(post).observe(document.documentElement);
<\/script>`

const BASE_CSS = `<style>
:root{color-scheme:dark}
body{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#17171a;color:#d4d4dc;padding:16px}
h2{margin:0 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#8f8f99;font-weight:500}
.dim{color:#6b6b74;font-size:11px}
</style>`

function esc(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function page(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${BASE_CSS}${html}${SIZER}</body></html>`
}

function series(seed: string, n = 48, base = 1.08) {
  let h = 7
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const out: number[] = []
  let v = base
  for (let i = 0; i < n; i++) {
    h = (h * 1103515245 + 12345) >>> 0
    v += ((h % 1000) / 1000 - 0.48) * base * 0.004
    out.push(v)
  }
  return out
}

/** Tools of the demo `ui-demo` MCP server, as discovery lists them. */
export const UI_DEMO_TOOLS = [
  { name: 'show_metric', description: 'Show a big metric/target card (value, label, optional change %)', ui: true, readOnly: true },
  { name: 'show_weather', description: 'Show a weather card for a location', ui: true, readOnly: true },
  { name: 'show_forex', description: 'Plot a currency pair over the last 48 hours', ui: true, readOnly: true },
  { name: 'show_background', description: 'A card whose background the user can recolor', ui: true, readOnly: true }
]

/** HTML of a widget, or undefined for unknown tools. */
export function renderWidget(tool: string, args: Record<string, any>): { html: string; title: string } | undefined {
  switch (tool) {
    case 'show_metric': {
      const change = typeof args.change === 'number' ? args.change : undefined
      const up = (change ?? 0) >= 0
      return {
        title: 'ui://opencode-web-demo/metric',
        html: page(`
          <h2>${esc(args.label || 'Metric')}</h2>
          <div style="font-size:44px;font-weight:600;color:#fafafa;line-height:1.2">${esc(args.value)}<span style="font-size:18px;color:#8f8f99"> ${esc(args.unit || '')}</span></div>
          ${change !== undefined ? `<div style="display:flex;gap:6px;margin-top:4px;font-size:13px;color:${up ? '#4ade80' : '#f87171'}"><span>${up ? '▲' : '▼'}</span><span>${up ? '+' : ''}${change}%</span><span class="dim">vs previous</span></div>` : ''}`)
      }
    }
    case 'show_weather': {
      const icons: Record<string, string> = { sunny: '☀️', cloudy: '☁️', rain: '🌧️', storm: '⛈️', snow: '❄️' }
      const condition = String(args.condition || 'sunny')
      return {
        title: 'ui://opencode-web-demo/weather',
        html: page(`
          <div style="display:flex;align-items:center;gap:16px">
            <div style="font-size:52px;line-height:1">${icons[condition] || '☀️'}</div>
            <div>
              <h2>${esc(args.location || 'Salamanca')}</h2>
              <div style="font-size:34px;font-weight:600;color:#fafafa">${esc(args.temperature ?? 24)}°C</div>
              <div class="dim">${esc(condition)} · humidity ${esc(args.humidity ?? 40)}% · wind ${esc(args.wind ?? 8)} km/h</div>
            </div>
          </div>`)
      }
    }
    case 'show_forex': {
      const pair = String(args.pair || 'EUR/USD')
      const points = series(pair)
      const min = Math.min(...points)
      const max = Math.max(...points)
      const W = 560
      const H = 160
      const x = (i: number) => 8 + (i / (points.length - 1)) * (W - 16)
      const y = (v: number) => 8 + (1 - (v - min) / (max - min || 1)) * (H - 16)
      const d = points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
      const last = points[points.length - 1]!
      const pct = (((last - points[0]!) / points[0]!) * 100).toFixed(2)
      return {
        title: 'ui://opencode-web-demo/forex',
        html: page(`
          <h2>${esc(pair)} — last 48h (demo)</h2>
          <div style="display:flex;align-items:baseline;gap:10px;margin:2px 0 8px">
            <span style="font-size:26px;font-weight:600;color:#fafafa">${last.toFixed(4)}</span>
            <span style="font-size:12px;color:${Number(pct) >= 0 ? '#4ade80' : '#f87171'}">${Number(pct) >= 0 ? '+' : ''}${pct}%</span>
          </div>
          <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
            <line x1="8" y1="${H - 8}" x2="${W - 8}" y2="${H - 8}" stroke="#26262b"/>
            <path d="${d}" fill="none" stroke="#5b8def" stroke-width="2" stroke-linejoin="round"/>
          </svg>
          <div class="dim" style="display:flex;justify-content:space-between"><span>-48h</span><span>now</span></div>`)
      }
    }
    case 'show_background': {
      const options = [
        { label: 'Sunset', color: '#f97316' }, { label: 'Ocean', color: '#0ea5e9' }, { label: 'Forest', color: '#16a34a' }
      ]
      return {
        title: 'ui://opencode-web-demo/background',
        html: page(`
          <div id="bg" style="border-radius:6px;padding:24px;transition:background 1s ease;background:linear-gradient(120deg,#f97316,#0ea5e9,#16a34a);background-size:300% 300%">
            <h2 style="color:#fff9">Dynamic background</h2>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
              ${options.map((o) => `<button onclick="document.getElementById('bg').style.background='${o.color}'" style="cursor:pointer;border:none;border-radius:4px;padding:6px 10px;font:inherit;font-size:12px;background:#0007;color:#fff">${o.label}</button>`).join('')}
            </div>
          </div>`)
      }
    }
    default:
      return undefined
  }
}
