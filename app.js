const $ = (id) => document.getElementById(id);
const state = { tab: 'paste', rows: [], columns: [], results: [], exportSource: null, running: false, importing: false };
const hints = {
  rule: '规则仅作关键词演示，不能可靠理解语义或否定，结果需要人工复核。',
  jev: '文本将发送至第三方 OpenRouter；请先脱敏并确认符合机构隐私要求。',
  local: '文本发送至本机配置的模型服务；请确认服务运行及数据处理方式。'
};

function setTab(tab) {
  if (state.running) return;
  state.tab = tab;
  for (const name of ['paste', 'upload']) {
    const active = name === tab;
    $(name + '-tab').classList.toggle('active', active);
    $(name + '-tab').setAttribute('aria-selected', String(active));
    $(name + '-pane').hidden = !active;
  }
  feedback('');
}

function feedback(message, error = false) {
  const element = $('feedback');
  element.textContent = message;
  element.hidden = !message;
  element.classList.toggle('error', error);
}

async function request(url, options) {
  const response = await fetch(url, options);
  let data;
  try { data = await response.json(); } catch { throw new Error('服务响应格式无效，请检查后端服务。'); }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

async function importFile(file) {
  if (!file || state.running || state.importing) return;
  state.rows = [];
  state.columns = [];
  $('import-details').hidden = true;
  $('column-select').replaceChildren();
  if (!/\.(csv|xlsx)$/i.test(file.name)) return feedback('请选择 CSV 或 XLSX 文件。', true);
  if (file.size > 10 * 1024 * 1024) return feedback('文件超过 10 MiB 限制。', true);
  const form = new FormData();
  form.append('file', file);
  state.importing = true;
  $('file-input').disabled = true;
  feedback('正在读取文件…');
  try {
    const data = await request('/api/import', { method: 'POST', body: form });
    if (!Array.isArray(data.columns) || !Array.isArray(data.rows)) throw new Error('导入结果格式无效。');
    state.rows = data.rows;
    state.columns = data.columns;
    $('file-name').textContent = file.name;
    $('file-count').textContent = `已读取 ${data.rows.length} 条记录 · ${data.columns.length} 列`;
    $('column-select').replaceChildren();
    for (const column of data.columns) {
      const option = document.createElement('option');
      option.value = column;
      option.textContent = column;
      $('column-select').append(option);
    }
    const suggested = data.columns.find((name) => /小结|总结|记录|内容|summary|note/i.test(name));
    if (suggested) $('column-select').value = suggested;
    $('import-details').hidden = false;
    feedback('文件已读取，请确认小结所在列。');
  } catch (error) {
    feedback(error.message || '文件导入失败。', true);
  } finally {
    state.importing = false;
    $('file-input').disabled = false;
    $('file-input').value = '';
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function renderResults() {
  const results = $('results');
  results.replaceChildren();
  for (const item of state.results.slice(0, 200)) {
    const card = element('article', 'result-card', '');
    const top = element('div', 'result-card-top', '');
    top.append(element('span', 'result-index', `记录 ${String(item.row).padStart(2, '0')}`));
    top.append(element('span', 'review-badge', item.error ? '处理失败' : '待人工复核'));
    card.append(top);
    card.append(element('p', 'result-text', item.text));
    const tags = element('div', 'tags', '');
    for (const category of item.categories) tags.append(element('span', 'tag', category));
    if (item.error) tags.append(element('span', 'tag error', '分类失败'));
    if (!item.error && !item.categories.length) tags.append(element('span', 'tag', '未分类'));
    card.append(tags);
    card.append(element('div', 'result-detail', item.error || (item.keywords.length ? `规则匹配：${item.keywords.join('、')} · 仅为关键词演示` : item.mode === 'rule' ? '未匹配关键词，分类不确定，请人工判断。' : '模型结果仅供参考，请人工复核。')));
    results.append(card);
  }
  if (state.results.length > 200) results.append(element('p', 'result-detail', '页面仅展示前 200 条，导出文件包含全部结果。'));
  const success = state.results.filter((item) => !item.error);
  $('empty-state').hidden = state.results.length > 0;
  $('result-count').textContent = String(state.results.length);
  $('processed-count').textContent = String(success.length);
  $('review-count').textContent = String(success.length);
  $('export-button').disabled = !state.results.length || state.running;
}

async function classify() {
  if (state.running || state.importing) return;
  const mode = $('mode-select').value;
  let entries;
  if (state.tab === 'paste') {
    const text = $('note-text').value.trim();
    if (!text) return feedback('请先输入一条小结。', true);
    entries = [{ row: 1, text }];
  } else {
    if (!state.columns.length) return feedback('请先导入文件并选择小结列。', true);
    const column = $('column-select').value;
    entries = state.rows.map((row, index) => ({ row: index + 1, text: String(row[column] ?? '').trim() })).filter((entry) => entry.text);
    if (!entries.length) return feedback('所选列没有可分类的内容。', true);
  }
  if (mode === 'jev' && !window.confirm('在线 Jev 会将小结文本发送至第三方 OpenRouter。请确认已完成脱敏并符合机构要求，是否继续？')) return;
  state.running = true;
  state.results = [];
  state.exportSource = state.tab === 'upload' ? { columns: [...state.columns], rows: state.rows.map((row) => ({ ...row })) } : null;
  $('classify-button').disabled = true;
  $('mode-select').disabled = true;
  $('column-select').disabled = true;
  $('file-input').disabled = true;
  $('clear-file').disabled = true;
  $('note-text').disabled = true;
  $('sample-button').disabled = true;
  $('sample2-button').disabled = true;
  $('paste-tab').disabled = true;
  $('upload-tab').disabled = true;
  $('status-label').textContent = '正在分类';
  renderResults();
  let failed = 0;
  for (const entry of entries) {
    feedback(`正在处理 ${state.results.length + 1} / ${entries.length} 条…`);
    try {
      const result = await request('/api/classify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: entry.text, mode }) });
      if (!Array.isArray(result.categories) || typeof result.review !== 'boolean') throw new Error('分类结果格式无效。');
      state.results.push({ ...entry, mode, categories: result.categories.filter((category) => typeof category === 'string'), keywords: Array.isArray(result.matched_keywords) ? result.matched_keywords : [], error: '' });
    } catch (error) {
      failed += 1;
      state.results.push({ ...entry, mode, categories: [], keywords: [], error: error.message || '分类失败' });
    }
    renderResults();
  }
  state.running = false;
  for (const id of ['classify-button', 'mode-select', 'column-select', 'file-input', 'clear-file', 'note-text', 'sample-button', 'sample2-button', 'paste-tab', 'upload-tab']) $(id).disabled = false;
  $('status-label').textContent = failed ? '处理完成，有失败' : '处理完成';
  renderResults();
  feedback(`处理完成：成功 ${entries.length - failed} 条${failed ? `，失败 ${failed} 条` : ''}。请逐条人工复核。`, failed > 0);
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+\-@＝＋－＠\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function exportCsv() {
  if (!state.results.length) return;
  const columns = state.exportSource ? state.exportSource.columns : [];
  const used = new Set(columns);
  const resultColumns = ['导入记录序号', '小结内容', '分类标签', '人工复核', '分类模式', '匹配关键词', '错误信息'].map((name) => {
    let column = name;
    let suffix = 2;
    while (used.has(column)) column = `${name}（${suffix++}）`;
    used.add(column);
    return column;
  });
  const resultValues = (item, row) => item ? [row, item.text, item.categories.join('；'), item.error ? '分类失败' : '需要', item.mode, item.keywords.join('；'), item.error] : [row, '', '', '', '', '', ''];
  const rows = [[...columns, ...resultColumns]];
  if (state.exportSource) {
    const resultsByRow = new Map(state.results.map((item) => [item.row, item]));
    state.exportSource.rows.forEach((record, index) => rows.push([...columns.map((column) => record[column]), ...resultValues(resultsByRow.get(index + 1), index + 1)]));
  } else {
    for (const item of state.results) rows.push(resultValues(item, item.row));
  }
  const blob = new Blob(['\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = '透析小结分类结果.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('paste-tab').addEventListener('click', () => setTab('paste'));
$('upload-tab').addEventListener('click', () => setTab('upload'));
$('sample-button').addEventListener('click', () => { $('note-text').value = '患者于透析2小时40分钟突感下肢疼痛，予以回氯化0.9%氯化钠300毫升后缓解。'; $('note-text').dispatchEvent(new Event('input')); });
$('sample2-button').addEventListener('click', () => { $('note-text').value = '患者透析1小时感觉头痛，测血压175的95毫米汞柱，予以硝苯地平片10毫克舌下含服后感头痛缓解。'; $('note-text').dispatchEvent(new Event('input')); });
$('note-text').addEventListener('input', () => { $('char-count').textContent = `${$('note-text').value.length.toLocaleString()} / 30,000`; });
$('mode-select').addEventListener('change', () => { $('mode-hint').lastChild.textContent = hints[$('mode-select').value]; });
$('file-input').addEventListener('change', (event) => importFile(event.target.files[0]));
$('clear-file').addEventListener('click', () => { state.rows = []; state.columns = []; $('import-details').hidden = true; $('column-select').replaceChildren(); feedback(''); });
$('classify-button').addEventListener('click', classify);
$('export-button').addEventListener('click', exportCsv);
const dropzone = document.querySelector('.upload-zone');
for (const name of ['dragenter', 'dragover']) dropzone.addEventListener(name, (event) => { event.preventDefault(); if (!state.running) dropzone.classList.add('dragging'); });
for (const name of ['dragleave', 'drop']) dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.remove('dragging'); });
dropzone.addEventListener('drop', (event) => importFile(event.dataTransfer.files[0]));
