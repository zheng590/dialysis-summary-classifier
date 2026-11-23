const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(fetch) {
  const elements = new Map();
  let exported;
  function makeElement() {
    return {
      value: '', hidden: false, disabled: false, textContent: '', lastChild: { textContent: '' },
      classList: { toggle() {}, add() {}, remove() {} },
      events: {}, addEventListener(name, fn) { this.events[name] = fn; },
      setAttribute() {}, replaceChildren() {}, append() {}, click() {}, dispatchEvent() {}
    };
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    createElement: makeElement,
    querySelector: makeElement
  };
  const context = vm.createContext({
    document, fetch, window: { confirm: () => true }, Blob,
    URL: { createObjectURL(blob) { exported = blob; return 'blob:test'; }, revokeObjectURL() {} },
    setTimeout() {}, Event: class {}, console
  });
  vm.runInContext(fs.readFileSync('app.js', 'utf8'), context);
  return { elements, context, exported: () => exported };
}

test('Jev 密码框仅在 Jev 模式显示', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /id="jev-key-section" hidden/);
  assert.match(html, /id="jev-key" type="password"[^>]*autocomplete="off"/);
  const { elements } = setup(() => {});
  const mode = elements.get('mode-select');
  mode.value = 'jev';
  mode.events.change();
  assert.equal(elements.get('jev-key-section').hidden, false);
  mode.value = 'local';
  mode.events.change();
  assert.equal(elements.get('jev-key-section').hidden, true);
});

test('批量固定密钥，结果和 CSV 不包含密钥', async () => {
  const requests = [];
  let app;
  app = setup(async (url, options) => {
    requests.push(JSON.parse(options.body));
    assert.equal(app.elements.get('jev-key').disabled, true);
    app.elements.get('jev-key').value = 'changed-key';
    return { ok: true, json: async () => ({ categories: [], review: true }) };
  });
  app.elements.get('mode-select').value = 'jev';
  app.context.document.getElementById('jev-key').value = 'private-key';
  vm.runInContext("state.tab = 'upload'; state.columns = ['小结']; state.rows = [{小结: '第一条'}, {小结: '第二条'}]; document.getElementById('column-select').value = '小结'", app.context);
  await vm.runInContext('classify()', app.context);
  assert.deepEqual(requests.map((request) => request.openrouter_api_key), ['private-key', 'private-key']);
  assert.equal(app.elements.get('jev-key').disabled, false);
  assert.doesNotMatch(vm.runInContext('JSON.stringify(state)', app.context), /private-key|changed-key/);
  vm.runInContext('exportCsv()', app.context);
  assert.doesNotMatch(await app.exported().text(), /private-key|changed-key/);
});

test('空密钥和其他模式不发送密钥', async () => {
  const requests = [];
  const app = setup(async (url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ categories: [], review: true }) };
  });
  app.elements.get('note-text').value = '测试';
  app.elements.get('mode-select').value = 'jev';
  await vm.runInContext('classify()', app.context);
  app.elements.get('mode-select').value = 'rule';
  app.elements.get('jev-key').value = 'private-key';
  await vm.runInContext('classify()', app.context);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => !Object.hasOwn(request, 'openrouter_api_key')));
});

test('JevStyle 独立显示密钥输入并提示第三方隐私风险', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /value="jevstyle"/);
  assert.match(html, /id="jevstyle-key-section" hidden/);
  assert.match(html, /id="jevstyle-key" type="password"[^>]*autocomplete="off"/);
  assert.match(html, /非 TypeSafe 官方服务/);
  assert.match(html, /留空使用.*JEVSTYLE_API_KEY/);
  assert.doesNotMatch(html, /后端尚未支持/);
  const { elements } = setup(() => {});
  const mode = elements.get('mode-select');
  for (const value of ['jevstyle', 'jev', 'local', 'rule']) {
    mode.value = value;
    mode.events.change();
    assert.equal(elements.get('jevstyle-key-section').hidden, value !== 'jevstyle');
    assert.equal(elements.get('jev-key-section').hidden, value !== 'jev');
  }
});

test('JevStyle 批量请求使用独立且固定的密钥，响应中的密钥不会进入结果或 CSV', async () => {
  const requests = [];
  let app;
  app = setup(async (url, options) => {
    requests.push(JSON.parse(options.body));
    assert.equal(app.elements.get('jevstyle-key').disabled, true);
    app.elements.get('jevstyle-key').value = 'changed-key';
    if (requests.length === 1) return { ok: false, json: async () => ({ error: '错误 private-key' }) };
    return { ok: true, json: async () => ({ categories: ['private-key'], matched_keywords: ['private-key'], review: true }) };
  });
  app.elements.get('mode-select').value = 'jevstyle';
  app.context.document.getElementById('jevstyle-key').value = 'private-key';
  app.context.document.getElementById('jev-key').value = 'openrouter-secret';
  vm.runInContext("state.tab = 'upload'; state.columns = ['小结']; state.rows = [{小结: '第一条'}, {小结: '第二条'}]; document.getElementById('column-select').value = '小结'", app.context);
  await vm.runInContext('classify()', app.context);
  assert.deepEqual(requests.map((item) => item.mode), ['jevstyle', 'jevstyle']);
  assert.deepEqual(requests.map((item) => item.jevstyle_api_key), ['private-key', 'private-key']);
  assert.ok(requests.every((item) => !Object.hasOwn(item, 'openrouter_api_key')));
  assert.equal(app.elements.get('jevstyle-key').disabled, false);
  assert.doesNotMatch(vm.runInContext('JSON.stringify(state)', app.context), /private-key|changed-key|openrouter-secret/);
  vm.runInContext('exportCsv()', app.context);
  assert.doesNotMatch(await app.exported().text(), /private-key|changed-key|openrouter-secret/);
});

test('JevStyle 空密钥回退环境变量，取消确认和其他模式不发送 JevStyle 密钥', async () => {
  const requests = [];
  const app = setup(async (url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ categories: [], review: true }) };
  });
  app.elements.get('note-text').value = '测试';
  app.elements.get('mode-select').value = 'jevstyle';
  const prompts = [];
  app.context.window.confirm = (message) => { prompts.push(message); return true; };
  await vm.runInContext('classify()', app.context);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].mode, 'jevstyle');
  assert.ok(!Object.hasOwn(requests[0], 'jevstyle_api_key'));
  assert.match(prompts[0], /第三方/);
  app.elements.get('jevstyle-key').value = '   ';
  await vm.runInContext('classify()', app.context);
  assert.equal(requests.length, 2);
  assert.ok(!Object.hasOwn(requests[1], 'jevstyle_api_key'));
  app.elements.get('jevstyle-key').value = 'private-key';
  app.context.window.confirm = () => false;
  await vm.runInContext('classify()', app.context);
  assert.equal(requests.length, 2);
  app.context.window.confirm = () => true;
  for (const mode of ['jev', 'local', 'rule']) {
    app.elements.get('mode-select').value = mode;
    await vm.runInContext('classify()', app.context);
  }
  assert.equal(requests.length, 5);
  assert.ok(requests.every((item) => !Object.hasOwn(item, 'jevstyle_api_key')));
});
