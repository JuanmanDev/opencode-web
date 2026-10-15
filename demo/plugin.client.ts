// Static demo only (DEMO=1 builds): answer the UI's API calls in the browser
// and show a small "demo" pill with a reset button.
import { installDemoBackend, resetDemo } from './backend'

function mountBanner() {
  if (document.getElementById('ocw-demo-pill')) return
  const pill = document.createElement('div')
  pill.id = 'ocw-demo-pill'
  pill.setAttribute('role', 'status')
  pill.style.cssText = [
    'position:fixed', 'top:max(6px,env(safe-area-inset-top))', 'left:50%', 'transform:translateX(-50%)', 'z-index:60',
    'display:flex', 'align-items:center', 'gap:8px', 'padding:3px 4px 3px 10px', 'border-radius:999px',
    'background:rgba(25,25,28,.92)', 'border:1px solid #2a2a2f', 'color:#9a9aa3',
    'font:11px/1.4 ui-sans-serif,system-ui,sans-serif', 'backdrop-filter:blur(6px)', 'box-shadow:0 2px 12px #0006'
  ].join(';')
  pill.innerHTML = '<span><b style="color:#fafafa">Demo</b> · runs in your browser, no server</span>'
    + '<a href="https://github.com/JuanmanDev/opencode-web" target="_blank" rel="noopener" style="color:#d4d4dc;text-decoration:underline">GitHub</a>'
  const reset = document.createElement('button')
  reset.type = 'button'
  reset.textContent = 'Reset'
  reset.title = 'Forget your chats and restore the sample projects'
  reset.style.cssText = 'cursor:pointer;border:0;border-radius:999px;padding:2px 9px;background:#2a2a2f;color:#d4d4dc;font:inherit'
  reset.onclick = () => { if (confirm('Reset the demo? Your chats and settings in this browser are removed.')) resetDemo() }
  const hide = document.createElement('button')
  hide.type = 'button'
  hide.textContent = '×'
  hide.setAttribute('aria-label', 'Hide the demo banner')
  hide.style.cssText = 'cursor:pointer;border:0;background:transparent;color:#6b6b74;font:14px/1 sans-serif;padding:0 6px'
  hide.onclick = () => pill.remove()
  pill.append(reset, hide)
  document.body.appendChild(pill)
}

export default defineNuxtPlugin({
  name: 'opencode-web-demo',
  enforce: 'pre',
  setup() {
    installDemoBackend()
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountBanner, { once: true })
    else mountBanner()
  }
})
