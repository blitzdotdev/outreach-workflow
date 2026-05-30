// autolead worker — SSR action feed + autolead-skill API
// UI is gmail-shaped split-pane. First-person POV.
// AI work is OUT of this worker — the autolead skill running in the user's
// Claude session does drafting / revision / sending. This worker is UI + DB.
//
// Routes:
//   /                          UI: list + empty right
//   /items/:id                 UI: list + detail
//   /items/:id?reply=1         UI: with reply card spawned
//   POST /items/:id/reply      UI form: flips revision_pending=1
//   POST /items/:id/send       UI form: flips send_pending=1
//   POST /items/:id/reject     UI form: status=rejected
//   GET  /api/pending          autolead skill: what needs work
//   GET  /api/skill            autolead skill: latest voice snapshot
//   POST /api/skill            autolead skill: upsert new voice snapshot
//   POST /api/research         autolead skill: insert a complete feed_item
//   POST /api/items/:id/apply-revision   autolead skill: post revised draft
//   POST /api/items/:id/mark-sent        autolead skill: confirm platform send
//   POST /api/items/:id/mark-send-failed autolead skill: report error
//   POST /admin/wipe-all       one-time data wipe (header token-gated)

import { $Database, teenyHono, OpenApiExtension, PocketUIExtension, Hono, html, raw } from 'teenybase'
import config from 'virtual:teenybase'
import { diffWords } from './diff.ts'

const app = new Hono()

// ──────────────────────────────────────────────────────────────────
// Crypto helper
// ──────────────────────────────────────────────────────────────────

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function esc(s: any): any {
  if (s == null) return raw('')
  return raw(String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'))
}

function parseJson(v: any): any {
  if (v == null) return null
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return null }
}

function relTime(ts: any): string {
  if (!ts) return ''
  const d = typeof ts === 'string' ? new Date(ts.replace(' ', 'T') + (ts.includes('Z') ? '' : 'Z')) : new Date(ts)
  if (isNaN(d.getTime())) return ''
  const diff = Math.floor((Date.now() - d.getTime()) / 1000)
  if (diff < 60) return diff + 's ago'
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago'
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago'
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago'
  return d.toISOString().slice(0, 10)
}

function shortTime(ts: any): string {
  if (!ts) return ''
  const d = typeof ts === 'string' ? new Date(ts.replace(' ', 'T') + (ts.includes('Z') ? '' : 'Z')) : new Date(ts)
  if (isNaN(d.getTime())) return ''
  const sameDay = new Date().toDateString() === d.toDateString()
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function channelLimit(channel: string): number | null {
  const c = (channel || '').toLowerCase()
  if (c === 'x' || c === 'twitter') return 280
  return null
}

function isReply(item: any): boolean {
  const t = (item.message_type || '').toLowerCase()
  return t === 'reply' || t === 'comment'
}

function hasParentContent(item: any): boolean {
  return !!(item.parent_text && item.parent_author_handle && isReply(item))
}

// True if `url` is a permalink to a single post/comment on the given channel,
// not a profile, subreddit landing page, or other navigational URL. We only
// surface "View on …" links for real permalinks — pointing the user at a
// profile when they expect the source post is the bug class this guards.
function isPostUrl(channel: string | null | undefined, url: string | null | undefined): boolean {
  if (!url) return false
  const c = (channel || '').toLowerCase()
  if (c === 'x' || c === 'twitter') {
    return /^https?:\/\/(www\.)?(x|twitter)\.com\/[^\/]+\/status\/\d+/i.test(url)
  }
  if (c === 'reddit') {
    return /^https?:\/\/(www\.|old\.|new\.)?reddit\.com\/(r\/[^\/]+\/)?comments\/[a-z0-9]+/i.test(url)
  }
  return false
}

// ──────────────────────────────────────────────────────────────────
// Layout
// ──────────────────────────────────────────────────────────────────

function layout(c: any, bodyHtml: any) {
  // Anti-cache: every page render must reflect the current DB state, not a stale browser copy.
  c.header('cache-control', 'no-store, no-cache, must-revalidate, max-age=0')
  c.header('pragma', 'no-cache')
  c.header('expires', '0')
  return html`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>autolead</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  html, body { height: 100%; margin: 0; background: #f1f3f4; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ui-sans-serif, system-ui, sans-serif; color: #202124; }
  .scroll-y { overflow-y: auto; scrollbar-gutter: stable; }
  .scroll-y::-webkit-scrollbar { width: 10px; }
  .scroll-y::-webkit-scrollbar-thumb { background: #dadce0; border-radius: 5px; }
  .scroll-y::-webkit-scrollbar-thumb:hover { background: #bdc1c6; }
  textarea.compose { resize: none; line-height: 1.55; }
</style>
</head>
<body class="h-full">
${bodyHtml}
<script>
  function tx(el) {
    el.style.height = 'auto';
    el.style.height = Math.max(el.dataset.minH ? parseInt(el.dataset.minH) : 80, el.scrollHeight) + 'px';
    var ctr = document.getElementById(el.dataset.counterId);
    if (ctr) {
      var lim = el.dataset.limit ? parseInt(el.dataset.limit, 10) : null;
      if (lim) {
        ctr.textContent = el.value.length + ' / ' + lim;
        ctr.className = el.value.length > lim ? 'text-[11px] text-red-600 tabular-nums' : 'text-[11px] text-gray-400 tabular-nums';
      } else {
        ctr.textContent = el.value.length + ' chars';
      }
    }
  }
  document.querySelectorAll('textarea[data-counter-id], textarea[data-min-h]').forEach(function(el){ tx(el); el.addEventListener('input', function(){ tx(el); }); });
  // Focus the reply textarea if present
  var rt = document.querySelector('textarea[data-autofocus]');
  if (rt) { rt.focus(); rt.setSelectionRange(rt.value.length, rt.value.length); }
  // j/k keyboard nav
  document.addEventListener('keydown', function(e){
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    if (e.key !== 'j' && e.key !== 'k') return;
    var rows = Array.from(document.querySelectorAll('a[data-row-id]'));
    if (rows.length === 0) return;
    var active = document.querySelector('a[data-row-id][data-active="1"]');
    var idx = active ? rows.indexOf(active) : -1;
    var next = e.key === 'j' ? rows[Math.min(idx + 1, rows.length - 1)] : rows[Math.max(idx - 1, 0)];
    if (next) next.click();
  });
</script>
</body></html>`
}

// ──────────────────────────────────────────────────────────────────
// Top bar
// ──────────────────────────────────────────────────────────────────

function renderTopBar(itemCount: number, flash?: string): any {
  return html`
    <div class="flex items-center px-5 py-3 bg-white border-b border-gray-200 flex-shrink-0">
      <a href="/" class="flex items-center gap-2 mr-6">
        <span class="w-7 h-7 rounded-md bg-blue-600 text-white flex items-center justify-center text-[13px] font-bold">a</span>
        <span class="text-[15px] font-medium text-gray-800 tracking-tight">autolead</span>
      </a>
      <div class="flex-1 max-w-2xl">
        <div class="flex items-center gap-2 bg-gray-100 hover:bg-gray-50 focus-within:bg-white focus-within:shadow-sm focus-within:ring-1 focus-within:ring-gray-300 rounded-full px-4 py-2 transition">
          <svg class="w-4 h-4 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="text" placeholder="Search drafts" class="flex-1 bg-transparent text-sm text-gray-800 placeholder:text-gray-500 focus:outline-none" />
        </div>
      </div>
      <div class="ml-6 flex items-center gap-3">
        ${flash ? html`<span class="text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-100 px-2.5 py-1 rounded-full">${esc(flash)}</span>` : ''}
        <form method="POST" action="/research" class="inline">
          <button type="submit" class="px-4 py-1.5 text-[13px] bg-gray-900 hover:bg-gray-700 text-white rounded-full font-medium">Begin research</button>
        </form>
        <span class="w-8 h-8 rounded-full bg-gray-300 text-white text-[12px] font-bold flex items-center justify-center">M</span>
      </div>
    </div>`
}

// ──────────────────────────────────────────────────────────────────
// List sidebar (Gmail inbox style)
// ──────────────────────────────────────────────────────────────────

function renderListRow(item: any, activeId: string | null): any {
  const isActive = activeId === item.id
  const ev = item.ev_score == null ? 0 : Number(item.ev_score)
  const evPct = Math.round(ev * 100)
  const isHigh = ev >= 0.70
  const isSent = item.status === 'sent'
  const isRejected = item.status === 'rejected'
  const isQueued = !!item.send_pending && !isSent && !isRejected
  const isRevising = !!item.revision_pending && !isSent && !isRejected && !isQueued
  const recipient = item.target_handle || '—'
  const channelSuffix = (item.message_type || '').toLowerCase() === 'dm' ? ' · DM' : ''

  // Right column: state-aware label
  let rightLabel: any
  if (isSent) {
    rightLabel = html`<span class="text-[11px] text-emerald-700 font-semibold">Sent</span>`
  } else if (isQueued) {
    rightLabel = html`<span class="text-[11px] text-amber-700 font-semibold">Pending…</span>`
  } else if (isRevising) {
    rightLabel = html`<span class="text-[11px] text-violet-700 font-semibold">Revising…</span>`
  } else if (isRejected) {
    rightLabel = html`<span class="text-[11px] text-gray-400 font-medium">Discarded</span>`
  } else {
    rightLabel = html`<span class="text-[12px] tabular-nums text-gray-600 font-medium">${esc(evPct)}</span>`
  }

  // Leading icon
  let leadingIcon: any
  if (isSent) {
    leadingIcon = html`<span class="w-4 flex-shrink-0 text-emerald-500 leading-none" title="Sent">
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    </span>`
  } else if (isQueued) {
    leadingIcon = html`<span class="w-4 flex-shrink-0 text-amber-500 leading-none" title="Pending send">
      <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
    </span>`
  } else if (isRevising) {
    leadingIcon = html`<span class="w-4 flex-shrink-0 text-violet-500 leading-none" title="Awaiting redraft">
      <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
    </span>`
  } else if (isRejected) {
    leadingIcon = html`<span class="w-4 flex-shrink-0 text-gray-400 leading-none" title="Discarded">
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </span>`
  } else {
    leadingIcon = html`<span class="w-4 text-gray-300 group-hover:text-gray-400 flex-shrink-0 text-[15px] leading-none">☆</span>`
  }

  // Left edge stripe
  let edgeStripe: any = ''
  if (isSent) {
    edgeStripe = html`<span class="absolute left-0 top-0 bottom-0 w-[3px] bg-emerald-400"></span>`
  } else if (isQueued) {
    edgeStripe = html`<span class="absolute left-0 top-0 bottom-0 w-[3px] bg-amber-400"></span>`
  } else if (isRevising) {
    edgeStripe = html`<span class="absolute left-0 top-0 bottom-0 w-[3px] bg-violet-400"></span>`
  } else if (isRejected) {
    edgeStripe = html`<span class="absolute left-0 top-0 bottom-0 w-[3px] bg-gray-300"></span>`
  } else if (isHigh) {
    edgeStripe = html`<span class="absolute left-0 top-0 bottom-0 w-[3px] bg-blue-500"></span>`
  }

  // Text muting for done states
  const muted = isSent || isRejected
  const recipientClass = isQueued ? 'font-medium text-amber-900'
                       : isRevising ? 'font-medium text-violet-900'
                       : muted ? 'text-gray-500'
                       : (isActive ? 'font-semibold text-gray-900' : 'font-medium text-gray-800')
  const subjectClass = isQueued ? 'font-medium text-amber-900'
                     : isRevising ? 'font-medium text-violet-900'
                     : muted ? 'text-gray-500'
                     : (isActive ? 'font-semibold text-gray-900' : 'font-medium text-gray-800')
  const previewClass = isQueued ? 'text-amber-800'
                     : isRevising ? 'text-violet-800'
                     : muted ? 'text-gray-400'
                     : 'text-gray-500'

  // Background tint
  const bgClass = isActive ? 'bg-blue-50/60'
                : isSent ? 'bg-emerald-50/40 hover:bg-emerald-50/70'
                : isQueued ? 'bg-amber-50/50 hover:bg-amber-50/80'
                : isRevising ? 'bg-violet-50/50 hover:bg-violet-50/80'
                : isRejected ? 'bg-gray-50/60 hover:bg-gray-50'
                : 'hover:bg-gray-50'

  return html`
    <a href="/items/${esc(item.id)}" data-row-id="${esc(item.id)}" ${isActive ? 'data-active="1"' : ''}
       class="group relative flex items-center gap-3 pl-4 pr-4 py-2.5 border-b border-gray-100 ${bgClass} text-[13px]">
      ${edgeStripe}
      ${leadingIcon}
      <span class="w-[140px] flex-shrink-0 truncate ${recipientClass}">${esc(recipient)}${esc(channelSuffix)}</span>
      <span class="flex-1 min-w-0 truncate text-gray-600">
        <span class="${subjectClass}">${esc(item.summary_subject)}</span>
        ${item.summary_body ? html`<span class="text-gray-400"> · </span><span class="${previewClass}">${esc(item.summary_body)}</span>` : ''}
      </span>
      <span class="w-12 text-right flex-shrink-0">${rightLabel}</span>
      <span class="w-14 text-right text-[11px] text-gray-400 tabular-nums flex-shrink-0">${esc(isSent && item.sent_at ? shortTime(item.sent_at) : shortTime(item.created))}</span>
    </a>`
}

function renderList(items: any[], activeId: string | null): any {
  if (items.length === 0) {
    return html`<div class="p-10 text-center text-sm text-gray-500">
      No drafts yet. Click <span class="font-medium text-gray-700">Begin research</span> to fill the queue.
    </div>`
  }
  return html`<div class="bg-white">${items.map(it => renderListRow(it, activeId))}</div>`
}

// ──────────────────────────────────────────────────────────────────
// Empty detail
// ──────────────────────────────────────────────────────────────────

function renderEmptyDetail(itemCount: number): any {
  return html`
    <div class="h-full flex items-center justify-center text-center px-10">
      <div class="max-w-sm">
        <div class="w-12 h-12 mx-auto rounded-full border border-gray-200 flex items-center justify-center mb-4">
          <svg class="w-5 h-5 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 4 12 14.01l-3-3"/><path d="M22 11.07V4H2v16h20v-7.07"/></svg>
        </div>
        <div class="text-[14px] text-gray-700">Pick a draft to read, revise, or send.</div>
        <div class="mt-1 text-[12px] text-gray-500">${esc(itemCount)} draft${itemCount === 1 ? '' : 's'} in the queue.</div>
        <div class="mt-6 text-[11px] text-gray-400">
          <kbd class="px-1.5 py-0.5 border border-gray-200 rounded bg-white text-gray-500">j</kbd>
          <kbd class="px-1.5 py-0.5 border border-gray-200 rounded bg-white text-gray-500 ml-1">k</kbd>
          to move between rows
        </div>
      </div>
    </div>`
}

// ──────────────────────────────────────────────────────────────────
// X-style source-context mockup
// ──────────────────────────────────────────────────────────────────

function renderSourceX(item: any): any {
  const meta = parseJson(item.parent_author_meta) || {}
  const eng = parseJson(item.parent_engagement) || {}
  return html`
    <div class="text-[11px] uppercase tracking-wide text-gray-500 font-medium mb-2">Replying to</div>
    <div class="bg-white border border-gray-200 rounded-2xl p-4 max-w-[600px]">
      <div class="flex gap-3">
        <div class="w-10 h-10 rounded-full bg-gray-300 flex-shrink-0 flex items-center justify-center text-white text-[14px] font-bold">${esc((meta.name || item.parent_author_handle || '?').toString().replace(/^@/, '').slice(0, 1).toUpperCase())}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1 text-[14px]">
            <span class="font-bold text-gray-900 truncate">${esc(meta.name || (item.parent_author_handle || '').replace(/^@/, ''))}</span>
            ${meta.verified ? html`<svg class="w-4 h-4 text-blue-500 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="m9 12 2 2 4-4M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>` : ''}
            <span class="text-gray-500 truncate">${esc(item.parent_author_handle)}</span>
            <span class="text-gray-400">·</span>
            <span class="text-gray-500">${esc(relTime(item.parent_posted_at))}</span>
          </div>
          <div class="mt-1.5 text-[14px] text-gray-900 leading-[1.45] whitespace-pre-wrap">${esc(item.parent_text)}</div>
          <div class="mt-3 flex items-center gap-7 text-[12px] text-gray-500">
            <span class="flex items-center gap-1.5"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${esc(eng.replies ?? eng.comments ?? '—')}</span>
            <span class="flex items-center gap-1.5"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>${esc(eng.retweets ?? '—')}</span>
            <span class="flex items-center gap-1.5"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>${esc(eng.likes ?? '—')}</span>
            ${isPostUrl(item.channel, item.parent_url) ? html`<a href="${esc(item.parent_url)}" target="_blank" rel="noopener" class="ml-auto text-blue-600 hover:underline">View on x ↗</a>` : ''}
          </div>
        </div>
      </div>
    </div>`
}

function extractSubreddit(parentUrl: string | null | undefined, subject?: string | null): string {
  if (parentUrl) {
    const m = parentUrl.match(/reddit\.com\/r\/([^\/?#]+)/i)
    if (m) return `r/${m[1]}`
  }
  if (subject) {
    const m = subject.match(/\br\/[A-Za-z0-9_]+/)
    if (m) return m[0]
  }
  return ''
}

function renderSourceReddit(item: any): any {
  const meta = parseJson(item.parent_author_meta) || {}
  const eng = parseJson(item.parent_engagement) || {}
  const subreddit = extractSubreddit(item.parent_url, item.summary_subject)
  return html`
    <div class="text-[11px] uppercase tracking-wide text-gray-500 font-medium mb-2">Replying to</div>
    <div class="bg-white border border-gray-200 rounded-xl max-w-[640px] overflow-hidden">
      <div class="px-4 pt-3.5 pb-2 flex items-center flex-wrap gap-x-2 gap-y-1 text-[12px]">
        <div class="w-6 h-6 rounded-full bg-orange-500 text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">r/</div>
        ${subreddit ? html`<span class="font-bold text-gray-900">${esc(subreddit)}</span><span class="text-gray-400">·</span>` : ''}
        <span class="text-gray-500">Posted by <span class="text-gray-700">${esc(item.parent_author_handle)}</span></span>
        ${meta.karma != null ? html`<span class="text-gray-400">·</span><span class="text-gray-500">${esc(Number(meta.karma).toLocaleString())} karma</span>` : ''}
        ${item.parent_posted_at ? html`<span class="text-gray-400">·</span><span class="text-gray-500">${esc(relTime(item.parent_posted_at))}</span>` : ''}
      </div>
      <div class="px-4 pb-4 text-[15px] font-semibold text-gray-900 leading-snug whitespace-pre-wrap">${esc(item.parent_text)}</div>
      <div class="px-4 py-2.5 bg-gray-50 border-t border-gray-100 flex items-center gap-6 text-[12px] text-gray-600">
        <span class="flex items-center gap-1.5 font-medium">
          <svg class="w-4 h-4 text-orange-500" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 4 12h5v8h6v-8h5z"/></svg>
          ${esc(eng.upvotes ?? '—')}
        </span>
        <span class="flex items-center gap-1.5">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          ${esc(eng.comments ?? '—')} comments
        </span>
        <span class="flex items-center gap-1.5">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          Share
        </span>
        ${isPostUrl(item.channel, item.parent_url) ? html`<a href="${esc(item.parent_url)}" target="_blank" rel="noopener" class="ml-auto text-blue-600 hover:underline">View on reddit ↗</a>` : ''}
      </div>
    </div>`
}

function renderSourceContext(item: any): any {
  if (!hasParentContent(item)) return ''
  const c = (item.channel || '').toLowerCase()
  if (c === 'x' || c === 'twitter') return renderSourceX(item)
  if (c === 'reddit') return renderSourceReddit(item)
  return ''
}

// ──────────────────────────────────────────────────────────────────
// Detail header (subject + field rows)
// ──────────────────────────────────────────────────────────────────

function renderDetailHeader(item: any): any {
  const recipient = item.target_handle || '—'
  const channelLabel = (item.channel || '').toLowerCase() === 'x' || (item.channel || '').toLowerCase() === 'twitter' ? 'x.com'
                      : (item.channel || '').toLowerCase() === 'reddit' ? 'reddit'
                      : item.channel || ''
  const evPct = item.ev_score == null ? null : Math.round(Number(item.ev_score) * 100)
  return html`
    <div class="px-8 pt-6 pb-5 border-b border-gray-200">
      <div class="flex items-center gap-3 text-[12px] text-gray-500 mb-3">
        <a href="/" class="hover:text-gray-700">◂ Outbox</a>
        <span class="text-gray-300">/</span>
        <span>drafts</span>
        <div class="ml-auto flex items-center gap-2 text-gray-400">
          <button class="hover:text-gray-700" title="More">⋯</button>
        </div>
      </div>
      <h1 class="text-[20px] font-medium text-gray-900 leading-snug mb-4">${esc(item.summary_subject)}</h1>
      <dl class="grid grid-cols-2 gap-x-10 gap-y-1.5 max-w-2xl text-[13px]">
        <div class="flex">
          <dt class="w-14 text-gray-500">To</dt>
          <dd class="text-gray-800"><span class="font-medium">${esc(recipient)}</span> <span class="text-gray-500">on ${esc(channelLabel)}</span></dd>
        </div>
        <div class="flex">
          <dt class="w-14 text-gray-500">Date</dt>
          <dd class="text-gray-800">${esc(relTime(item.created))}</dd>
        </div>
        <div class="flex">
          <dt class="w-14 text-gray-500">Type</dt>
          <dd class="text-gray-800">${esc(item.message_type || '—')} <span class="text-gray-500">· ${esc(item.audience || '—')}</span></dd>
        </div>
        <div class="flex">
          <dt class="w-14 text-gray-500">EV</dt>
          <dd class="text-gray-800">${evPct != null ? html`<span class="tabular-nums">${esc(evPct)}</span>` : '—'}</dd>
        </div>
      </dl>
    </div>`
}

// ──────────────────────────────────────────────────────────────────
// Yellow post-it (summary + ev_reasoning merged)
// ──────────────────────────────────────────────────────────────────

function renderPostit(item: any): any {
  const parts: string[] = []
  if (item.summary_body) parts.push(String(item.summary_body))
  if (item.ev_reasoning) parts.push(String(item.ev_reasoning))
  if (parts.length === 0) return ''
  const merged = parts.join('\n\n')
  return html`
    <div class="bg-amber-50 border border-amber-200 rounded-md p-3.5 mb-5 flex items-start gap-2.5">
      <svg class="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5L12 2z"/></svg>
      <div class="flex-1 text-[13px] text-amber-900 leading-relaxed whitespace-pre-wrap">${esc(merged)}</div>
      <button type="button" onclick="this.closest('.bg-amber-50').remove()" class="text-amber-600 hover:text-amber-900 flex-shrink-0 leading-none text-[14px]" title="Dismiss">✕</button>
    </div>`
}

// ──────────────────────────────────────────────────────────────────
// Draft card (the email composition surface)
// ──────────────────────────────────────────────────────────────────

function renderQueuedBanner(item: any): any {
  const channel = (item.channel || '').toLowerCase()
  const platformName = channel === 'x' || channel === 'twitter' ? 'x.com'
                     : channel === 'reddit' ? 'reddit'
                     : channel || 'the platform'
  return html`
    <div class="px-5 py-4 bg-amber-50 border-t border-amber-200 flex items-start gap-3">
      <div class="w-8 h-8 rounded-full bg-amber-400 text-white flex items-center justify-center flex-shrink-0">
        <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-medium text-amber-900">Pending send to ${esc(item.target_handle || 'recipient')} on ${esc(platformName)}…</div>
        <div class="text-[11px] text-amber-700 mt-0.5">Queued. Run "send" in your Claude session to deliver.</div>
      </div>
      <form method="POST" action="/items/${esc(item.id)}/unqueue" class="flex-shrink-0">
        <button type="submit" class="text-[12px] text-amber-700 hover:text-amber-900 font-medium underline-offset-2 hover:underline">Cancel</button>
      </form>
    </div>`
}

function renderSentBanner(item: any): any {
  const sentAt = item.sent_at ? relTime(item.sent_at) : 'just now'
  const channel = (item.channel || '').toLowerCase()
  const platformName = channel === 'x' || channel === 'twitter' ? 'x.com'
                     : channel === 'reddit' ? 'reddit'
                     : channel || 'the platform'
  return html`
    <div class="px-5 py-4 bg-emerald-50 border-t border-emerald-200 flex items-start gap-3">
      <div class="w-8 h-8 rounded-full bg-emerald-500 text-white flex items-center justify-center flex-shrink-0">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-medium text-emerald-900">Sent to ${esc(item.target_handle || 'recipient')} on ${esc(platformName)}</div>
        <div class="text-[11px] text-emerald-700 mt-0.5">${esc(sentAt)}${item.sent_at ? html` · <span class="text-emerald-600">${esc(new Date(typeof item.sent_at === 'string' ? (item.sent_at.replace(' ', 'T') + (item.sent_at.includes('Z') ? '' : 'Z')) : item.sent_at).toLocaleString())}</span>` : ''}</div>
      </div>
    </div>`
}

function renderRejectedBanner(item: any): any {
  return html`
    <div class="px-5 py-4 bg-gray-50 border-t border-gray-200 flex items-start gap-3">
      <div class="w-8 h-8 rounded-full bg-gray-400 text-white flex items-center justify-center flex-shrink-0">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-medium text-gray-700">Discarded</div>
        <div class="text-[11px] text-gray-500 mt-0.5">This draft was rejected and will not be sent.</div>
      </div>
    </div>`
}

function renderDraftCard(item: any, replyOpen: boolean): any {
  const limit = channelLimit(item.channel)
  const recipient = item.target_handle || 'recipient'
  const recipientShort = recipient.length > 14 ? recipient.slice(0, 14) + '…' : recipient
  const channelLabel = (item.channel || '').toLowerCase() === 'x' || (item.channel || '').toLowerCase() === 'twitter' ? 'x.com'
                      : (item.channel || '').toLowerCase() === 'reddit' ? 'reddit'
                      : item.channel || ''
  const isSent = item.status === 'sent'
  const isRejected = item.status === 'rejected'
  const isQueued = !!item.send_pending && !isSent && !isRejected
  const readOnly = isSent || isRejected || isQueued
  const sentAtLabel = item.sent_at ? `sent ${relTime(item.sent_at)}` : ''

  return html`
    <form method="POST" action="/items/${esc(item.id)}/send" class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <!-- Header strip -->
      <div class="px-5 py-3 flex items-center justify-between border-b border-gray-100">
        <div class="flex items-center gap-2.5 text-[13px] text-gray-700 min-w-0">
          <span class="text-gray-400 flex-shrink-0">
            <svg class="w-4 h-4 inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
            <span class="text-[10px] ml-0.5">▾</span>
          </span>
          <span class="text-gray-500">To:</span>
          <span class="font-medium text-gray-800 truncate">${esc(recipient)}</span>
          <span class="text-gray-400">‹${esc(channelLabel)}›</span>
        </div>
        <div class="flex items-center gap-3 text-gray-400 flex-shrink-0">
          ${isSent ? html`<span class="text-[11px] uppercase tracking-wide text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">${esc(sentAtLabel || 'sent')}</span>` : ''}
          ${isQueued ? html`<span class="text-[11px] uppercase tracking-wide text-amber-700 bg-amber-50 px-2 py-0.5 rounded">sending…</span>` : ''}
          ${isRejected ? html`<span class="text-[11px] uppercase tracking-wide text-gray-600 bg-gray-100 px-2 py-0.5 rounded">discarded</span>` : ''}
          <button type="button" class="hover:text-gray-700 leading-none" title="Minimize">▭</button>
          <button type="button" class="hover:text-gray-700 leading-none" title="More">⋯</button>
        </div>
      </div>
      <!-- Body -->
      <div class="px-6 py-5">
        ${renderPostit(item)}
        <textarea name="draft" rows="6" data-min-h="120"
                  ${readOnly ? 'readonly' : ''}
                  data-counter-id="char-counter"
                  ${limit ? `data-limit="${limit}"` : ''}
                  class="w-full text-[14px] text-gray-900 leading-relaxed compose focus:outline-none border-0 placeholder:text-gray-400 ${readOnly ? 'cursor-default select-text' : ''}">${esc(item.current_draft)}</textarea>
        ${!readOnly ? html`
          <div class="text-right mt-3">
            <span id="char-counter" class="text-[11px] text-gray-400 tabular-nums"></span>
          </div>
        ` : ''}
      </div>
      ${readOnly
        ? (isSent ? renderSentBanner(item) : isRejected ? renderRejectedBanner(item) : renderQueuedBanner(item))
        : html`
          <!-- Action row -->
          <div class="px-5 py-3 border-t border-gray-100 flex items-center justify-between bg-white">
            <div class="flex items-center gap-2">
              <a href="?reply=1#reply"
                 class="inline-flex items-center gap-1.5 px-4 py-1.5 text-[13px] border border-gray-300 text-gray-700 rounded-full hover:bg-gray-50 font-medium">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
                Reply
              </a>
              <button type="submit"
                      class="inline-flex items-center gap-1.5 px-5 py-1.5 text-[13px] bg-blue-600 hover:bg-blue-700 text-white rounded-full font-medium shadow-sm">
                Send to ${esc(recipientShort)}
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>
              </button>
            </div>
            <button type="submit" formaction="/items/${esc(item.id)}/reject" formnovalidate
                    class="text-gray-400 hover:text-red-600 p-1.5 rounded-full hover:bg-red-50" title="Discard draft (reject)">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        `}
    </form>`
}

// ──────────────────────────────────────────────────────────────────
// Reply card (spawned when ?reply=1)
// ──────────────────────────────────────────────────────────────────

function renderReplyCard(item: any): any {
  return html`
    <div class="mt-4 flex gap-3" id="reply">
      <div class="w-10 h-10 rounded-full bg-gray-300 text-white flex items-center justify-center flex-shrink-0 text-[14px] font-bold">M</div>
      <form method="POST" action="/items/${esc(item.id)}/reply" class="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div class="px-5 py-3 flex items-center justify-between border-b border-gray-100">
          <div class="flex items-center gap-2.5 text-[13px] min-w-0">
            <span class="text-gray-400 flex-shrink-0">
              <svg class="w-4 h-4 inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
              <span class="text-[10px] ml-0.5">▾</span>
            </span>
            <div class="flex flex-col">
              <span class="text-gray-800 font-medium">Revise or reject this draft</span>
              <span class="text-[11px] text-gray-500">revise → rewrites the draft. reject → marks the candidate bad and feeds the reason into the next research cycle.</span>
            </div>
          </div>
          <div class="flex items-center gap-3 text-gray-400 flex-shrink-0">
            <a href="/items/${esc(item.id)}" class="hover:text-gray-700 leading-none text-[14px]" title="Close">✕</a>
          </div>
        </div>
        <div class="px-6 py-5">
          <textarea name="text" rows="4" data-min-h="100" data-autofocus required
                    placeholder="revise: e.g. make it shorter, drop the second sentence, more skeptical&#10;reject: e.g. wrong audience, OP's parent was about Y not X, off-topic for this sub"
                    class="w-full text-[14px] text-gray-900 leading-relaxed compose focus:outline-none border-0 placeholder:text-gray-400"></textarea>
        </div>
        <div class="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <button type="submit"
                    class="inline-flex items-center gap-1.5 px-5 py-1.5 text-[13px] bg-blue-600 hover:bg-blue-700 text-white rounded-full font-medium shadow-sm">
              Revise
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>
            </button>
            <button type="submit" formaction="/items/${esc(item.id)}/reject"
                    class="inline-flex items-center gap-1.5 px-4 py-1.5 text-[13px] border border-gray-300 text-gray-700 rounded-full hover:bg-red-50 hover:border-red-300 hover:text-red-700 font-medium"
                    title="Reject as bad target. Reason feeds the next research cycle.">
              Reject with reason
            </button>
            <a href="/items/${esc(item.id)}" class="px-3 py-1.5 text-[13px] text-gray-600 hover:text-gray-900">Cancel</a>
          </div>
        </div>
      </form>
    </div>`
}

// ──────────────────────────────────────────────────────────────────
// Detail pane assembly
// ──────────────────────────────────────────────────────────────────

function renderDetail(item: any, replyOpen: boolean): any {
  const showSource = hasParentContent(item)
  return html`
    <div class="flex flex-col h-full">
      ${renderDetailHeader(item)}
      <div class="flex-1 scroll-y px-8 py-6">
        ${showSource ? html`<div class="mb-6">${renderSourceContext(item)}</div>` : ''}
        ${renderDraftCard(item, replyOpen)}
        ${replyOpen && item.status !== 'sent' && item.status !== 'rejected' ? renderReplyCard(item) : ''}
        <div class="h-10"></div>
      </div>
    </div>`
}

// ──────────────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────────────

async function loadItems(db: any) {
  // rawSQL because db.table().select() has been dropping boolean columns (send_pending/revision_pending)
  // from the result set in this teenybase version. RLS bypass is fine: single-tenant + worker-mediated UI.
  const rows = (await db.rawSQL({
    q: 'SELECT * FROM feed_items ORDER BY created DESC LIMIT 100',
    v: [],
  }).run()) || []
  return rows
}

// Gmail-style 3-tab split. Drafts holds both fresh drafts and items the user
// asked to revise (revising items are appended at the BOTTOM of the tab, with
// distinct purple styling — see renderListRow). Sent holds both sent items and
// items queued to send (queued items go at the TOP with the amber spinner,
// since they're the most current things happening). Rejected = terminal
// negative with a stated reason; silent trash-icon discards are hidden from
// every tab.
type Buckets = { drafts: any[]; sent: any[]; rejected: any[] }
function bucketItems(items: any[]): Buckets {
  const draftsBase: any[] = []
  const draftsRevising: any[] = []
  const sentBase: any[] = []
  const sentOutgoing: any[] = []
  const rejected: any[] = []
  for (const it of items) {
    if (it.status === 'sent') sentBase.push(it)
    else if (it.status === 'rejected') {
      if (it.rejection_reason) rejected.push(it)
    } else if (it.send_pending) sentOutgoing.push(it)
    else if (it.revision_pending) draftsRevising.push(it)
    else draftsBase.push(it)
  }
  return {
    drafts: [...draftsBase, ...draftsRevising],
    sent: [...sentOutgoing, ...sentBase],
    rejected,
  }
}

const TAB_IDS = ['drafts', 'sent', 'rejected'] as const
type TabId = typeof TAB_IDS[number]
function normalizeTab(raw: string | undefined): TabId {
  const t = (raw || 'drafts') as TabId
  return TAB_IDS.includes(t) ? t : 'drafts'
}

async function loadItem(db: any, id: string) {
  const rows = (await db.rawSQL({
    q: 'SELECT * FROM feed_items WHERE id = ? LIMIT 1',
    v: [id],
  }).run()) || []
  return rows[0] || null
}

function renderTabsStrip(activeTab: TabId, buckets: Buckets): any {
  const tabs: Array<{ id: TabId; label: string; count: number }> = [
    { id: 'drafts',   label: 'Drafts',   count: buckets.drafts.length },
    { id: 'sent',     label: 'Sent',     count: buckets.sent.length },
    { id: 'rejected', label: 'Rejected', count: buckets.rejected.length },
  ]
  return html`
    <div class="flex border-b border-gray-200 bg-white">
      ${tabs.map(t => html`
        <a href="/?tab=${esc(t.id)}"
           class="flex items-center gap-2 px-4 py-2.5 text-[13px] border-b-2 ${activeTab === t.id ? 'border-blue-500 text-gray-900 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'}">
          <span>${esc(t.label)}</span>
          ${t.count > 0 ? html`<span class="px-1.5 py-0.5 text-[11px] rounded-full ${activeTab === t.id ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'} tabular-nums min-w-[20px] text-center">${t.count}</span>` : ''}
        </a>
      `)}
    </div>`
}

function renderPage(buckets: Buckets, activeTab: TabId, activeItem: any, opts: { flash?: string, replyOpen?: boolean } = {}): any {
  const visible = buckets[activeTab]
  const totalCount = Object.values(buckets).reduce((s, b) => s + b.length, 0)
  return html`
    <div class="h-full flex flex-col bg-[#f1f3f4]">
      ${renderTopBar(totalCount, opts.flash)}
      <div class="flex-1 flex min-h-0 p-3 gap-3">
        <aside class="w-[460px] flex-shrink-0 bg-white rounded-xl border border-gray-200 overflow-hidden flex flex-col shadow-sm">
          ${renderTabsStrip(activeTab, buckets)}
          <div class="flex-1 scroll-y">
            ${renderList(visible, activeItem ? activeItem.id : null)}
          </div>
        </aside>
        <main class="flex-1 min-w-0 bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
          ${activeItem ? renderDetail(activeItem, !!opts.replyOpen) : renderEmptyDetail(visible.length)}
        </main>
      </div>
    </div>`
}

// ──────────────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────────────

app.get('/', async (c) => {
  const db = c.get('$db')
  const items = await loadItems(db)
  const buckets = bucketItems(items)
  const activeTab = normalizeTab(c.req.query('tab'))
  const flash = c.req.query('flash') || undefined
  return c.html(layout(c, renderPage(buckets, activeTab, null, { flash })))
})

app.get('/items/:id', async (c) => {
  const db = c.get('$db')
  const id = c.req.param('id')
  const replyOpen = c.req.query('reply') === '1'
  const flash = c.req.query('flash') || undefined
  const [items, item] = await Promise.all([loadItems(db), loadItem(db, id)])
  const buckets = bucketItems(items)
  // When opening a detail page, pick the tab that actually contains this item
  // (so the sidebar list shows it as the selected row). Falls back to ?tab=
  // query param if explicitly set, then drafts.
  const queryTab = c.req.query('tab')
  let activeTab: TabId = normalizeTab(queryTab)
  if (!queryTab && item) {
    for (const t of TAB_IDS) if (buckets[t].some((x: any) => x.id === item.id)) { activeTab = t; break }
  }
  if (!item) {
    return c.html(layout(c, renderPage(buckets, activeTab, null, { flash: 'Item not found' })), 404)
  }
  return c.html(layout(c, renderPage(buckets, activeTab, item, { replyOpen, flash })))
})

// POST /items/:id/send — UI form: flip send_pending=1, also store any manual edits to current_draft
app.post('/items/:id/send', async (c) => {
  const db = c.get('$db')
  const id = c.req.param('id')
  const form = await c.req.formData()
  const draft = String(form.get('draft') || '')

  const item = await loadItem(db, id)
  if (!item) return c.redirect('/?flash=Item+not+found', 303)
  if (item.status === 'sent' || item.status === 'rejected') {
    return c.redirect(`/items/${id}`, 303)
  }

  // Capture manual edit if the textarea differs from the latest draft.
  // Defensive: if the chain has no ai-role entry (item pre-dates the seed-on-insert
  // fix, or was inserted by a path that skipped seeding), seed one from the prior
  // current_draft before recording the user's edit — otherwise the original AI
  // draft is silently destroyed when we UPDATE current_draft below.
  const ec = parseJson(item.edit_chain) || []
  const lastAiDraft = [...ec].reverse().find((e: any) => e?.role === 'ai' || e?.role === 'cmo')?.draft
  const manuallyEdited = lastAiDraft ? lastAiDraft !== draft : draft !== item.current_draft
  if (manuallyEdited) {
    if (lastAiDraft == null) {
      ec.unshift({
        role: 'ai',
        v: 1,
        draft: item.current_draft,
        ts: item.created || new Date().toISOString(),
        skill_snapshot_hash: item.skill_snapshot_hash ?? null,
        backfilled: true,
      })
    }
    ec.push({ role: 'user_manual_edit', draft, ts: new Date().toISOString() })
  }

  await db.rawSQL({
    q: `UPDATE feed_items SET current_draft = ?, edit_chain = ?, send_pending = 1, approved_at = ? WHERE id = ?`,
    v: [draft, JSON.stringify(ec), new Date().toISOString(), id],
  }).run()

  // No flash — the inline "Sending..." banner in the draft card is the confirmation.
  return c.redirect(`/items/${id}`, 303)
})

// POST /items/:id/unqueue — clear send_pending=0 (Gmail Undo equivalent before delivery)
app.post('/items/:id/unqueue', async (c) => {
  const db = c.get('$db')
  const id = c.req.param('id')
  await db.rawSQL({
    q: 'UPDATE feed_items SET send_pending = 0 WHERE id = ?',
    v: [id],
  }).run()
  return c.redirect(`/items/${id}`, 303)
})

// POST /items/:id/reject — optional `text` (or `reason`) form field becomes the
// rejection_reason and is exposed via GET /api/rejections for the next research
// cycle to learn from. Empty body = quick discard (trash icon), no reason stored.
app.post('/items/:id/reject', async (c) => {
  const db = c.get('$db')
  const id = c.req.param('id')
  const form = await c.req.formData()
  const reason = String(form.get('text') || form.get('reason') || '').trim() || null
  await db.rawSQL({
    q: 'UPDATE feed_items SET status = ?, rejection_reason = ?, rejected_at = ?, revision_pending = 0, send_pending = 0 WHERE id = ?',
    v: ['rejected', reason, new Date().toISOString(), id],
  }).run()
  const flash = reason ? 'Rejected with reason (will inform next research cycle)' : 'Discarded'
  return c.redirect(`/?flash=${encodeURIComponent(flash)}`, 303)
})

// POST /items/:id/reply — UI form: flip revision_pending=1, store feedback text + user_feedback chain entry
app.post('/items/:id/reply', async (c) => {
  const db = c.get('$db')
  const id = c.req.param('id')
  const form = await c.req.formData()
  const userText = String(form.get('text') || '').trim()
  if (!userText) return c.redirect(`/items/${id}?reply=1`, 303)

  const item = await loadItem(db, id)
  if (!item) return c.redirect('/?flash=Item+not+found', 303)
  if (item.status === 'sent' || item.status === 'rejected') {
    return c.redirect(`/items/${id}`, 303)
  }

  // Append the user_feedback to edit_chain so it shows up in /api/pending
  const ec = parseJson(item.edit_chain) || []
  ec.push({ role: 'user_feedback', text: userText, ts: new Date().toISOString() })

  await db.rawSQL({
    q: 'UPDATE feed_items SET edit_chain = ?, revision_pending = 1, revision_feedback = ? WHERE id = ?',
    v: [JSON.stringify(ec), userText, id],
  }).run()
  return c.redirect(`/items/${id}?flash=Queued+for+revision.+Run+%E2%80%9Cprocess+pending+autolead%E2%80%9D+in+your+Claude+session.`, 303)
})

// POST /research (UI form) — no-op for v1; research is initiated from the Claude terminal.
app.post('/research', async (c) => {
  return c.redirect('/?flash=Research+is+terminal-driven+in+v1.+Run+%22research+%3Curl%3E+autolead%22+in+your+Claude+session.', 303)
})

// ──────────────────────────────────────────────────────────────────
// /api/* — for the autolead skill running in the user's Claude session
// ──────────────────────────────────────────────────────────────────

// Auth: all /api/* require Authorization: Bearer <OUTREACH_API_TOKEN>
async function requireApiToken(c: any, next: any) {
  const expected = c.env.OUTREACH_API_TOKEN
  if (!expected) return c.json({ error: 'OUTREACH_API_TOKEN not configured on the worker' }, 503)
  const got = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '')
  if (got !== expected) return c.json({ error: 'unauthorized' }, 401)
  await next()
}

app.use('/api/*', requireApiToken)

// GET /api/pending — what needs autolead's attention
app.get('/api/pending', async (c) => {
  const db = c.get('$db')
  // Exclude terminal items (sent/rejected) — once delivery or discard happens,
  // any lingering pending flag is stale and should not be re-surfaced to the skill.
  const revisions = (await db.rawSQL({
    q: "SELECT * FROM feed_items WHERE revision_pending = 1 AND status NOT IN ('sent', 'rejected') ORDER BY created DESC",
    v: [],
  }).run()) || []
  const sends = (await db.rawSQL({
    q: "SELECT * FROM feed_items WHERE send_pending = 1 AND status NOT IN ('sent', 'rejected') ORDER BY created DESC",
    v: [],
  }).run()) || []
  return c.json({ revisions, sends })
})

// GET /api/skill — latest voice snapshot
app.get('/api/skill', async (c) => {
  const db = c.get('$db')
  const rows = (await db.rawSQL({
    q: 'SELECT hash, skill_name, content, notes, captured_at FROM skill_snapshots ORDER BY captured_at DESC LIMIT 1',
    v: [],
  }).run()) || []
  return c.json(rows[0] || null)
})

// POST /api/skill — upsert a new voice snapshot
app.post('/api/skill', async (c) => {
  const db = c.get('$db')
  const body = await c.req.json().catch(() => ({}))
  const content = String(body.content || '').trim()
  if (!content) return c.json({ error: 'content required' }, 400)
  const skillName = String(body.skill_name || 'autolead-voice')
  const notes = body.notes ? String(body.notes) : null
  const hash = await sha256Hex(content)
  await db.rawSQL({
    q: 'INSERT OR IGNORE INTO skill_snapshots (hash, skill_name, content, notes, captured_at) VALUES (?, ?, ?, ?, ?)',
    v: [hash, skillName, content, notes, new Date().toISOString()],
  }).run()
  return c.json({ ok: true, hash })
})

// GET /api/rejections — fetch user-rejected candidates with reasons, for the next
// research cycle to use as negative-example priors. Filters: since (ISO, on
// rejected_at), channel, audience, limit (default 50, max 200). Only returns
// items where rejection_reason IS NOT NULL — bare trash-icon discards (no
// reason recorded) don't carry signal so they're excluded.
app.get('/api/rejections', async (c) => {
  const db = c.get('$db')
  const qp = (k: string) => c.req.query(k)
  const wheres: string[] = ["status = 'rejected'", "rejection_reason IS NOT NULL"]
  const vals: any[] = []
  if (qp('since'))    { wheres.push('rejected_at >= ?'); vals.push(qp('since')) }
  if (qp('channel'))  { wheres.push('channel = ?');      vals.push(qp('channel')) }
  if (qp('audience')) { wheres.push('audience = ?');     vals.push(qp('audience')) }
  const limit = Math.min(Math.max(Number(qp('limit') || 50), 1), 200)
  const rows: any[] = (await db.rawSQL({
    q: `SELECT id, channel, message_type, audience, goal, ev_score, ev_reasoning,
              summary_subject, summary_body, parent_text, parent_author_handle,
              parent_url, current_draft, rejection_reason, rejected_at, created
        FROM feed_items
        WHERE ${wheres.join(' AND ')}
        ORDER BY rejected_at DESC
        LIMIT ?`,
    v: [...vals, limit],
  }).run()) || []
  return c.json({ count: rows.length, rejections: rows })
})

// GET /api/examples — fetch sent examples for review or for runtime ambiguity lookups.
// Filters: since (ISO), channel, audience, message_type, goal, q (LIKE on draft+sent+parent),
// limit (default 50, max 200). Default JSON; ?format=md returns markdown with
// word-level diffs computed via jsdiff (vendored at ./diff.ts) — same algorithm
// family as `git diff --word-diff=plain`, just running in the worker so the route
// is self-contained.
app.get('/api/examples', async (c) => {
  const db = c.get('$db')
  const qp = (k: string) => c.req.query(k)
  const wheres: string[] = []
  const vals: any[] = []
  if (qp('since'))        { wheres.push('e.sent_at >= ?');     vals.push(qp('since')) }
  if (qp('channel'))      { wheres.push('e.channel = ?');      vals.push(qp('channel')) }
  if (qp('audience'))     { wheres.push('e.audience = ?');     vals.push(qp('audience')) }
  if (qp('message_type')) { wheres.push('e.message_type = ?'); vals.push(qp('message_type')) }
  if (qp('goal'))         { wheres.push('e.goal = ?');         vals.push(qp('goal')) }
  if (qp('q')) {
    wheres.push('(e.initial_draft LIKE ? OR e.final_sent LIKE ? OR e.parent_context LIKE ?)')
    const t = `%${qp('q')}%`; vals.push(t, t, t)
  }
  const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : ''
  const limit = Math.min(Math.max(Number(qp('limit') || 50), 1), 200)
  const rows: any[] = (await db.rawSQL({
    q: `SELECT e.*, fi.ev_score, fi.ev_reasoning, fi.summary_subject, fi.summary_body, fi.target_handle
        FROM examples e
        LEFT JOIN feed_items fi ON e.source_feed_item_id = fi.id
        ${where}
        ORDER BY e.sent_at DESC
        LIMIT ?`,
    v: [...vals, limit],
  }).run()) || []
  // Hydrate JSON columns once for both formats.
  const hydrated = rows.map((r: any) => ({
    ...r,
    edit_chain: parseJson(r.edit_chain) || [],
    parent_context: parseJson(r.parent_context) || {},
  }))
  if (qp('format') === 'md') {
    return c.text(formatExamplesMarkdown(hydrated), 200, { 'content-type': 'text/markdown; charset=utf-8' })
  }
  return c.json({ count: hydrated.length, examples: hydrated })
})

// Word-level diff rendered in git's --word-diff=plain style: [-removed-]{+added+}
// inline. Uses jsdiff's diffWords, which is the JS port of Myers — same family
// as git's algorithm. Output goes inside a plain ``` fence (not ```diff) because
// the inline markers aren't standard unified-diff syntax that GitHub colors.
function wordDiff(a: string, b: string): string {
  const parts = diffWords(a || '', b || '')
  return parts.map((p: any) => {
    if (p.added)   return '{+' + p.value + '+}'
    if (p.removed) return '[-' + p.value + '-]'
    return p.value
  }).join('')
}

function formatExamplesMarkdown(rows: any[]): string {
  if (!rows.length) return '_(no examples)_\n'
  const out: string[] = []
  rows.forEach((r, idx) => {
    const ctx = r.parent_context || {}
    const eng = ctx.engagement || {}
    const engStr = [
      eng.likes != null     ? `${eng.likes} likes`     : null,
      eng.retweets != null  ? `${eng.retweets} RT`     : null,
      eng.upvotes != null   ? `${eng.upvotes} up`      : null,
      eng.comments != null  ? `${eng.comments} comments` : null,
      eng.replies != null   ? `${eng.replies} replies` : null,
      eng.views != null     ? `${eng.views} views`     : null,
    ].filter(Boolean).join(', ')
    const ec = r.edit_chain || []
    const a = (r.initial_draft || '').trim()
    const b = (r.final_sent || '').trim()
    const sameDraft = a === b

    out.push(`### ${idx + 1}. \`${r.source_feed_item_id}\``)
    out.push('')
    out.push(`Channel: **${r.channel}** · Type: **${r.message_type}** · Audience: ${r.audience || '—'} · Goal: ${r.goal || '—'} · EV: ${r.ev_score ?? '—'} · Outcome: \`${r.outcome}\` · Iterations: ${r.iteration_count}`)
    out.push(`Sent: ${r.sent_at} · Source: ${ctx.url || '—'} · Posted: ${ctx.platform_sent_url || '—'}`)
    out.push('')
    out.push(`**Parent** (${ctx.author || '—'}${engStr ? ` · ${engStr}` : ''}):`)
    out.push('> ' + String(ctx.text || '').replace(/\n/g, '\n> '))
    if (r.summary_body) { out.push(''); out.push(`**Why this was drafted**: ${r.summary_body}`) }
    out.push('')
    if (sameDraft) {
      out.push('**Draft → Sent**: _(sent as drafted, no edits)_')
      out.push('')
      out.push('```')
      out.push(b)
      out.push('```')
    } else {
      out.push('**Draft → Sent** (word-diff, `[-removed-]{+added+}`):')
      out.push('```')
      out.push(wordDiff(a, b))
      out.push('```')
    }
    if (ec.length > 1) {
      out.push('')
      out.push('**Edit chain**:')
      ec.forEach((e: any, i: number) => {
        const role = e.role || '?'
        const payload = e.draft != null ? `: \`${String(e.draft).slice(0, 200)}${String(e.draft).length > 200 ? '…' : ''}\``
                       : e.text != null ? `: "${e.text}"`
                       : ''
        out.push(`${i + 1}. \`${role}\`${payload}`)
      })
    }
    out.push('')
    out.push('---')
    out.push('')
  })
  return out.join('\n')
}

// POST /api/admin/example-patch — patch fields on the examples row tied to a feed_item.
// Use for backfill (e.g. restore original AI draft into initial_draft when the
// seed-edit_chain bug overwrote it). Scoped to fields safe to retroactively set.
app.post('/api/admin/example-patch', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const fid = String(body.feed_item_id || '')
  if (!fid) return c.json({ error: 'feed_item_id required' }, 400)
  const sets: string[] = []
  const vals: any[] = []
  if (body.initial_draft != null) { sets.push('initial_draft = ?'); vals.push(String(body.initial_draft)) }
  if (body.edit_chain != null) {
    const v = typeof body.edit_chain === 'string' ? body.edit_chain : JSON.stringify(body.edit_chain)
    sets.push('edit_chain = ?'); vals.push(v)
  }
  if (!sets.length) return c.json({ error: 'nothing to patch — supply initial_draft and/or edit_chain' }, 400)
  const db = c.get('$db')
  await db.rawSQL({
    q: `UPDATE examples SET ${sets.join(', ')} WHERE source_feed_item_id = ?`,
    v: [...vals, fid],
  }).run()
  return c.json({ ok: true, feed_item_id: fid, set: sets.length })
})

// POST /api/admin/text-replace — bulk find/replace across draft-shaped text columns.
// Scope is intentionally narrow: only my own writing (drafts + edit chains + voice doc),
// never parent_text / parent_context which contain other people's words verbatim.
// Use when you change your mind about phrasing and don't want stale forms to leak
// into the next research cycle via /api/skill or future examples queries.
app.post('/api/admin/text-replace', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const oldStr = String(body.old || '')
  const newStr = String(body.new || '')
  if (!oldStr) return c.json({ error: 'old required' }, 400)
  const db = c.get('$db')
  const targets: { table: string; cols: string[] }[] = [
    { table: 'skill_snapshots', cols: ['content'] },
    { table: 'feed_items', cols: ['current_draft', 'edit_chain'] },
    { table: 'examples', cols: ['initial_draft', 'final_sent', 'edit_chain'] },
  ]
  const out: Record<string, number> = {}
  for (const { table, cols } of targets) {
    const sets = cols.map(c => `${c} = REPLACE(${c}, ?, ?)`).join(', ')
    const args: any[] = []
    for (const _ of cols) args.push(oldStr, newStr)
    const res: any = await db.rawSQL({
      q: `UPDATE ${table} SET ${sets} WHERE ${cols.map(c => `instr(${c}, ?) > 0`).join(' OR ')}`,
      v: [...args, ...cols.map(() => oldStr)],
    }).run()
    out[table] = res?.meta?.changes ?? res?.changes ?? 0
  }
  return c.json({ ok: true, old: oldStr, new: newStr, rows_changed: out })
})

// POST /api/research — create a complete feed_item (autolead skill drafted it)
app.post('/api/research', async (c) => {
  const db = c.get('$db')
  const body = await c.req.json().catch(() => ({}))
  const required = ['channel', 'summary_subject', 'current_draft']
  for (const k of required) if (!body[k]) return c.json({ error: `${k} required` }, 400)
  // If this is a reply/comment and a parent_url is supplied, it must be a real
  // permalink (not a profile or subreddit landing). Reject up front so the
  // outbox never renders a misleading "View on x ↗" link.
  const msgType = String(body.message_type || '').toLowerCase()
  if ((msgType === 'reply' || msgType === 'comment') && body.parent_url && !isPostUrl(body.channel, body.parent_url)) {
    return c.json({
      error: 'parent_url must be a real post permalink for this channel',
      expected: body.channel === 'reddit' ? 'https://reddit.com/r/<sub>/comments/<id>/...' : 'https://x.com/<handle>/status/<id>',
      got: body.parent_url,
    }, 400)
  }
  const id = String(body.id || 'fi_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12))
  const feedId = String(body.feed_id || 'feed_default')
  // Seed edit_chain with the AI's v1 draft. Without this, the user's first
  // manual edit overwrites current_draft and the original AI draft is lost —
  // every downstream consumer (mark-sent, examples diff, voice review) then
  // can't tell drafted-from-sent apart. Accept a client-supplied chain only
  // if it already contains an ai-role entry; otherwise prepend our seed.
  let seedChain: any[] = []
  if (body.edit_chain != null) {
    const supplied = typeof body.edit_chain === 'string' ? (parseJson(body.edit_chain) || []) : body.edit_chain
    if (Array.isArray(supplied)) seedChain = supplied
  }
  const hasAi = seedChain.some((e: any) => e?.role === 'ai' || e?.role === 'cmo')
  if (!hasAi) {
    seedChain.unshift({
      role: 'ai',
      v: 1,
      draft: body.current_draft,
      ts: new Date().toISOString(),
      skill_snapshot_hash: body.skill_snapshot_hash ?? null,
    })
  }
  await db.rawSQL({
    q: `INSERT INTO feed_items (
      id, feed_id, status, channel, audience, message_type, goal,
      ev_score, ev_reasoning, summary_subject, summary_body,
      parent_text, parent_author_handle, parent_author_meta, parent_engagement, parent_posted_at, parent_url,
      target_handle, current_draft, edit_chain, skill_snapshot_hash, related_example_ids
    ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    v: [
      id, feedId, body.channel, body.audience ?? null, body.message_type ?? null, body.goal ?? null,
      body.ev_score ?? null, body.ev_reasoning ?? null, body.summary_subject, body.summary_body ?? null,
      body.parent_text ?? null, body.parent_author_handle ?? null,
      body.parent_author_meta != null ? (typeof body.parent_author_meta === 'string' ? body.parent_author_meta : JSON.stringify(body.parent_author_meta)) : null,
      body.parent_engagement != null ? (typeof body.parent_engagement === 'string' ? body.parent_engagement : JSON.stringify(body.parent_engagement)) : null,
      body.parent_posted_at ?? null, body.parent_url ?? null,
      body.target_handle ?? null, body.current_draft,
      JSON.stringify(seedChain),
      body.skill_snapshot_hash ?? null,
      body.related_example_ids != null ? (typeof body.related_example_ids === 'string' ? body.related_example_ids : JSON.stringify(body.related_example_ids)) : null,
    ],
  }).run()
  return c.json({ ok: true, id })
})

// POST /api/items/:id/apply-revision — autolead skill posts the revised draft
app.post('/api/items/:id/apply-revision', async (c) => {
  const db = c.get('$db')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const newDraft = String(body.draft || '').trim()
  if (!newDraft) return c.json({ error: 'draft required' }, 400)

  const item = await loadItem(db, id)
  if (!item) return c.json({ error: 'not found' }, 404)
  if (item.status === 'sent' || item.status === 'rejected') {
    return c.json({ error: 'item is terminal (sent or rejected)' }, 409)
  }

  const ec = parseJson(item.edit_chain) || []
  const aiCount = ec.filter((e: any) => e?.role === 'ai' || e?.role === 'cmo').length
  ec.push({
    role: 'ai',
    v: aiCount + 1,
    subject: body.subject || `Re: ${item.summary_subject}`,
    body: body.note || '',
    draft: newDraft,
    ts: new Date().toISOString(),
    skill_snapshot_hash: body.skill_snapshot_hash ?? null,
  })

  await db.rawSQL({
    q: 'UPDATE feed_items SET current_draft = ?, edit_chain = ?, revision_pending = 0, revision_feedback = NULL, skill_snapshot_hash = COALESCE(?, skill_snapshot_hash) WHERE id = ?',
    v: [newDraft, JSON.stringify(ec), body.skill_snapshot_hash ?? null, id],
  }).run()
  return c.json({ ok: true, current_draft: newDraft })
})

// POST /api/items/:id/mark-sent — autolead skill confirms platform send succeeded
app.post('/api/items/:id/mark-sent', async (c) => {
  const db = c.get('$db')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const platformUrl = body.platform_url ? String(body.platform_url) : null

  const item = await loadItem(db, id)
  if (!item) return c.json({ error: 'not found' }, 404)
  if (item.status === 'sent') return c.json({ ok: true, idempotent: true })

  const draft = item.current_draft
  const ec = parseJson(item.edit_chain) || []
  const nowIso = new Date().toISOString()

  await db.rawSQL({
    q: 'UPDATE feed_items SET status = ?, sent_at = ?, send_pending = 0, send_error = NULL, revision_pending = 0, revision_feedback = NULL WHERE id = ?',
    v: ['sent', nowIso, id],
  }).run()

  // Write the example row for the learning surface
  const outcome = ec.filter((e: any) => e?.role === 'ai' || e?.role === 'cmo').length > 1 ? 'edited-many'
                : ec.some((e: any) => e?.role === 'user_manual_edit') ? 'edited-manual'
                : ec.some((e: any) => e?.role === 'user_feedback') ? 'edited-once'
                : 'approved-clean'
  const iterCount = ec.filter((e: any) => e?.role === 'ai' || e?.role === 'cmo').length || 1
  const initialDraft = ec.find((e: any) => e?.role === 'ai' || e?.role === 'cmo')?.draft ?? item.current_draft
  const parentBlob = JSON.stringify({
    text: item.parent_text, author: item.parent_author_handle,
    meta: parseJson(item.parent_author_meta), engagement: parseJson(item.parent_engagement),
    posted_at: item.parent_posted_at, url: item.parent_url, platform_sent_url: platformUrl,
  })
  const exampleId = 'ex_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  await db.rawSQL({
    q: `INSERT INTO examples (
      id, source_feed_item_id, audience, channel, message_type, goal,
      outcome, iteration_count, initial_draft, final_sent, edit_chain,
      parent_context, skill_snapshot_hash, feed_id, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    v: [
      exampleId, item.id, item.audience, item.channel, item.message_type, item.goal,
      outcome, iterCount, initialDraft, draft, JSON.stringify(ec),
      parentBlob, item.skill_snapshot_hash, item.feed_id, nowIso,
    ],
  }).run()
  return c.json({ ok: true, example_id: exampleId })
})

// POST /api/items/:id/mark-send-failed — autolead skill reports a send error
app.post('/api/items/:id/mark-send-failed', async (c) => {
  const db = c.get('$db')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const err = String(body.error || 'unknown')
  await db.rawSQL({
    q: 'UPDATE feed_items SET send_pending = 0, send_error = ?, send_attempts = send_attempts + 1 WHERE id = ?',
    v: [err, id],
  }).run()
  return c.json({ ok: true })
})

// ──────────────────────────────────────────────────────────────────
// /admin/wipe-all — one-time demo wipe, header-token gated
// ──────────────────────────────────────────────────────────────────

// Admin: re-queue a previously failed item for send. Clears send_error, sets send_pending=1.
app.post('/admin/items/:id/requeue-send', async (c) => {
  const expected = c.env.WIPE_TOKEN
  const got = c.req.header('x-wipe-token') || ''
  if (!expected) return c.json({ error: 'WIPE_TOKEN not configured' }, 503)
  if (got !== expected) return c.json({ error: 'forbidden' }, 403)
  const db = c.get('$db')
  const id = c.req.param('id')
  await db.rawSQL({
    q: 'UPDATE feed_items SET send_pending = 1, send_error = NULL WHERE id = ?',
    v: [id],
  }).run()
  return c.json({ ok: true, id })
})

// Admin: reset a feed_item back to draft state (clears sent/rejected/pending). Token-gated.
app.post('/admin/items/:id/reset-to-draft', async (c) => {
  const expected = c.env.WIPE_TOKEN
  const got = c.req.header('x-wipe-token') || ''
  if (!expected) return c.json({ error: 'WIPE_TOKEN not configured' }, 503)
  if (got !== expected) return c.json({ error: 'forbidden' }, 403)
  const db = c.get('$db')
  const id = c.req.param('id')
  await db.rawSQL({
    q: 'UPDATE feed_items SET status = ?, sent_at = NULL, send_pending = 0, send_error = NULL, send_attempts = 0 WHERE id = ?',
    v: ['draft', id],
  }).run()
  // Also delete any examples rows that referenced this item to keep things clean for re-send
  await db.rawSQL({
    q: 'DELETE FROM examples WHERE source_feed_item_id = ?',
    v: [id],
  }).run()
  return c.json({ ok: true, id })
})

app.post('/admin/wipe-all', async (c) => {
  const expected = c.env.WIPE_TOKEN
  const got = c.req.header('x-wipe-token') || ''
  if (!expected) return c.json({ error: 'WIPE_TOKEN not configured' }, 503)
  if (got !== expected) return c.json({ error: 'forbidden' }, 403)
  const db = c.get('$db')
  const counts: any = {}
  // FK order: examples references feed_items + skill_snapshots; feed_items references skill_snapshots.
  // Delete child tables first.
  for (const table of ['examples', 'feed_items', 'skill_snapshots']) {
    const before = (await db.rawSQL({ q: `SELECT COUNT(*) as n FROM ${table}`, v: [] }).run()) as any[]
    counts[table + '_before'] = before?.[0]?.n ?? 0
    await db.rawSQL({ q: `DELETE FROM ${table}`, v: [] }).run()
  }
  return c.json({ ok: true, deleted: counts })
})

// ──────────────────────────────────────────────────────────────────
// Mount
// ──────────────────────────────────────────────────────────────────

const apiApp = teenyHono(async (c: any) => {
  const db = new $Database(c, config, c.env.TEENY_PRIMARY_DB, c.env.TEENY_PRIMARY_R2)
  await db.registerExtension(new OpenApiExtension(db, true))
  await db.registerExtension(new PocketUIExtension(db))
  return db
})

apiApp.route('/', app)

export default apiApp
