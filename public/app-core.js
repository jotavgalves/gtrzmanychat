const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  view: 'dashboard',
  dashboard: null,
  automations: [],
  media: null,
  metaStatus: null,
  globalPaused: false,
  currentConversation: null,
};

const pageMeta = {
  dashboard: ['GTRZ FLOW', 'Visão geral'],
  automations: ['MOTOR DE AUTOMAÇÃO', 'Automações'],
  inbox: ['CONVERSAS', 'Inbox'],
  contacts: ['CRM', 'Contatos'],
  activity: ['AUDITORIA', 'Atividade'],
  settings: ['INTEGRAÇÃO', 'Configurações'],
};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value, withTime = true) {
  if (!value) return '—';
  const raw = String(value);
  const date = new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat('pt-BR', withTime ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

function relativeTime(value) {
  if (!value) return '';
  const raw = String(value);
  const date = new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && typeof options.body !== 'string') {
    headers.set('content-type', 'application/json');
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, { ...options, headers });
  let data;
  try { data = await response.json(); } catch { data = { ok: false, error: `HTTP ${response.status}` }; }
  if (response.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('Sua sessão expirou.');
  }
  if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

function toast(title, message = '', type = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.innerHTML = `<strong>${esc(title)}</strong>${message ? `<span>${esc(message)}</span>` : ''}`;
  $('#toastZone').appendChild(item);
  setTimeout(() => item.remove(), 4200);
}

function showLogin() {
  $('#loginView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
}

function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
}

function setView(view) {
  if (!pageMeta[view]) view = 'dashboard';
  state.view = view;
  $$('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${view}`));
  $$('.nav-item[data-view]').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
  $('#pageEyebrow').textContent = pageMeta[view][0];
  $('#pageTitle').textContent = pageMeta[view][1];
  $('#sidebar').classList.remove('open');
  $('#mobileBackdrop').classList.remove('open');
  history.replaceState(null, '', `#${view}`);
  loadView(view);
}

async function loadView(view) {
  try {
    if (view === 'dashboard') await loadDashboard();
    if (view === 'automations') await loadAutomations();
    if (view === 'inbox') await loadInbox();
    if (view === 'contacts') await loadContacts();
    if (view === 'activity') await loadActivity();
    if (view === 'settings') await loadSettings();
  } catch (error) {
    toast('Não foi possível carregar', error.message, 'error');
  }
}

function statusPill(status) {
  if (status === 'succeeded') return '<span class="pill success">ENVIADA</span>';
  if (status === 'rate_limited') return '<span class="pill warning">RATE LIMIT</span>';
  if (status === 'failed' || status === 'uncertain') return '<span class="pill failed">FALHOU</span>';
  if (status === 'claimed') return '<span class="pill neutral">PROCESSANDO</span>';
  return `<span class="pill neutral">${esc(String(status || '—').toUpperCase())}</span>`;
}

async function loadDashboard() {
  const data = await api('/api/dashboard');
  state.dashboard = data;
  state.automations = data.automations || [];
  state.globalPaused = Boolean(data.globalPaused);
  $('#metricComments').textContent = data.metrics.comments24h;
  $('#metricSent').textContent = data.metrics.sent24h;
  $('#metricReplies').textContent = data.metrics.replies24h;
  $('#metricActive').textContent = data.metrics.activeAutomations;
  $('#metricContacts').textContent = `${data.metrics.contacts} contatos no CRM`;
  $('#navAutomationCount').textContent = data.metrics.activeAutomations;
  updateGlobalPauseUI();
  renderDashboardAutomations(state.automations);
  renderDashboardActivity(data.recent || []);
  loadMetaMini();
}

function renderDashboardAutomations(items) {
  const root = $('#dashboardAutomations');
  const visible = items.slice(0, 6);
  if (!visible.length) {
    root.innerHTML = `<div class="empty-state"><div class="empty-icon">⚡</div><strong>Nenhuma automação ainda</strong><span>Crie a primeira regra para transformar comentários em Direct.</span><button class="btn btn-primary" data-create-empty>+ Criar automação</button></div>`;
    root.querySelector('[data-create-empty]')?.addEventListener('click', () => openAutomationModal());
    return;
  }
  root.innerHTML = visible.map((a) => `<div class="automation-row">
      <div class="automation-bolt">⚡</div>
      <div class="automation-info"><strong>${esc(a.name)}</strong><span>${automationSummary(a)}</span></div>
      <div class="automation-stat"><strong>${Number(a.sent_total || 0)}</strong><span>enviadas</span></div>
      <span class="pill ${a.status === 'active' ? 'active' : 'paused'}">${a.status === 'active' ? 'ATIVA' : 'PAUSADA'}</span>
    </div>`).join('');
}

function renderDashboardActivity(items) {
  const root = $('#dashboardActivity');
  if (!items.length) {
    root.innerHTML = '<div class="empty-state"><div class="empty-icon">↳</div><strong>Sem disparos ainda</strong><span>Os resultados das automações aparecem aqui em tempo real.</span></div>';
    return;
  }
  root.innerHTML = items.slice(0, 8).map((item) => {
    const cls = item.status === 'succeeded' ? 'success' : item.status === 'rate_limited' ? 'warning' : 'failed';
    return `<div class="activity-item"><i class="activity-dot ${cls}"></i><div><strong>${esc(item.automation_name)}</strong><span>${esc(item.username ? `@${item.username}` : item.contact_id || 'contato')} · ${esc(item.comment_text || 'comentário')}</span></div><time>${relativeTime(item.created_at)}</time></div>`;
  }).join('');
}

function automationSummary(a) {
  const trigger = a.trigger_type === 'keyword' ? `contém “${esc(a.keyword)}”` : 'qualquer comentário';
  const media = a.media_scope === 'specific' ? (a.media_label || 'publicação específica') : 'qualquer publicação';
  return `${trigger} · ${esc(media)}`;
}

async function loadAutomations() {
  const data = await api('/api/automations');
  state.automations = data.automations || [];
  $('#navAutomationCount').textContent = state.automations.filter((a) => a.status === 'active').length;
  renderAutomationTable();
}

function renderAutomationTable() {
  const root = $('#automationTableWrap');
  if (!state.automations.length) {
    root.innerHTML = `<div class="empty-state"><div class="empty-icon">⚡</div><strong>Seu motor está vazio</strong><span>Comece com “qualquer comentário → DM” e depois crie regras específicas por publicação ou palavra-chave.</span><button class="btn btn-primary" id="emptyNewAutomation">+ Criar primeira automação</button></div>`;
    $('#emptyNewAutomation')?.addEventListener('click', () => openAutomationModal());
    return;
  }
  root.innerHTML = `<table><thead><tr><th>Automação</th><th>Gatilho</th><th>Publicação</th><th>Enviadas</th><th>Status</th><th></th></tr></thead><tbody>${state.automations.map((a) => `<tr>
    <td><span class="table-title">${esc(a.name)}</span><span class="table-sub">Prioridade ${Number(a.priority || 0)} · ${a.once_per_contact ? '1x por contato' : 'pode repetir'}</span></td>
    <td>${a.trigger_type === 'keyword' ? `Contém <b>${esc(a.keyword)}</b>` : 'Qualquer comentário'}</td>
    <td><span class="table-sub" title="${esc(a.media_label || '')}">${a.media_scope === 'specific' ? esc(a.media_label || a.media_id) : 'Todas'}</span></td>
    <td>${Number(a.sent_total || 0)}</td>
    <td><span class="pill ${a.status === 'active' ? 'active' : 'paused'}">${a.status === 'active' ? 'ATIVA' : 'PAUSADA'}</span></td>
    <td><div class="row-actions"><button class="mini-btn" data-toggle="${a.id}">${a.status === 'active' ? 'Pausar' : 'Ativar'}</button><button class="mini-btn" data-edit="${a.id}">Editar</button><button class="mini-btn danger" data-delete="${a.id}">Excluir</button></div></td>
  </tr>`).join('')}</tbody></table>`;

  $$('[data-edit]', root).forEach((btn) => btn.addEventListener('click', () => openAutomationModal(state.automations.find((a) => a.id === btn.dataset.edit))));
  $$('[data-toggle]', root).forEach((btn) => btn.addEventListener('click', () => toggleAutomation(btn.dataset.toggle)));
  $$('[data-delete]', root).forEach((btn) => btn.addEventListener('click', () => removeAutomation(btn.dataset.delete)));
}

async function toggleAutomation(id) {
  const item = state.automations.find((a) => a.id === id);
  if (!item) return;
  try {
    await api(`/api/automations/${encodeURIComponent(id)}`, { method: 'PUT', body: { status: item.status === 'active' ? 'paused' : 'active' } });
    toast(item.status === 'active' ? 'Automação pausada' : 'Automação ativada');
    await loadAutomations();
  } catch (error) { toast('Não foi possível alterar', error.message, 'error'); }
}

async function removeAutomation(id) {
  const item = state.automations.find((a) => a.id === id);
  if (!item || !confirm(`Excluir definitivamente “${item.name}”?`)) return;
  try {
    await api(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('Automação excluída');
    await loadAutomations();
  } catch (error) { toast('Não foi possível excluir', error.message, 'error'); }
}

async function ensureMedia() {
  if (state.media) return state.media;
  try {
    const data = await api('/api/media');
    state.media = data.media || [];
  } catch (error) {
    state.media = [];
    toast('Publicações não carregadas', error.message, 'error');
  }
  return state.media;
}

function mediaLabel(item) {
  const caption = String(item.caption || '').replace(/\s+/g, ' ').trim();
  const prefix = item.media_type === 'VIDEO' ? 'Reel/Vídeo' : item.media_type === 'CAROUSEL_ALBUM' ? 'Carrossel' : 'Post';
  return `${prefix} · ${caption ? caption.slice(0, 68) : item.id}`;
}

async function fillMediaSelects(selected = '') {
  const media = await ensureMedia();
  const options = media.map((item) => `<option value="${esc(item.id)}" data-label="${esc(mediaLabel(item))}" ${String(item.id) === String(selected) ? 'selected' : ''}>${esc(mediaLabel(item))}</option>`).join('');
  $('#mediaId').innerHTML = `<option value="">Selecione uma publicação</option>${options}`;
  $('#simulateMedia').innerHTML = `<option value="">Qualquer / sem publicação específica</option>${options}`;
}

function updateAutomationConditionalFields() {
  $('#keywordField').classList.toggle('hidden', $('#triggerType').value !== 'keyword');
  $('#mediaField').classList.toggle('hidden', $('#mediaScope').value !== 'specific');
}

async function openAutomationModal(item = null) {
  $('#automationModal').classList.remove('hidden');
  $('#automationModalTitle').textContent = item ? 'Editar automação' : 'Nova automação';
  $('#automationId').value = item?.id || '';
  $('#automationName').value = item?.name || '';
  $('#automationStatus').value = item?.status || 'paused';
  $('#triggerType').value = item?.trigger_type || 'any_comment';
  $('#keyword').value = item?.keyword || '';
  $('#mediaScope').value = item?.media_scope || 'all';
  $('#replyText').value = item?.reply_text || '';
  $('#oncePerContact').checked = item ? Boolean(Number(item.once_per_contact)) : true;
  $('#cooldown').value = Number(item?.cooldown_minutes || 0);
  $('#priority').value = Number(item?.priority || 100);
  $('#replyCount').textContent = $('#replyText').value.length;
  updateAutomationConditionalFields();
  await fillMediaSelects(item?.media_id || '');
}

function closeAutomationModal() { $('#automationModal').classList.add('hidden'); }
