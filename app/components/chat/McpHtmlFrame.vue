<script setup lang="ts">
// Renders MCP UI resources in a sandboxed iframe:
// - html:     inline srcdoc, fully isolated (allow-scripts only)
// - url:      external app under its own origin (needs allow-same-origin for
//             module scripts + storage; still isolated from this app)
// - script:   mcp-ui remote-dom component, executed inside a generic
//             web-component host shell (experimental)
const props = defineProps<{
  html?: string
  url?: string
  script?: string
  /** MCP Apps (SEP-1865) template: host speaks JSON-RPC over postMessage */
  app?: { html: string }
  appData?: { toolInput?: unknown; toolResult?: unknown }
  title?: string
  /** enables the open-in-sidebar / fullscreen actions + shareable URL state */
  appId?: string
  /** rendered inside the viewer pane: hide the open actions */
  viewer?: boolean
}>()

const frame = ref<HTMLIFrameElement>()
const height = ref(props.viewer ? 480 : 240)
const appViewer = props.appId || props.viewer ? useAppViewer() : null

// while this app is displayed in the side panel / fullscreen, the chat copy
// becomes a placeholder (click to bring the app back into the chat)
const shownElsewhere = computed(() =>
  Boolean(!props.viewer && props.appId && appViewer && appViewer.appId.value === props.appId && appViewer.view.value)
)

// generic remote-dom host: defines any <x-*> custom element on the fly with
// sensible defaults (buttons dispatch 'press', label/text attrs render, stacks
// flex) and exposes `root` — enough for typical mcp-ui remote-dom demos.
const REMOTE_DOM_SHELL_HEAD = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:dark}
body{margin:0;padding:14px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#17171a;color:#d4d4dc;font-size:14px}
.rd{display:block;margin:4px 0}
.rd-button{display:inline-flex;align-items:center;gap:6px;background:#232327;color:#fafafa;border:none;border-radius:4px;padding:7px 12px;cursor:pointer;font:inherit}
.rd-button:hover{background:#2d2d33}
.rd-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.rd-stack{display:flex;flex-direction:column;gap:6px}
.rd-badge{display:inline-block;background:#232327;border-radius:99px;padding:2px 10px;font-size:11px;color:#8f8f99}
.rd-heading{font-size:16px;font-weight:600;color:#fafafa}
img{max-width:100%;border-radius:4px}
</style></head><body><div id="root"></div><script>
(function(){
  var defined = {};
  function classify(tag){
    if(/button/.test(tag)) return 'rd-button';
    if(/row|inline|group/.test(tag)) return 'rd-row';
    if(/stack|list|column|card|box/.test(tag)) return 'rd-stack';
    if(/badge|chip|tag/.test(tag)) return 'rd-badge';
    if(/heading|title|h1|h2/.test(tag)) return 'rd-heading';
    return '';
  }
  function ensure(tag){
    tag = tag.toLowerCase();
    if(defined[tag] || customElements.get(tag)) return;
    defined[tag] = true;
    customElements.define(tag, class extends HTMLElement{
      connectedCallback(){
        this.classList.add('rd');
        var cls = classify(this.tagName.toLowerCase());
        if(cls) this.classList.add(cls);
        this._sync();
        var self=this;
        new MutationObserver(function(){ self._sync() }).observe(this,{attributes:true});
        if(cls==='rd-button'){
          this.setAttribute('role','button'); this.tabIndex=0;
          this.addEventListener('click',function(){ self.dispatchEvent(new CustomEvent('press',{bubbles:false})) });
        }
      }
      _sync(){
        var text=this.getAttribute('label')||this.getAttribute('text')||this.getAttribute('content')||this.getAttribute('title');
        if(text!=null && !this.childElementCount) this.textContent=text;
        var src=this.getAttribute('src');
        if(src && !this.querySelector('img')){ var img=document.createElement('img'); img.src=src; this.appendChild(img); }
      }
    });
  }
  var orig = document.createElement.bind(document);
  document.createElement = function(tag, opts){
    if(typeof tag==='string' && tag.indexOf('-')>-1) ensure(tag);
    return orig(tag, opts);
  };
  window.root = document.getElementById('root');
})();
<\/script><script>
try{
` // user script injected here
const REMOTE_DOM_SHELL_TAIL = `
}catch(e){ document.getElementById('root').textContent = 'remote-dom error: ' + e.message }
<\/script><script>
var post=function(){ parent.postMessage({type:'ui-size-change',payload:{height:document.documentElement.scrollHeight}},'*') };
addEventListener('load',post); new ResizeObserver(post).observe(document.documentElement);
<\/script></body></html>`

const srcdoc = computed(() => {
  if (props.url) return undefined
  if (props.app) return props.app.html
  if (props.script) {
    return REMOTE_DOM_SHELL_HEAD + props.script.replace(/<\/script>/gi, '<\\/script>') + REMOTE_DOM_SHELL_TAIL
  }
  return props.html
})

// ---- MCP Apps host protocol (JSON-RPC over postMessage) ----
function postToFrame(message: Record<string, unknown>) {
  // Vue reactive proxies are not structured-cloneable -> plain JSON only
  frame.value?.contentWindow?.postMessage(JSON.parse(JSON.stringify(message)), '*')
}

function handleAppRpc(msg: { jsonrpc?: string; id?: number | string; method?: string; params?: any }): boolean {
  if (!props.app || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return false
  switch (msg.method) {
    case 'ui/initialize':
      postToFrame({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2026-01-26',
          hostCapabilities: {},
          hostContext: { theme: 'dark', displayMode: props.viewer ? 'fullscreen' : 'inline' }
        }
      })
      return true
    case 'ui/notifications/initialized':
      markReady()
      postToFrame({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-input',
        params: { arguments: props.appData?.toolInput || {} }
      })
      postToFrame({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: props.appData?.toolResult || {}
      })
      return true
    case 'ui/notifications/size-changed': {
      const h = msg.params?.height
      if (typeof h === 'number' && h > 40 && h < 6000) {
        markReady()
        height.value = Math.max(h, props.viewer ? 400 : 60)
      }
      return true
    }
    case 'ui/open-link':
      if (typeof msg.params?.url === 'string') window.open(msg.params.url, '_blank', 'noopener')
      if (msg.id != null) postToFrame({ jsonrpc: '2.0', id: msg.id, result: {} })
      return true
    case 'ui/message':
    case 'ui/request-display-mode':
    case 'ui/update-model-context':
      if (msg.id != null) postToFrame({ jsonrpc: '2.0', id: msg.id, result: {} })
      return true
    default:
      if (msg.id != null) {
        postToFrame({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unsupported: ${msg.method}` } })
      }
      return true
  }
}

// Load lifecycle (mcp-ui spec): apps should post ui-lifecycle-iframe-ready.
// loading -> ready (fade in, brief 'loaded' badge)
//         -> timeout (frame loaded, no ready event) with 'show anyway'
//         -> error (nothing loaded at all)
type FrameState = 'loading' | 'ready' | 'timeout' | 'error'
const state = ref<FrameState>('loading')
const justLoaded = ref(false)
let readyGrace: ReturnType<typeof setTimeout> | undefined
let hardTimeout: ReturnType<typeof setTimeout> | undefined

function markReady() {
  if (state.value === 'ready') return
  state.value = 'ready'
  clearTimeout(readyGrace)
  clearTimeout(hardTimeout)
  justLoaded.value = true
  setTimeout(() => { justLoaded.value = false }, 1800)
}

function startLifecycle() {
  state.value = 'loading'
  clearTimeout(readyGrace)
  clearTimeout(hardTimeout)
  // nothing at all after 15s -> failed
  hardTimeout = setTimeout(() => {
    if (state.value === 'loading') state.value = 'error'
  }, 15000)
}

watch(() => [props.url, props.html, props.script], startLifecycle)
onMounted(startLifecycle)

function onFrameLoad() {
  // srcdoc content is ours: ready on load. External apps get a grace period
  // to send the mcp-ui ready/size event before we flag the missing event.
  clearTimeout(hardTimeout)
  if (!props.url) {
    markReady()
    return
  }
  readyGrace = setTimeout(() => {
    if (state.value === 'loading') state.value = 'timeout'
  }, 4000)
}

function onMessage(e: MessageEvent) {
  if (e.source !== frame.value?.contentWindow) return
  const data = e.data
  if (data && typeof data === 'object') {
    if (handleAppRpc(data)) return
    if (typeof data.type === 'string' && /ready|lifecycle/i.test(data.type)) markReady()
    const h = data.payload?.height ?? data.height
    if (typeof h === 'number' && h > 40 && h < 6000) {
      markReady()
      height.value = Math.max(h, props.viewer ? 400 : 60)
    }
  }
}

onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))
</script>

<template>
  <div class="rounded-md border border-default overflow-hidden bg-muted" :class="viewer ? 'h-full flex flex-col' : ''">
    <div class="flex items-center gap-2 px-2 py-1 border-b border-default text-xs text-muted shrink-0">
      <UIcon :name="script ? 'i-lucide-puzzle' : 'i-lucide-app-window'" class="size-3.5" />
      <span class="truncate flex-1">{{ title || 'MCP app' }}</span>
      <UBadge v-if="script" size="sm" variant="subtle" color="neutral">remote-dom</UBadge>
      <Transition name="oc-swap">
        <UBadge v-if="justLoaded" size="sm" variant="subtle" color="success">
          <UIcon name="i-lucide-check" class="size-3 mr-0.5" /> loaded
        </UBadge>
      </Transition>
      <UTooltip v-if="url" text="Open in a new tab (e.g. to log in)">
        <UButton
          icon="i-lucide-external-link"
          size="xs"
          color="neutral"
          variant="ghost"
          :href="url"
          target="_blank"
          aria-label="Open in a new tab"
        />
      </UTooltip>
      <template v-if="appId && !viewer">
        <UTooltip text="Open in side panel">
          <UButton
            icon="i-lucide-panel-right"
            size="xs"
            color="neutral"
            variant="ghost"
            class="hidden lg:inline-flex"
            aria-label="Open in side panel"
            @click="appViewer!.open(appId, 'side')"
          />
        </UTooltip>
        <UTooltip text="Fullscreen">
          <UButton
            icon="i-lucide-maximize-2"
            size="xs"
            color="neutral"
            variant="ghost"
            aria-label="Fullscreen"
            @click="appViewer!.open(appId, 'full')"
          />
        </UTooltip>
      </template>
    </div>
    <button
      v-if="shownElsewhere"
      class="oc-appear flex w-full items-center justify-center gap-2 py-8 text-xs text-muted hover:text-highlighted cursor-pointer"
      @click="appViewer!.close()"
    >
      <UIcon :name="appViewer!.view.value === 'full' ? 'i-lucide-maximize-2' : 'i-lucide-panel-right'" class="size-4" />
      Currently showing {{ appViewer!.view.value === 'full' ? 'in fullscreen' : 'in the side panel' }} — click to move back to the chat
    </button>
    <div v-else class="relative" :class="viewer ? 'flex-1 min-h-0 flex' : ''">
      <iframe
        ref="frame"
        :srcdoc="srcdoc"
        :src="url"
        :sandbox="url
          ? 'allow-scripts allow-same-origin allow-forms allow-popups'
          : 'allow-scripts allow-forms'"
        class="w-full bg-white dark:bg-neutral-950 transition-opacity duration-300"
        :class="[viewer ? 'flex-1' : '', state === 'ready' ? 'opacity-100' : 'opacity-0']"
        :style="viewer ? undefined : { height: height + 'px' }"
        :title="title || 'MCP app'"
        @load="onFrameLoad"
      />
      <Transition name="oc-swap">
        <div
          v-if="state !== 'ready'"
          class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted px-4 text-center"
        >
          <template v-if="state === 'loading'">
            <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-muted" />
            <span class="text-xs oc-shimmer-text">Loading app…</span>
          </template>
          <template v-else-if="state === 'timeout'">
            <UIcon name="i-lucide-circle-help" class="size-5 text-warning" />
            <span class="text-xs text-muted max-w-xs">
              The iframe loaded but the app never sent the mcp-ui ready event
              (<span class="font-mono">ui-lifecycle-iframe-ready</span>) — it may still work.
            </span>
            <UButton size="xs" color="neutral" variant="soft" icon="i-lucide-eye" label="Show iframe anyway" @click="markReady" />
          </template>
          <template v-else>
            <UIcon name="i-lucide-circle-x" class="size-5 text-error" />
            <span class="text-xs text-error">Failed to load the app</span>
            <UButton v-if="url" size="xs" color="neutral" variant="soft" icon="i-lucide-external-link" label="Open in a new tab" :href="url" target="_blank" />
          </template>
        </div>
      </Transition>
    </div>
  </div>
</template>
