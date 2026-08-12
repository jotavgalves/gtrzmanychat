async function saveAutomation(event) {
  event.preventDefault();
  const id = $('#automationId').value;
  const mediaSelect = $('#mediaId');
  const selectedOption = mediaSelect.options[mediaSelect.selectedIndex];
  const payload = {
    name: $('#automationName').value,
    status: $('#automationStatus').value,
    trigger_type: $('#triggerType').value,
    keyword: $('#keyword').value,
    media_scope: $('#mediaScope').value,
    media_id: $('#mediaScope').value === 'specific' ? mediaSelect.value : null,
    media_label: $('#mediaScope').value === 'specific' ? selectedOption?.dataset?.label || selectedOption?.textContent || '' : null,
    reply_text: $('#replyText').value,
    once_per_contact: $('#oncePerContact').checked,
    cooldown_minutes: Number($('#cooldown').value || 0),
    priority: Number($('#priority').value || 100),
  };
  try {
    await api(id ? `/api/automations/${encodeURIComponent(id)}` : '/api/automations', { method: id ? 'PUT' : 'POST', body: payload });
    closeAutomationModal();
    toast(id ? 'Automação atualizada' : 'Automação criada', payload.status === 'active' ? 'Ela já está ativa.' : 'Ela foi salva pausada.');
    await loadAutomations();
    if (state.view === 'dashboard') await loadDashboard();
  } catch (error) { toast('Não foi possível salvar', error.message, 'error'); }
}

function updateGlobalPauseUI() {
  $('#globalPauseAlert').classList.toggle('hidden', !state.globalPaused);
  $('#killSwitchBtn').textContent = state.globalPaused ? 'Reativar tudo' : 'Pausar tudo';
  $('#killSwitchBtn').classList.toggle('btn-light', state.globalPaused);
}

async function toggleGlobalPause(forceResume = false) {
  const next = forceResume ? false : !state.globalPaused;
  if (next && !confirm('Pausar todas as automações agora? Nenhuma nova DM automática será enviada.')) return;
  try {
    await api('/api/global-pause', { method: 'POST', body: { paused: next } });
    state.globalPaused = next;
    updateGlobalPauseUI();
    toast(next ? 'Tudo pausado' : 'Automações reativadas', next ? 'O kill switch está ligado.' : 'O motor voltou a processar comentários.');
  } catch (error) { toast('Falha ao alterar o sistema', error.message, 'error'); }
}

async function loadContacts() {
  const q = $('#contactSearch').value.trim();
  const data = await api(`/api/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const items = data.contacts || [];
  const root = $('#contactsTableWrap');
  if (!items.length) {
    root.innerHTML = '<div class="empty-state"><div class="empty-icon">◎</div><strong>Nenhum contato ainda</strong><span>Quando alguém comentar ou mandar mensagem, o contato será criado aqui.</span></div>';
    return;
  }
  root.innerHTML = `<table><thead><tr><th>Contato</th><th>Última interação</th><th>Comentários</th><th>Mensagens recebidas</th><th>DMs enviadas</th><th>Origem</th></tr></thead><tbody>${items.map((c) => `<tr>
    <td><span class="table-title">${esc(c.username ? `@${c.username}` : c.id)}</span><span class="table-sub">${esc(c.id)}</span></td>
    <td>${fmtDate(c.last_seen_at)}</td><td>${Number(c.comments_count || 0)}</td><td>${Number(c.inbound_messages_count || 0)}</td><td>${Number(c.outbound_messages_count || 0)}</td><td>${esc(c.last_source || '—')}</td>
  </tr>`).join('')}</tbody></table>`;
}

async function loadActivity() {
  const data = await api('/api/activity');
  const items = data.activity || [];
  const root = $('#activityTableWrap');
  if (!items.length) {
    root.innerHTML = '<div class="empty-state"><div class="empty-icon">◫</div><strong>Nada para auditar ainda</strong><span>Os disparos aparecerão aqui assim que os comentários começarem a chegar.</span></div>';
    return;
  }
  root.innerHTML = `<table><thead><tr><th>Quando</th><th>Automação</th><th>Contato</th><th>Comentário</th><th>Resultado</th><th>Motivo</th></tr></thead><tbody>${items.map((i) => `<tr>
    <td>${fmtDate(i.created_at)}</td><td><span class="table-title">${esc(i.automation_name)}</span></td><td>${esc(i.username ? `@${i.username}` : i.contact_id || '—')}</td><td><span class="table-sub" title="${esc(i.comment_text || '')}">${esc(i.comment_text || '—')}</span></td><td>${statusPill(i.status)}</td><td><span class="table-sub">${esc(i.reason || '—')}</span></td>
  </tr>`).join('')}</tbody></table>`;
}

async function loadInbox() {
  const data = await api('/api/inbox');
  const items = data.conversations || [];
  const root = $('#conversationList');
  if (!items.length) {
    root.innerHTML = '<div class="empty-state"><div class="empty-icon">✉</div><strong>Inbox vazia</strong><span>Mensagens recebidas pelo Instagram aparecerão aqui.</span></div>';
    return;
  }
  root.innerHTML = items.map((c) => `<button class="conversation-item ${state.currentConversation === c.id ? 'active' : ''}" data-conversation="${esc(c.id)}"><div class="contact-avatar">${esc((c.username || 'IG').slice(0,2).toUpperCase())}</div><div><strong>${esc(c.username ? `@${c.username}` : c.id)}</strong><span>${esc(c.last_message || 'Sem texto')}</span></div><time>${relativeTime(c.last_message_at)}</time></button>`).join('');
  $$('[data-conversation]', root).forEach((btn) => btn.addEventListener('click', () => openConversation(btn.dataset.conversation)));
  if (state.currentConversation && items.some((c) => c.id === state.currentConversation)) await openConversation(state.currentConversation, false);
}

async function openConversation(contactId, refreshList = true) {
  state.currentConversation = contactId;
  const data = await api(`/api/inbox/${encodeURIComponent(contactId)}`);
  if (refreshList) $$('.conversation-item').forEach((el) => el.classList.toggle('active', el.dataset.conversation === contactId));
  const pane = $('#conversationPane');
  pane.innerHTML = `<div class="conversation-head"><div class="contact-avatar">${esc((data.contact.username || 'IG').slice(0,2).toUpperCase())}</div><div><strong>${esc(data.contact.username ? `@${data.contact.username}` : data.contact.id)}</strong><span>${esc(data.contact.id)} · última interação ${fmtDate(data.contact.last_seen_at)}</span></div></div>
    <div class="message-stream" id="messageStream">${(data.messages || []).map((m) => `<div class="bubble ${m.direction === 'outbound' ? 'outbound' : ''}"><p>${esc(m.text || '[mensagem sem texto]')}</p><time>${fmtDate(m.created_at)}</time></div>`).join('') || '<div class="loading-row">Sem mensagens.</div>'}</div>
    <form class="reply-form" id="replyForm"><textarea id="replyInput" maxlength="1000" placeholder="Responder pelo Instagram…"></textarea><button class="btn btn-primary" type="submit">Enviar</button></form>`;
  $('#replyForm').addEventListener('submit', sendConversationReply);
  requestAnimationFrame(() => { const stream = $('#messageStream'); if (stream) stream.scrollTop = stream.scrollHeight; });
}

async function sendConversationReply(event) {
  event.preventDefault();
  const input = $('#replyInput');
  const text = input.value.trim();
  if (!text || !state.currentConversation) return;
  try {
    input.disabled = true;
    await api(`/api/inbox/${encodeURIComponent(state.currentConversation)}/reply`, { method: 'POST', body: { text } });
    input.value = '';
    await openConversation(state.currentConversation, false);
    toast('Mensagem enviada');
  } catch (error) { toast('A Meta não enviou a mensagem', error.message, 'error'); }
  finally { if ($('#replyInput')) $('#replyInput').disabled = false; }
}

async function loadMetaMini() {
  try {
    const data = await api('/api/meta/status');
    state.metaStatus = data.status;
    const ok = Boolean(data.status.connected);
    $('#sidebarStatusDot').className = `status-dot ${ok ? 'ok' : 'bad'}`;
    $('#sidebarAccount').textContent = ok && data.status.account?.username ? `@${data.status.account.username}` : 'Instagram';
    $('#sidebarStatus').textContent = ok ? 'Conectado' : 'Configuração pendente';
  } catch {
    $('#sidebarStatusDot').className = 'status-dot bad';
    $('#sidebarStatus').textContent = 'Sem conexão';
  }
}

async function loadSettings() {
  const [statusData, webhookData] = await Promise.all([api('/api/meta/status'), api('/api/webhook-info')]);
  state.metaStatus = statusData.status;
  const status = statusData.status;
  const ok = Boolean(status.connected);
  $('#metaStatusPill').className = `pill ${ok ? 'success' : 'failed'}`;
  $('#metaStatusPill').textContent = ok ? 'CONECTADO' : 'PENDENTE';
  $('#metaAccountCard').innerHTML = `<div class="avatar-placeholder">IG</div><div><strong>${ok && status.account?.username ? `@${esc(status.account.username)}` : 'Instagram não sincronizado'}</strong><span>${ok ? `${esc(status.account?.account_type || 'Profissional')} · API ${esc(status.apiVersion || '')}` : esc(status.error || 'Configure os secrets necessários.')}</span></div>`;
  const configured = status.configured || {};
  $('#secretGrid').innerHTML = [
    ['Access Token', configured.accessToken], ['App Secret', configured.appSecret], ['Verify Token', configured.verifyToken],
  ].map(([name, yes]) => `<div class="secret-item ${yes ? 'ok' : 'bad'}"><strong>${esc(name)}</strong><span>${yes ? 'Configurado' : 'Faltando'}</span></div>`).join('');
  $('#webhookUrl').value = webhookData.webhookUrl;
  renderChecklist(status, webhookData);
  $('#sidebarStatusDot').className = `status-dot ${ok ? 'ok' : 'bad'}`;
  $('#sidebarAccount').textContent = ok && status.account?.username ? `@${status.account.username}` : 'Instagram';
  $('#sidebarStatus').textContent = ok ? 'Conectado' : 'Configuração pendente';
}

function renderChecklist(status, webhook) {
  const items = [
    ['ADMIN_PASSWORD e SESSION_SECRET', true, 'O painel está autenticado, então esses secrets já estão operacionais.'],
    ['INSTAGRAM_ACCESS_TOKEN', webhook.secrets.accessTokenConfigured, 'Token de uma conta profissional com as permissões necessárias.'],
    ['META_APP_SECRET', webhook.secrets.appSecretConfigured, 'Usado para validar a assinatura X-Hub-Signature-256 dos webhooks.'],
    ['META_VERIFY_TOKEN', webhook.secrets.verifyTokenConfigured, 'O mesmo valor deve ser informado na configuração do webhook na Meta.'],
    ['Conta profissional sincronizada', Boolean(status.connected), status.connected ? `@${status.account?.username || status.account?.id}` : (status.error || 'Sincronize quando o token estiver pronto.')],
    ['Assinaturas comments + messages', false, 'Confirme manualmente esses dois campos no painel do Meta for Developers.'],
  ];
  $('#setupChecklist').innerHTML = items.map(([title, ok, copy]) => `<div class="check-item ${ok ? 'ok' : ''}"><div class="check-mark">${ok ? '✓' : '·'}</div><div><strong>${esc(title)}</strong><span>${esc(copy)}</span></div></div>`).join('');
}

async function syncMeta() {
  try {
    $('#syncMetaBtn').disabled = true;
    const data = await api('/api/meta/sync', { method: 'POST' });
    toast('Instagram sincronizado', data.account?.username ? `@${data.account.username}` : data.account?.id || 'Conta conectada');
    state.media = null;
    await loadSettings();
  } catch (error) { toast('Falha ao sincronizar', error.message, 'error'); }
  finally { $('#syncMetaBtn').disabled = false; }
}

async function openSimulate() {
  $('#simulateModal').classList.remove('hidden');
  $('#simulationResult').classList.add('hidden');
  await fillMediaSelects($('#simulateMedia').value);
}

async function runSimulation(event) {
  event.preventDefault();
  const resultEl = $('#simulationResult');
  try {
    const data = await api('/api/simulate', { method: 'POST', body: { text: $('#simulateText').value, media_id: $('#simulateMedia').value || null } });
    const result = data.result;
    resultEl.classList.remove('hidden', 'success', 'failed');
    if (result.matched) {
      resultEl.classList.add('success');
      resultEl.innerHTML = `<strong>✓ Regra encontrada: ${esc(result.automation.name)}</strong><span>Essa automação venceria a simulação.</span><div class="simulation-copy">${esc(result.automation.reply_text)}</div>`;
    } else {
      resultEl.classList.add('failed');
      resultEl.innerHTML = `<strong>Nenhuma mensagem seria enviada</strong><span>${esc(result.reason || 'Nenhuma regra correspondeu.')}</span>`;
    }
  } catch (error) {
    resultEl.classList.remove('hidden', 'success'); resultEl.classList.add('failed');
    resultEl.innerHTML = `<strong>Falha na simulação</strong><span>${esc(error.message)}</span>`;
  }
}

function bindEvents() {
  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#loginError').textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: { password: $('#password').value } });
      $('#password').value = '';
      showApp();
      setView(location.hash.slice(1) || 'dashboard');
    } catch (error) { $('#loginError').textContent = error.message; }
  });

  $('#logoutBtn').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); } catch {} showLogin(); });
  $$('.nav-item[data-view]').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));
  $$('[data-go]').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.go)));
  $('#newAutomationTop').addEventListener('click', () => openAutomationModal());
  $('#newAutomationBtn').addEventListener('click', () => openAutomationModal());
  $('#automationForm').addEventListener('submit', saveAutomation);
  $$('[data-close-modal]').forEach((btn) => btn.addEventListener('click', closeAutomationModal));
  $('#triggerType').addEventListener('change', updateAutomationConditionalFields);
  $('#mediaScope').addEventListener('change', updateAutomationConditionalFields);
  $('#replyText').addEventListener('input', () => { $('#replyCount').textContent = $('#replyText').value.length; });
  $('#automationModal').addEventListener('click', (e) => { if (e.target === $('#automationModal')) closeAutomationModal(); });
  $('#killSwitchBtn').addEventListener('click', () => toggleGlobalPause(false));
  $$('[data-global-resume]').forEach((btn) => btn.addEventListener('click', () => toggleGlobalPause(true)));
  $('#refreshActivity').addEventListener('click', loadActivity);
  $('#syncMetaBtn').addEventListener('click', syncMeta);
  $('#simulateBtn').addEventListener('click', openSimulate);
  $('#simulateForm').addEventListener('submit', runSimulation);
  $$('[data-close-simulate]').forEach((btn) => btn.addEventListener('click', () => $('#simulateModal').classList.add('hidden')));
  $('#simulateModal').addEventListener('click', (e) => { if (e.target === $('#simulateModal')) $('#simulateModal').classList.add('hidden'); });
  $$('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
    const input = $(btn.dataset.copy); if (!input) return;
    await navigator.clipboard.writeText(input.value); toast('Copiado');
  }));
  $('#openSidebar').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#mobileBackdrop').classList.add('open'); });
  $('#closeSidebar').addEventListener('click', () => { $('#sidebar').classList.remove('open'); $('#mobileBackdrop').classList.remove('open'); });
  $('#mobileBackdrop').addEventListener('click', () => { $('#sidebar').classList.remove('open'); $('#mobileBackdrop').classList.remove('open'); });

  let searchTimer;
  $('#contactSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadContacts().catch(() => {}), 280); });
}

async function boot() {
  bindEvents();
  try {
    const session = await api('/api/session');
    if (!session.authenticated) return showLogin();
    showApp();
    setView(location.hash.slice(1) || 'dashboard');
  } catch { showLogin(); }
}

document.addEventListener('DOMContentLoaded', boot);
