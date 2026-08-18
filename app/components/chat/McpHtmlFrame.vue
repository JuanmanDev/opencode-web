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
  title?: string
  /** enables the open-in-sidebar / fullscreen actions + shareable URL state */
  appId?: string
  /** rendered inside the viewer pane: hide the open actions */
  viewer?: boolean
}>()

const frame = ref<HTMLIFrameElement>()
const height = ref(props.viewer ? 480 : 240)
const appViewer = props.appId || props.viewer ? useAppViewer() : null

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
  if (props.script) {
    return REMOTE_DOM_SHELL_HEAD + props.script.replace(/<\/script>/gi, '<\\/script>') + REMOTE_DOM_SHELL_TAIL
  }
  return props.html
})

function onMessage(e: MessageEvent) {
  if (e.source !== frame.value?.contentWindow) return
  const data = e.data
  if (data && typeof data === 'object') {
    const h = data.payload?.height ?? data.height
    if (typeof h === 'number' && h > 40 && h < 6000) height.value = Math.max(h, props.viewer ? 400 : 60)
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
    <iframe
      ref="frame"
      :srcdoc="srcdoc"
      :src="url"
      :sandbox="url
        ? 'allow-scripts allow-same-origin allow-forms allow-popups'
        : 'allow-scripts allow-forms'"
      class="w-full bg-white dark:bg-neutral-950"
      :class="viewer ? 'flex-1' : ''"
      :style="viewer ? undefined : { height: height + 'px' }"
      :title="title || 'MCP app'"
    />
  </div>
</template>
