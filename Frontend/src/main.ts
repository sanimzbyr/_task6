import 'bootstrap/dist/css/bootstrap.min.css'
import 'bootstrap'
import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr'
import interact from 'interactjs'
import panzoom from 'panzoom'
import { marked } from 'marked'

const API = import.meta.env.VITE_API || '' // same-origin by default

const el = (sel: string, root: Document|HTMLElement = document) => root.querySelector(sel) as HTMLElement
const els = (sel: string, root: Document|HTMLElement = document) => Array.from(root.querySelectorAll(sel)) as HTMLElement[]

// --- Types ---
export type Presentation = { id:string, title:string, slug:string, createdAt:string, thumbnailUrl?:string|null }
export type Slide = { id:string, presentationId:string, position:number, createdAt:string }
export type CanvasElement = { id:string, slideId:string, kind:'text'|'rect'|'circle'|'arrow'|'image', x:number, y:number, w:number, h:number, z:number, props:string, updatedAt:string }
export type Member = { presentationId:string, userId:string, role:'creator'|'editor'|'viewer', nickname:string }



// --- Server → Client mappers (API returns PascalCase; UI uses camelCase)
function toPresentation(x:any){ return { 
  id: x.id ?? x.Id, 
  title: x.title ?? x.Title, 
  slug: x.slug ?? x.Slug, 
  createdAt: x.createdAt ?? x.CreatedAt, 
  thumbnailUrl: (x.thumbnailUrl ?? x.ThumbnailUrl) ?? null 
}}

function toSlide(x:any){ return { 
  id: x.id ?? x.Id, 
  presentationId: x.presentationId ?? x.PresentationId, 
  position: x.position ?? x.Position, 
  createdAt: x.createdAt ?? x.CreatedAt 
}}

function toElement(x:any){ return { 
  id: x.id ?? x.Id, 
  slideId: x.slideId ?? x.SlideId, 
  kind: x.kind ?? x.Kind, 
  x: x.x ?? x.X, 
  y: x.y ?? x.Y, 
  w: x.w ?? x.W, 
  h: x.h ?? x.H, 
  z: x.z ?? x.Z, 
  props: x.props ?? x.Props, 
  updatedAt: x.updatedAt ?? x.UpdatedAt 
}}

function toMember(x:any){ return { 
  presentationId: x.presentationId ?? x.PresentationId, 
  userId: x.userId ?? x.UserId, 
  role: x.role ?? x.Role, 
  nickname: x.nickname ?? x.Nickname 
}}
// --- Global state ---
const state: any = {
  view: 'list',
  list: [] as Presentation[],
  preso: null as Presentation|null,
  slides: [] as Slide[],
  currentSlideId: null as string|null,
  elements: new Map<string, CanvasElement[]>(),
  members: new Map<string, Member>(),
  me: { userId: '', nickname: '' , role: 'viewer' } as any,
  hub: null as any,
  locks: new Map<string,string>(), // elementId -> userId
  cursors: new Map<string,{x:number,y:number,nickname:string}>(),
  undo: [] as any[],
  redo: [] as any[],
  selectedId: null as string|null,
  error: ''
}

// --- API helpers ---
async function api(path: string, init?: RequestInit){
  const res = await fetch(API + path, init)
  if(!res.ok) throw new Error(await safeText(res))
  return res.json()
}
async function safeText(res: Response){ try { return await res.text() } catch { return 'Request failed' } }

async function loadList(){ const arr:any[] = await api('/api/presentations'); state.list = arr.map(toPresentation) }

async function loadSnapshot(slug: string) {
  const snap: any = await api(`/api/presentations/${encodeURIComponent(slug)}/snapshot`);

  // Presentation
  const presRaw = snap.Presentation ?? snap.presentation ?? snap;
  state.preso = toPresentation(presRaw);

  // Slides
  const slidesRaw = (snap.Slides ?? snap.slides ?? []) as any[];
  state.slides = slidesRaw.map(toSlide);

  // Elements → grouped by slideId
  const elementsRaw = (snap.Elements ?? snap.elements ?? []) as any[];
  const grouped: Record<string, CanvasElement[]> = {};
  for (const e of elementsRaw.map(toElement) as CanvasElement[]) {
    (grouped[e.slideId] ||= []).push(e);
  }
  state.elements = new Map(Object.entries(grouped));

  // Members (Map keyed by userId)
  const membersRaw = (snap.Members ?? snap.members ?? []) as any[];
  state.members = new Map(
    membersRaw.map((m: any) => {
      const mm = toMember(m);
      return [mm.userId, mm] as [string, Member];
    })
  );
}

// --- Rendering ---
function render(){
  if (state.view === 'list') return renderList()
  if (state.view === 'editor') return renderEditor()
}

function renderList(){
  document.body.innerHTML = `
  <div class="container py-4">
    <div class="d-flex align-items-center gap-3 mb-3">
      <h3 class="m-0">Presentations</h3>
      <div class="ms-auto input-group" style="max-width:480px">
        <input id="newTitle" class="form-control" placeholder="New presentation title">
        <button id="btnCreate" class="btn btn-primary">Create</button>
      </div>
    </div>
    <div class="row g-3">
      ${state.list.map((p:Presentation)=>`
        <div class="col-12 col-md-6 col-lg-4">
          <div class="card h-100 shadow-sm">
            ${p.thumbnailUrl ? `<img class="card-img-top" src="${API}${p.thumbnailUrl}" style="aspect-ratio:16/9;object-fit:cover">` : `<div class="bg-light" style="aspect-ratio:16/9"></div>`}
            <div class="card-body d-flex flex-column">
              <div class="fw-semibold">${escapeHtml(p.title)}</div>
              <div class="text-muted small">/${p.slug}</div>
              <button class="btn btn-outline-primary mt-2 align-self-start" data-open="${p.slug}">Open</button>
            </div>
          </div>
        </div>`).join('')}
    </div>
  </div>`

  el('#btnCreate')?.addEventListener('click', async ()=>{
    const title = (el('#newTitle') as HTMLInputElement).value.trim() || 'Untitled'
    await api('/api/presentations', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title}) })
    await loadList(); render()
  })
  els('[data-open]').forEach(btn => btn.addEventListener('click', async (e)=>{
    const slug = (e.currentTarget as HTMLElement).getAttribute('data-open')!
    const nickname = prompt('Enter your nickname:') || 'guest'
    state.me.nickname = nickname
    await loadSnapshot(slug)
    state.currentSlideId = state.slides[0]?.id || null
    await connectHub(slug, nickname)
  }))
}

function renderEditor(){
  const sId = state.currentSlideId
  const elements = sId ? (state.elements.get(sId) || []) : []
  document.body.innerHTML = `
  <div class="d-flex" style="height:100vh;">
    <div class="border-end" style="width:260px; overflow:auto">
      <div class="p-2 d-flex gap-2 align-items-center border-bottom">
        <button class="btn btn-sm btn-outline-secondary" id="backList">← Back</button>
        <div class="ms-auto small text-muted">${escapeHtml(state.preso.title)}</div>
      </div>
      <div class="p-2 d-grid gap-2">
        <button class="btn btn-sm btn-primary" id="addSlide" ${state.me.role!=='creator'?'disabled':''}>+ Slide</button>
      </div>
      <div class="p-2">
        ${state.slides.map((sl: Slide) => `<div class="thumb ${sl.id===sId?'active':''}" data-slide="${sl.id}">Slide ${sl.position+1}</div>`).join('')}
      </div>
    </div>

    <div class="flex-grow-1 d-flex flex-column">
      <div class="toolbar border-bottom p-2 d-flex gap-2 align-items-center">
        <button class="btn btn-sm btn-outline-secondary" id="present">Present</button>
        <button class="btn btn-sm btn-outline-secondary" id="exportPdf">Export PDF</button>
        <div class="vr mx-1"></div>
        <button class="btn btn-sm btn-outline-primary" id="addText" ${canEdit()?'':'disabled'}>Text</button>
        <button class="btn btn-sm btn-outline-primary" id="addRect" ${canEdit()?'':'disabled'}>Rect</button>
        <button class="btn btn-sm btn-outline-primary" id="addCircle" ${canEdit()?'':'disabled'}>Circle</button>
        <button class="btn btn-sm btn-outline-primary" id="addArrow" ${canEdit()?'':'disabled'}>Arrow</button>
        <label class="btn btn-sm btn-outline-primary m-0 ${canEdit()?'':'disabled'}">
          <input id="imgInput" type="file" accept="image/*" hidden>
          Image
        </label>
        <div class="vr mx-1"></div>
        <button class="btn btn-sm btn-outline-secondary" id="undoBtn">Undo</button>
        <button class="btn btn-sm btn-outline-secondary" id="redoBtn">Redo</button>
      </div>

      <div class="canvas-wrap d-flex align-items-center justify-content-center position-relative flex-grow-1">
        <div id="slide" class="slide bg-white position-relative" style="width:1280px;height:720px;">
          ${elements.map(renderElement).join('')}
          ${Array.from<{x:number;y:number;nickname:string}>(state.cursors.values()).map((c=>`<div class="cursor" style="left:${c.x}px; top:${c.y}px">${escapeHtml(c.nickname)}</div>`)).join('')}
        </div>
      </div>
    </div>

    <div class="border-start" style="width:260px; overflow:auto">
      <div class="p-2 border-bottom d-flex align-items-center">
        <div class="fw-semibold">Users</div>
        <div class="ms-auto small text-muted">You: ${escapeHtml(state.me.nickname)} <span class="badge bg-light text-dark">${state.me.role}</span></div>
      </div>
      <div class="p-2 d-grid gap-2" id="userPanel">
        ${Array.from<Member>(state.members.values()).map((m => `
          <div class="d-flex align-items-center gap-2">
            <div class="avatar">${initials(m.nickname)}</div>
            <div class="flex-grow-1">
              <div class="fw-semibold small">${escapeHtml(m.nickname)}</div>
              <div class="text-muted small">${m.role}</div>
            </div>
            ${state.me.role==='creator' && m.userId!==state.me.userId ? `
              <select class="form-select form-select-sm w-auto" data-role="${m.userId}">
                <option value="viewer" ${m.role==='viewer'?'selected':''}>viewer</option>
                <option value="editor" ${m.role==='editor'?'selected':''}>editor</option>
              </select>` : ''}
          </div>`)).join('')}
      </div>
    </div>
  </div>`

  el('#backList')?.addEventListener('click', async ()=>{ await loadList(); state.view='list'; render() })
  el('#addSlide')?.addEventListener('click', async ()=>{ await state.hub.invoke('AddSlide', state.preso.slug) })
  els('[data-slide]').forEach(d => d.addEventListener('click', (e)=>{
    state.currentSlideId = (e.currentTarget as HTMLElement).getAttribute('data-slide')!
    render()
  }))
  el('#present')?.addEventListener('click', ()=> togglePresent())
  el('#exportPdf')?.addEventListener('click', exportPdf)
  el('#addText')?.addEventListener('click', ()=> addElement('text'))
  el('#addRect')?.addEventListener('click', ()=> addElement('rect'))
  el('#addCircle')?.addEventListener('click', ()=> addElement('circle'))
  el('#addArrow')?.addEventListener('click', ()=> addElement('arrow'))
  el('#imgInput')?.addEventListener('change', onImage)
  el('#undoBtn')?.addEventListener('click', undo)
  el('#redoBtn')?.addEventListener('click', redo)

  // pan/zoom
  const slide = el('#slide')
  const pz = panzoom(slide, { bounds: true, zoomDoubleClickSpeed: 1, maxZoom: 3, minZoom: 0.3 })
  slide.addEventListener('mousemove', (ev:any)=>{
    state.hub?.invoke('Cursor', state.preso.slug, { x: ev.offsetX, y: ev.offsetY, nickname: state.me.nickname })
  })

  // thumbnails: debounce capture
  captureThumbDebounced()

  // enable interact on elements
  enableInteract()

  // role dropdown changes
  els('[data-role]').forEach(sel => sel.addEventListener('change', async (e)=>{
    const userId = (e.currentTarget as HTMLElement).getAttribute('data-role')!
    const role = (e.currentTarget as HTMLSelectElement).value
    try { await state.hub.invoke('SetRole', state.preso.slug, userId, role) } catch(err:any){ alert(err.message) }
  }))
}

function canEdit(){ return state.me.role==='creator' || state.me.role==='editor' }

function renderElement(e: CanvasElement){
  const props = JSON.parse(e.props || '{}')
  const sel = state.selectedId===e.id
  const locked = state.locks.get(e.id)
  const lockedBadge = locked && locked!==state.me.userId ? `<div class="lock">🔒</div>` : ''

  if (e.kind === 'text'){
    return `<div class="el text ${sel?'selected':''}" data-id="${e.id}" style="left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;z-index:${e.z}">
      ${lockedBadge}
      <div class="markdown">${marked.parse(props.text||'Double‑click to edit')}</div>
    </div>`
  }

  if (e.kind === 'image'){
    return `<div class="el image ${sel?'selected':''}" data-id="${e.id}" style="left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;z-index:${e.z}">
      ${lockedBadge}
      <img src="${props.src||''}" style="width:100%;height:100%;object-fit:contain"/>
    </div>`
  }

  // SVG shapes rendered as div with background SVG
  if (e.kind === 'rect' || e.kind==='circle' || e.kind==='arrow'){
    const stroke = props.stroke||'#222', fill = (e.kind==='rect'||e.kind==='circle') ? (props.fill||'rgba(0,0,0,0)') : 'none'
    const svg = e.kind==='rect'
      ? `<svg viewBox="0 0 ${e.w} ${e.h}"><rect x="0" y="0" width="${e.w}" height="${e.h}" stroke="${stroke}" fill="${fill}" stroke-width="2"/></svg>`
      : e.kind==='circle'
      ? `<svg viewBox="0 0 ${e.w} ${e.h}"><ellipse cx="${e.w/2}" cy="${e.h/2}" rx="${e.w/2}" ry="${e.h/2}" stroke="${stroke}" fill="${fill}" stroke-width="2"/></svg>`
      : `<svg viewBox="0 0 ${e.w} ${e.h}"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="10" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z"/></marker></defs><line x1="0" y1="${e.h}" x2="${e.w}" y2="0" stroke="${stroke}" stroke-width="2" marker-end="url(#arrow)"/></svg>`
    return `<div class="el shape ${sel?'selected':''}" data-id="${e.id}" style="left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;z-index:${e.z}">${lockedBadge}${svg}</div>`
  }

  return ''
}

function enableInteract(){
  if (!canEdit()) return
  els('.el').forEach(nodeEl => {
    interact(nodeEl as HTMLElement)
      .draggable({
        listeners: {
          start(){ onDragStart(nodeEl as HTMLElement) },
          move(ev){
            const id = (nodeEl as HTMLElement).dataset.id!
            const e = findElement(id)!
            e.x += ev.dx; e.y += ev.dy
            ;(nodeEl as HTMLElement).style.left = e.x+ 'px';
            ;(nodeEl as HTMLElement).style.top = e.y+ 'px';
          },
          end(){ onDragEnd(nodeEl as HTMLElement) }
        }
      })
      .resizable({ edges: { left:true, right:true, bottom:true, top:true } })
      .on('resizemove', (ev:any)=>{
        onDragStart(nodeEl as HTMLElement)
        const id = (nodeEl as HTMLElement).dataset.id!
        const e = findElement(id)!
        e.x += ev.deltaRect.left
        e.y += ev.deltaRect.top
        e.w = Math.max(20, ev.rect.width)
        e.h = Math.max(20, ev.rect.height)
        Object.assign((nodeEl as HTMLElement).style, { left: e.x+'px', top:e.y+'px', width:e.w+'px', height:e.h+'px' })
      })
      .on('resizeend', ()=> onDragEnd(nodeEl as HTMLElement))

    nodeEl.addEventListener('dblclick', ()=>{
      const id = (nodeEl as HTMLElement).dataset.id!
      const e = findElement(id)!
      if (e.kind!=='text') return
      editText(e)
    })

    nodeEl.addEventListener('click', ()=>{
      state.selectedId = (nodeEl as HTMLElement).dataset.id
      render()
    })

    nodeEl.addEventListener('keydown', (ev:any)=>{ if (ev.key==='Delete') delSelected() })
  })

  document.addEventListener('keydown', (ev:any)=>{ if (ev.key==='Delete') delSelected() })
}

async function onDragStart(nodeEl: HTMLElement){
  const id = (nodeEl as HTMLElement).dataset.id!
  if (!state.locks.get(id)){
    try { await state.hub.invoke('LockElement', state.preso.slug, id) } catch {}
  }
}
async function onDragEnd(nodeEl: HTMLElement){
  const id = (nodeEl as HTMLElement).dataset.id!
  const e = findElement(id)!
  await pushOp({ type:'update', before: null, after: structuredClone(e) })
  await state.hub.invoke('UpdateElement', state.preso.slug, e)
  await state.hub.invoke('UnlockElement', state.preso.slug, id)
  captureThumbDebounced()
}

function findElement(id:string){
  const arr = state.elements.get(state.currentSlideId) || []
  return arr.find((x:any)=>x.id===id)
}

function addElement(kind: CanvasElement['kind']){
  const slideId = state.currentSlideId!
  const base: CanvasElement = { id: crypto.randomUUID(), slideId, kind, x: 100, y: 100, w: 200, h: 100, z: 1, props: '{}', updatedAt: new Date().toISOString() }
  if (kind==='text') base.props = JSON.stringify({ text: 'Double‑click to edit' })
  if (kind==='rect' || kind==='circle' || kind==='arrow') base.props = JSON.stringify({ stroke:'#222', fill:'rgba(0,0,0,0)' })
  if (kind==='image') base.props = JSON.stringify({ src:'' })
  ;(state.elements.get(slideId) || state.elements.set(slideId, []).get(slideId)).push(base)
  state.hub.invoke('CreateElement', state.preso.slug, base)
  pushOp({ type:'create', after: base, before: null })
  render(); captureThumbDebounced()
}

async function onImage(ev:any){
  const file = (ev.currentTarget as HTMLInputElement).files?.[0]
  if (!file) return
  const fd = new FormData(); fd.append('file', file)
  const { Url } = await api('/api/uploads/image', { method:'POST', body: fd })
  const slideId = state.currentSlideId!
  const base: CanvasElement = { id: crypto.randomUUID(), slideId, kind:'image', x: 80, y: 80, w: 400, h: 300, z: 1, props: JSON.stringify({ src: Url }), updatedAt: new Date().toISOString() }
  ;(state.elements.get(slideId) || state.elements.set(slideId, []).get(slideId)).push(base)
  await state.hub.invoke('CreateElement', state.preso.slug, base)
  pushOp({ type:'create', after: base, before: null })
  render(); captureThumbDebounced()
}

function editText(e: CanvasElement){
  const text = prompt('Edit text (Markdown supported):', JSON.parse(e.props||'{}').text || '')
  if (text==null) return
  const before = structuredClone(e)
  e.props = JSON.stringify({ text })
  state.hub.invoke('UpdateElement', state.preso.slug, e)
  pushOp({ type:'update', before, after: structuredClone(e) })
  render(); captureThumbDebounced()
}

function delSelected(){
  if (!state.selectedId) return
  const e = findElement(state.selectedId); if (!e) return
  const arr = state.elements.get(state.currentSlideId) || []
  const idx = arr.findIndex((x:any)=>x.id===e.id)
  if (idx>=0) arr.splice(idx,1)
  state.hub.invoke('DeleteElement', state.preso.slug, e.id)
  pushOp({ type:'delete', before: e, after: null })
  state.selectedId = null
  render(); captureThumbDebounced()
}

// --- Undo / Redo (client-side) ---
async function pushOp(op:any){ state.undo.push(op); state.redo.length = 0 }
async function undo(){
  const op = state.undo.pop(); if (!op) return
  if (op.type==='create'){
    // inverse: delete
    const arr = state.elements.get(op.after.slideId) || []
    const idx = arr.findIndex((x:any)=>x.id===op.after.id); if (idx>=0) arr.splice(idx,1)
    await state.hub.invoke('DeleteElement', state.preso.slug, op.after.id)
  } else if (op.type==='delete'){
    const arr = state.elements.get(op.before.slideId) || state.elements.set(op.before.slideId, []).get(op.before.slideId)
    arr.push(op.before)
    await state.hub.invoke('CreateElement', state.preso.slug, op.before)
  } else if (op.type==='update'){
    await state.hub.invoke('UpdateElement', state.preso.slug, op.before)
    const arr = state.elements.get(op.before.slideId) || []
    const idx = arr.findIndex((x:any)=>x.id===op.before.id); if (idx>=0) arr[idx] = op.before
  }
  state.redo.push(op); render(); captureThumbDebounced()
}
async function redo(){
  const op = state.redo.pop(); if (!op) return
  if (op.type==='create'){
    const arr = state.elements.get(op.after.slideId) || state.elements.set(op.after.slideId, []).get(op.after.slideId)
    arr.push(op.after); await state.hub.invoke('CreateElement', state.preso.slug, op.after)
  } else if (op.type==='delete'){
    const arr = state.elements.get(op.before.slideId) || []
    const idx = arr.findIndex((x:any)=>x.id===op.before.id); if (idx>=0) arr.splice(idx,1)
    await state.hub.invoke('DeleteElement', state.preso.slug, op.before.id)
  } else if (op.type==='update'){
    await state.hub.invoke('UpdateElement', state.preso.slug, op.after)
    const arr = state.elements.get(op.after.slideId) || []
    const idx = arr.findIndex((x:any)=>x.id===op.after.id); if (idx>=0) arr[idx] = op.after
  }
  state.undo.push(op); render(); captureThumbDebounced()
}

// --- Present mode ---
function togglePresent(){ document.body.classList.toggle('present') }

// --- PDF export (client-only) ---
async function exportPdf(){
  const { jsPDF } = await import('jspdf')
  const { default: html2canvas } = await import('html2canvas')
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'px', format: [1280, 720] })
  for(const sl of state.slides){
    state.currentSlideId = sl.id; render();
    const node = el('#slide') as HTMLElement
    const canvas = await html2canvas(node, { backgroundColor: '#ffffff', scale: 1 })
    const img = canvas.toDataURL('image/png')
    if (sl !== state.slides[0]) pdf.addPage([1280,720], 'landscape')
    pdf.addImage(img, 'PNG', 0, 0, 1280, 720)
  }
  pdf.save(`${state.preso.slug}.pdf`)
}

// --- Thumbnails ---
const captureThumbDebounced = debounce(async ()=>{
  if (!state.preso) return
  const { default: html2canvas } = await import('html2canvas')
  const node = el('#slide') as HTMLElement
  const canvas = await html2canvas(node, { backgroundColor: '#ffffff', scale: 0.25 })
  const dataUrl = canvas.toDataURL('image/png')
  await api(`/api/presentations/${state.preso.slug}/thumbnail`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ dataUrl }) })
}, 800)

function debounce(fn:Function, wait:number){ let t:any; return (...args:any[])=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), wait) } }

// --- Hub ---
async function connectHub(slug:string, nickname:string){
  try{
    const hub = new HubConnectionBuilder()
      .withUrl(`${API}/hubs/preso?slug=${encodeURIComponent(slug)}&nickname=${encodeURIComponent(nickname)}`)
      .configureLogging(LogLevel.Information)
      .withAutomaticReconnect()
      .build()

    hub.on('PresenceSnapshot', (p:any)=>{
      for(const m of p.Members){ state.members.set(m.UserId, m) }
      state.locks = new Map(Object.entries(p.Locks||{}))
    })
    hub.on('UserJoined', (x:any)=>{ state.members.set(x.UserId, { presentationId: state.preso.id, userId: x.UserId, nickname: x.Nickname, role: x.Role }); render() })
    hub.on('UserLeft', (x:any)=>{ state.members.delete(x.UserId); render() })
    hub.on('RoleChanged', ({targetUserId, role}:any)=>{ const m = state.members.get(targetUserId); if (m){ m.role=role; if (targetUserId===state.me.userId) state.me.role=role; render() } })
    hub.on('LocksUpdated', (locks:any)=>{ state.locks = new Map(Object.entries(locks)); render() })
    hub.on('CursorPresence', (p:any)=>{ state.cursors.set(p.nickname, p); throttleClearCursor(p.nickname) })

    hub.on('SlideAdded', (s:Slide)=>{ state.slides.push(s); render() })
    hub.on('SlideDeleted', (id:string)=>{ const idx = state.slides.findIndex((x: Slide)=>x.id===id); if(idx>=0) state.slides.splice(idx,1); if(state.currentSlideId===id) state.currentSlideId = state.slides[0]?.id||null; render() })

    hub.on('ElementCreated', (e:CanvasElement)=>{ (state.elements.get(e.slideId) || state.elements.set(e.slideId, []).get(e.slideId)).push(e); render(); captureThumbDebounced() })
    hub.on('ElementUpdated', (e:CanvasElement)=>{ const arr = state.elements.get(e.slideId)||[]; const idx = arr.findIndex((x: CanvasElement)=>x.id===e.id); if(idx>=0) arr[idx]=e; render(); captureThumbDebounced() })
    hub.on('ElementDeleted', (id:string)=>{ for(const [sid,arr] of state.elements){ const idx = arr.findIndex((x: CanvasElement)=>x.id===id); if(idx>=0) arr.splice(idx,1) } render(); captureThumbDebounced() })

    await hub.start()
    state.hub = hub

    // Infer my identity from membership list via nickname
    const me = (Array.from((state.members as Map<string, Member>).values()) as Member[]).find((m: Member)=>m.nickname===state.me.nickname)
    if (me){ state.me.userId = me.userId; state.me.role = me.role }

    state.view = 'editor'
    render()
  }catch(e:any){
    console.warn('Realtime disabled (SignalR failed):', e)
    state.error = 'Connected without realtime (SignalR failed). You can still edit locally.'
    state.view='editor'; render()
  }
}

const _cursorTimers: any = {}
function throttleClearCursor(key:string){ clearTimeout(_cursorTimers[key]); _cursorTimers[key] = setTimeout(()=>{ state.cursors.delete(key); render() }, 1500) }

// --- Utilities ---
function escapeHtml(s:string){ return s.replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"} as any)[c]) }
function initials(nick:string){ return nick.split(/\s+/).map(s=>s[0]?.toUpperCase()).slice(0,2).join('') || '?' }

// Init
;(async function(){ await loadList(); render() })()
