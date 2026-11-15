(async () => {
  const style = document.createElement('style'); style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }'; document.head.append(style);
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn) { for (let i = 0; i < 100; i++) { const x = fn(); if (x) return x; await nap(100); } throw new Error('Timed out waiting for UI'); }
  const assert = (v, m) => { if (!v) throw new Error(m); };
  const nav = (text) => [...document.querySelectorAll('.nav-item')].find((e) => e.textContent.trim() === text || e.getAttribute('aria-label') === text);
  function result(text) { const p = document.createElement('pre'); p.id = 'safety-ui-test-result'; p.textContent = text; p.style.cssText = 'position:fixed;bottom:0;left:0;z-index:9999;background:#fff;color:#111'; document.body.append(p); }
  try {
    (await until(() => nav('Settings'))).click();
    const consent = await until(() => document.querySelector('[role=switch][aria-label="Allow cloud AI"]'));
    assert(consent.getAttribute('aria-checked') === 'false', 'Cloud consent must default off');
    consent.click(); await until(() => document.querySelector('[aria-label="Allow cloud AI"]').getAttribute('aria-checked') === 'true');
    document.querySelector('[aria-label="Allow cloud AI"]').click();
    await until(() => document.querySelector('[aria-label="Allow cloud AI"]').getAttribute('aria-checked') === 'false');
    document.querySelector('[aria-label="Ask before cleaning"]').click();
    await nap(300); assert(document.querySelector('[aria-label="Ask before cleaning"]').getAttribute('aria-checked') === 'true', 'Confirmation must remain on');
    nav('Assistant').click(); await until(() => document.querySelector('main').textContent.includes('Cloud AI is off'));
    assert(document.querySelector('[aria-label="Send"]').disabled, 'Cloud chat must be disabled without consent');
    nav('Speed').click(); await until(() => document.querySelector('main').textContent.includes('Read-only'));
    assert(!document.querySelector('main [role=switch]'), 'Startup inventory must not expose toggles');
    nav('Cleanup').click(); const checkbox = await until(() => document.querySelector('main input[type=checkbox]'));
    assert([...document.querySelectorAll('main input[type=checkbox]')].every((e) => !e.checked), 'Cleanup must not auto-select');
    checkbox.click();
    const clean = await until(() => [...document.querySelectorAll('main button')].find((e) => e.textContent.trim().startsWith('Clean') && !e.disabled));
    clean.click(); await until(() => document.querySelector('[role=alertdialog]'));
    assert(document.querySelector('[role=alertdialog]').textContent.includes('Move') && document.querySelector('[role=alertdialog]').textContent.includes('Trash'), 'Confirmation must describe recoverable removal');
    [...document.querySelectorAll('[role=alertdialog] button')].find((e) => e.textContent.trim() === 'Cancel').click();
    await until(() => !document.querySelector('[role=alertdialog]'));
    nav('Settings').click(); await until(() => document.querySelector('[aria-label="Allow cloud AI"]'));
    result('PASS: cloud opt-in/revocation, mandatory confirmation, disabled chat, read-only startup, empty selection, recoverable confirmation, cancel.');
  } catch (e) { result('FAIL: ' + e.message); }
})();
