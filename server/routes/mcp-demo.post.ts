// Built-in demo MCP server showcasing MCP-UI apps: tools return ui:// HTML
// resources that the chat renders live in sandboxed iframes.
// Add it to opencode as: { "type": "remote", "url": "http://<this-app>/mcp-demo" }

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, any>
}

const SIZER = `<script>
const post=()=>parent.postMessage({type:'ui-size-change',payload:{height:document.documentElement.scrollHeight}},'*');
addEventListener('load',post);new ResizeObserver(post).observe(document.documentElement);
<\/script>`

const BASE_CSS = `<style>
:root{color-scheme:dark}
body{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#17171a;color:#d4d4dc;padding:16px}
h2{margin:0 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#8f8f99;font-weight:500}
.dim{color:#6b6b74;font-size:11px}
</style>`

function uiResource(name: string, html: string, textFallback: string) {
  return {
    content: [
      { type: 'text', text: textFallback },
      {
        type: 'resource',
        resource: {
          uri: `ui://opencode-web-demo/${name}`,
          mimeType: 'text/html',
          text: `${BASE_CSS}${html}${SIZER}`
        }
      }
    ]
  }
}

// deterministic pseudo-series so the same pair always draws the same curve
function seededSeries(seed: string, n = 48, base = 1.08) {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const points: number[] = []
  let value = base
  for (let i = 0; i < n; i++) {
    h = (h * 1103515245 + 12345) >>> 0
    value += ((h % 1000) / 1000 - 0.5) * base * 0.004
    points.push(value)
  }
  return points
}

const TOOLS = [
  {
    name: 'show_metric',
    description: 'Show a big metric/target card (value, label, optional change %).',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        value: { type: 'string' },
        unit: { type: 'string' },
        change: { type: 'number', description: 'percent change, e.g. 12.5 or -3.2' }
      },
      required: ['label', 'value']
    }
  },
  {
    name: 'show_background',
    description: 'Show an animated background picker from a list of options with colors.',
    inputSchema: {
      type: 'object',
      properties: {
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, color: { type: 'string' } },
            required: ['label', 'color']
          }
        }
      },
      required: ['options']
    }
  },
  {
    name: 'show_forex',
    description: 'Show a forex rate line chart for a currency pair (demo data).',
    inputSchema: {
      type: 'object',
      properties: {
        pair: { type: 'string', description: 'e.g. EUR/USD' },
        base: { type: 'number', description: 'base rate, default 1.08' }
      }
    }
  },
  {
    name: 'show_weather',
    description: 'Show a weather card (demo).',
    inputSchema: {
      type: 'object',
      properties: {
        location: { type: 'string' },
        temperature: { type: 'number' },
        condition: { type: 'string', enum: ['sunny', 'cloudy', 'rain', 'storm', 'snow'] },
        humidity: { type: 'number' },
        wind: { type: 'number' }
      }
    }
  }
]

function callTool(name: string, args: Record<string, any>) {
  switch (name) {
    case 'show_metric': {
      const change = typeof args.change === 'number' ? args.change : undefined
      const up = (change ?? 0) >= 0
      return uiResource('metric', `
        <h2>${esc(args.label)}</h2>
        <div style="font-size:44px;font-weight:600;color:#fafafa;line-height:1.2">
          ${esc(args.value)}<span style="font-size:18px;color:#8f8f99"> ${esc(args.unit || '')}</span>
        </div>
        ${change !== undefined ? `
        <div style="display:flex;align-items:center;gap:6px;margin-top:4px;font-size:13px;color:${up ? '#4ade80' : '#f87171'}">
          <span>${up ? '▲' : '▼'}</span><span>${up ? '+' : ''}${change}%</span>
          <span class="dim">vs previous</span>
        </div>` : ''}`,
        `${args.label}: ${args.value}${args.unit || ''}${change !== undefined ? ` (${change}%)` : ''}`)
    }
    case 'show_background': {
      const options: Array<{ label: string; color: string }> = Array.isArray(args.options) ? args.options : []
      const colors = options.map((o) => o.color).join(',')
      return uiResource('background', `
        <div id="bg" style="border-radius:6px;padding:24px;transition:background 1s ease;background:linear-gradient(120deg,${esc(colors || '#333,#555')});background-size:300% 300%;animation:sway 8s ease infinite">
          <h2 style="color:#fff9">Dynamic background</h2>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
            ${options.map((o) => `
              <button onclick="document.getElementById('bg').style.background='${esc(o.color)}'"
                style="cursor:pointer;border:none;border-radius:4px;padding:6px 10px;font:inherit;font-size:12px;background:#0007;color:#fff">
                <span style="display:inline-block;width:8px;height:8px;border-radius:99px;background:${esc(o.color)};margin-right:6px"></span>${esc(o.label)}
              </button>`).join('')}
          </div>
        </div>
        <style>@keyframes sway{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}</style>`,
        `Background options: ${options.map((o) => o.label).join(', ')}`)
    }
    case 'show_forex': {
      const pair = String(args.pair || 'EUR/USD')
      const points = seededSeries(pair, 48, Number(args.base) || 1.08)
      const min = Math.min(...points)
      const max = Math.max(...points)
      const W = 560; const H = 180; const PAD = 8
      const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2)
      const y = (v: number) => PAD + (1 - (v - min) / (max - min || 1)) * (H - PAD * 2)
      const path = points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
      const last = points[points.length - 1]!
      const first = points[0]!
      const pct = (((last - first) / first) * 100).toFixed(2)
      return uiResource('forex', `
        <h2>${esc(pair)} — last 48h (demo)</h2>
        <div style="display:flex;align-items:baseline;gap:10px;margin:2px 0 8px">
          <span style="font-size:26px;font-weight:600;color:#fafafa">${last.toFixed(4)}</span>
          <span style="font-size:12px;color:${Number(pct) >= 0 ? '#4ade80' : '#f87171'}">${Number(pct) >= 0 ? '+' : ''}${pct}%</span>
        </div>
        <div style="position:relative">
          <svg id="chart" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
            <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="#26262b"/>
            <line x1="${PAD}" y1="${PAD}" x2="${W - PAD}" y2="${PAD}" stroke="#1d1d21"/>
            <path d="${path}" fill="none" stroke="#5b8def" stroke-width="2" stroke-linejoin="round"/>
            <line id="cross" y1="${PAD}" y2="${H - PAD}" stroke="#34343a" stroke-dasharray="3 3" visibility="hidden"/>
            <circle id="dot" r="4" fill="#5b8def" stroke="#17171a" stroke-width="2" visibility="hidden"/>
          </svg>
          <div id="tip" style="position:absolute;pointer-events:none;visibility:hidden;background:#232327;border-radius:4px;padding:4px 8px;font-size:11px;color:#d4d4dc;white-space:nowrap"></div>
        </div>
        <div class="dim" style="display:flex;justify-content:space-between"><span>-48h</span><span>now</span></div>
        <script>
          const P=${JSON.stringify(points.map((v, i) => [Number(x(i).toFixed(1)), Number(y(v).toFixed(1)), Number(v.toFixed(4))]))};
          const svg=document.getElementById('chart'),tip=document.getElementById('tip'),
                cross=document.getElementById('cross'),dot=document.getElementById('dot');
          svg.addEventListener('mousemove',(e)=>{
            const r=svg.getBoundingClientRect();
            const mx=(e.clientX-r.left)/r.width*${W};
            let best=P[0];for(const p of P){if(Math.abs(p[0]-mx)<Math.abs(best[0]-mx))best=p}
            cross.setAttribute('x1',best[0]);cross.setAttribute('x2',best[0]);cross.setAttribute('visibility','visible');
            dot.setAttribute('cx',best[0]);dot.setAttribute('cy',best[1]);dot.setAttribute('visibility','visible');
            tip.textContent='${esc(pair)} '+best[2];
            tip.style.left=(best[0]/${W}*r.width+10)+'px';tip.style.top=(best[1]/${H}*r.height-10)+'px';
            tip.style.visibility='visible';
          });
          svg.addEventListener('mouseleave',()=>{for(const el of [cross,dot])el.setAttribute('visibility','hidden');tip.style.visibility='hidden'});
        <\/script>`,
        `${pair}: ${last.toFixed(4)} (${pct}% over demo window)`)
    }
    case 'show_weather': {
      const condition = String(args.condition || 'sunny')
      const icons: Record<string, string> = { sunny: '☀️', cloudy: '☁️', rain: '🌧️', storm: '⛈️', snow: '❄️' }
      const temp = args.temperature ?? 24
      const location = String(args.location || 'Salamanca')
      return uiResource('weather', `
        <div style="display:flex;align-items:center;gap:16px">
          <div style="font-size:52px;line-height:1">${icons[condition] || '☀️'}</div>
          <div>
            <h2>${esc(location)}</h2>
            <div style="font-size:34px;font-weight:600;color:#fafafa">${esc(String(temp))}°C</div>
            <div class="dim">${esc(condition)} · humidity ${esc(String(args.humidity ?? 40))}% · wind ${esc(String(args.wind ?? 8))} km/h</div>
          </div>
        </div>`,
        `${location}: ${temp}°C, ${condition}`)
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

function esc(value: string) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
}

export default defineEventHandler(async (event) => {
  const message = await readBody<JsonRpcRequest>(event)
  if (message.id === undefined || message.id === null) {
    setResponseStatus(event, 202)
    return null
  }
  const respond = (result: unknown) => ({ jsonrpc: '2.0' as const, id: message.id, result })
  try {
    switch (message.method) {
      case 'initialize':
        return respond({
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'opencode-web-demo-ui', version: '1' },
          instructions: 'Demo MCP-UI server: tools render interactive cards (metric, background, forex chart, weather) directly in the chat.'
        })
      case 'ping':
        return respond({})
      case 'tools/list':
        return respond({ tools: TOOLS })
      case 'tools/call': {
        const { name, arguments: args } = message.params || {}
        try {
          return respond(callTool(name, args || {}))
        } catch (error) {
          return respond({
            content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }],
            isError: true
          })
        }
      }
      default:
        return { jsonrpc: '2.0' as const, id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } }
    }
  } catch (error) {
    return { jsonrpc: '2.0' as const, id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' } }
  }
})
