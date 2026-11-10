(() => {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  const fields = { default: '#providerModelDefault', small: '#providerModelSmall', big: '#providerModelBig', think: '#providerModelThink' };
  let state = { providers: [], activeProviderId: null };
  let editingId = null, catalog = [], dirty = false, busy = false, loaded = false;

  function status(message, error = false) {
    $('#providerStatus').textContent = message;
    $('#providerStatus').className = 'provider-status ' + (error ? 'error' : 'success');
  }

  async function api(endpoint, method = 'GET', body) {
    const response = await fetch(endpoint, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `操作失败（HTTP ${response.status}）`);
    return data;
  }

  async function action(button, pendingText, fn) {
    if (busy) return;
    busy = true;
    const oldText = button.textContent;
    button.textContent = pendingText;
    $('#providerFields').disabled = true;
    $('#view-providers').setAttribute('aria-busy', 'true');
    for (const item of $('#view-providers').querySelectorAll('button')) item.disabled = true;
    try { await fn(); } catch (error) { status(error.message, true); }
    finally {
      busy = false;
      button.textContent = oldText;
      $('#providerFields').disabled = false;
      $('#view-providers').removeAttribute('aria-busy');
      for (const item of $('#view-providers').querySelectorAll('button')) item.disabled = false;
      $('#providerKey').disabled = $('#providerNoKey').checked;
    }
  }

  function render() {
    $('#providerList').innerHTML = state.providers.length ? state.providers.map(provider => {
      const active = provider.id === state.activeProviderId;
      return `<article class="provider-card ${active ? 'active' : ''}">
        <div class="row"><h2 class="grow">${esc(provider.name)}</h2><span class="badge ${active ? 'ok' : 'dim'}">${active ? '使用中' : '未启用'}</span></div>
        <p class="note">${esc(provider.baseUrl)}</p><p class="note">${provider.hasApiKey ? '已保存 API Key' : '免密访问'} · ${(provider.catalog || []).length} 个已获取模型</p>
        <p class="provider-model-line"><span class="muted">默认</span> <code>${esc(provider.models.default)}</code><br><span class="muted">轻量</span> <code>${esc(provider.models.small || provider.models.default)}</code><br><span class="muted">主力</span> <code>${esc(provider.models.big || provider.models.default)}</code></p>
        <div class="row" data-id="${esc(provider.id)}"><button class="ghost" type="button" data-action="edit">编辑</button>${active ? '' : '<button class="ghost primary" type="button" data-action="activate">启用</button><button class="ghost danger" type="button" data-action="delete">删除</button>'}</div>
      </article>`;
    }).join('') : '<div class="panel empty">还没有供应商<br>填写右侧配置，连接你的第一个上游。</div>';
    if (state.connection) {
      $('#claudeGatewayUrl').textContent = state.connection.baseUrl;
      $('#claudeGatewayAuth').textContent = state.connection.gatewayKeyRequired ? 'API Key 使用 config.json 中的 gatewayApiKey' : 'API Key 可填写 local-gateway';
    }
  }

  function options() {
    $('#providerModelOptions').innerHTML = catalog.map(model => `<option value="${esc(model.id)}"></option>`).join('');
    $('#modelDiscoveryStatus').textContent = catalog.length ? `已获取 ${catalog.length} 个模型，输入框可搜索选择。` : '获取后可选择，也可直接填写模型 ID。';
  }

  function edit(provider = null) {
    editingId = provider?.id || null;
    catalog = provider?.catalog || [];
    $('#providerEditorTitle').textContent = provider ? `编辑 · ${provider.name}` : '添加供应商';
    $('#providerName').value = provider?.name || '';
    $('#providerUrl').value = provider?.baseUrl || '';
    $('#providerKey').value = '';
    $('#providerKey').placeholder = provider?.hasApiKey ? '已保存，留空保留原 Key' : '输入上游 API Key';
    $('#providerNoKey').checked = !!provider && !provider.hasApiKey;
    $('#providerKey').disabled = $('#providerNoKey').checked;
    for (const [slot, selector] of Object.entries(fields)) $(selector).value = provider?.models?.[slot] || '';
    options();
    dirty = false;
  }

  function input() {
    return { ...(editingId ? { id: editingId } : {}), name: $('#providerName').value.trim(), baseUrl: $('#providerUrl').value.trim(),
      apiKey: $('#providerKey').value, clearApiKey: $('#providerNoKey').checked,
      models: Object.fromEntries(Object.entries(fields).map(([slot, selector]) => [slot, $(selector).value.trim()])), catalog };
  }

  function discard() { return !dirty || confirm('有尚未保存的修改，确定放弃吗？'); }

  async function load() {
    try {
      state = await api('/admin/providers');
      loaded = true;
      render();
      if (!state.providers.length) {
        status('填写 URL 和 Key → 获取模型 → 保存并启用。');
        $('#tabs button[data-view="providers"]').click();
      }
    } catch (error) { status(error.message, true); }
  }

  $('#providerForm').addEventListener('input', () => { dirty = true; });
  $('#providerUrl').addEventListener('change', () => { catalog = []; options(); });
  $('#providerKey').addEventListener('change', () => { catalog = []; options(); });
  $('#providerNoKey').addEventListener('change', () => {
    $('#providerKey').disabled = $('#providerNoKey').checked;
    if ($('#providerNoKey').checked) $('#providerKey').value = '';
    catalog = []; options();
  });
  $('#newProvider').onclick = () => { if (!busy && discard()) { edit(); $('#providerName').focus(); } };
  $('#cancelProvider').onclick = () => { if (!busy && discard()) edit(); };

  $('#discoverModels').onclick = event => {
    if (!$('#providerUrl').reportValidity()) return;
    action(event.currentTarget, '正在获取…', async () => {
      const data = await api('/admin/providers/discover', 'POST', input());
      catalog = data.catalog;
      options();
      if (!$('#providerModelDefault').value && catalog.length) $('#providerModelDefault').value = catalog[0].id;
      dirty = true;
      status(catalog.length ? `获取到 ${catalog.length} 个模型，请确认默认模型后保存。` : '上游返回空列表，可以手动填写模型 ID。');
    });
  };

  $('#providerForm').addEventListener('submit', event => {
    event.preventDefault();
    const button = event.submitter || $('#saveProvider');
    const activate = button.id === 'saveActivateProvider';
    action(button, '正在保存…', async () => {
      const result = await api('/admin/providers', 'POST', input());
      state = result;
      const saved = result.providers.find(provider => provider.id === result.savedId);
      edit(saved); render();
      if (activate) state = await api(`/admin/providers/${encodeURIComponent(saved.id)}/activate`, 'POST', {});
      render();
      status(activate ? `已启用「${saved.name}」，后续 Claude 请求使用此供应商。` : '已保存供应商配置。');
    });
  });

  $('#providerList').onclick = event => {
    const button = event.target.closest('button[data-action]');
    if (!button || busy) return;
    const provider = state.providers.find(item => item.id === button.closest('[data-id]').dataset.id);
    if (button.dataset.action === 'edit') { if (discard()) { edit(provider); $('#providerName').focus(); } return; }
    if (button.dataset.action === 'delete' && !confirm(`删除「${provider.name}」及其本机保存的 Key？`)) return;
    const activate = button.dataset.action === 'activate';
    action(button, activate ? '启用中…' : '删除中…', async () => {
      state = await api(`/admin/providers/${encodeURIComponent(provider.id)}${activate ? '/activate' : ''}`, activate ? 'POST' : 'DELETE', {});
      if (!activate && editingId === provider.id) edit();
      render();
      status(activate ? `已启用「${provider.name}」，无需重启网关。` : '已删除供应商。');
    });
  };

  $('#setupClaude').onclick = event => action(event.currentTarget, '正在生成…', async () => {
    const result = await api('/admin/claude-profile', 'POST', {});
    $('#claudeProfileStatus').textContent = `已生成：${result.profilePath}`;
    status('专用配置已就绪。请从项目目录运行 Claude 包装器。');
  });
  $('#tabs').addEventListener('click', event => { if (event.target.closest('[data-view="providers"]') && !loaded) load(); });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  load();
})();
