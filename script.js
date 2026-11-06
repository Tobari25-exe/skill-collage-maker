import { MosaicEngine } from './mosaic-browser.js?v=20261107-precision5';

'use strict';
const el = id => document.getElementById(id);
const state = { engine: null, imageUrl: null, text: null, kanaInsensitive: false,
  signature: null, hasAlternative: false, busy: false };
function showError(message) {
  const element = el('error');
  element.textContent = message;
  element.hidden = !message;
}
function clearImage() {
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.imageUrl = null;
  state.text = null;
  state.kanaInsensitive = false;
  state.signature = null;
  state.hasAlternative = false;
  el('preview').removeAttribute('src');
  el('previewViewport').hidden = true;
  refreshButtons();
}
function refreshButtons() {
  el('generate').disabled = state.busy;
  el('reroll').disabled = state.busy || !state.hasAlternative ||
    state.text !== el('inputText').value || state.kanaInsensitive !== el('kanaInsensitive').checked;
  el('save').disabled = state.busy || !state.imageUrl ||
    state.text !== el('inputText').value || state.kanaInsensitive !== el('kanaInsensitive').checked;
  document.body.classList.toggle('busy', state.busy);
}
async function getEngine() {
  if (state.engine) return state.engine;
  const response = await fetch('./data/catalog.json?v=20261107-precision5');
  if (!response.ok) throw new Error('素材データを読み込めませんでした。');
  state.engine = new MosaicEngine(await response.json());
  return state.engine;
}
async function generate(reroll = false) {
  if (state.busy) return;
  const text = el('inputText').value;
  const kanaInsensitive = el('kanaInsensitive').checked;
  if (!text.trim()) { showError('文章を入力してください。'); return; }
  if (reroll && (!state.hasAlternative || state.text !== text || state.kanaInsensitive !== kanaInsensitive)) return;
  showError('');
  state.busy = true;
  refreshButtons();
  try {
    const engine = await getEngine();
    let result = engine.search(text, { kanaInsensitive });
    if (reroll && state.signature && result.has_alternative) {
      for (let i = 0; i < 16 && engine.signature(result) === state.signature; i++) {
        result = engine.search(text, { kanaInsensitive });
      }
    }
    if (!result.complete) throw new Error('素材にない文字：' + result.missing);
    const blob = await engine.render(result);
    const imageUrl = URL.createObjectURL(blob);
    if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
    state.imageUrl = imageUrl;
    state.text = text;
    state.kanaInsensitive = kanaInsensitive;
    state.signature = engine.signature(result);
    state.hasAlternative = result.has_alternative;
    el('preview').src = imageUrl;
    el('previewViewport').hidden = false;
  } catch (error) {
    if (!reroll) clearImage();
    showError(error.message || '画像を作成できませんでした。');
  } finally {
    state.busy = false;
    refreshButtons();
  }
}
el('generate').addEventListener('click', () => generate(false));
el('reroll').addEventListener('click', () => generate(true));
el('save').addEventListener('click', () => {
  if (!state.imageUrl) return;
  const download = document.createElement('a');
  download.href = state.imageUrl;
  download.download = '素質コラ.png';
  document.body.appendChild(download);
  download.click();
  download.remove();
});
el('inputText').addEventListener('input', () => {
  if (state.text !== el('inputText').value) clearImage();
  showError('');
  refreshButtons();
});
el('kanaInsensitive').addEventListener('change', () => {
  clearImage();
  showError('');
  refreshButtons();
});
el('inputText').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    generate(false);
  }
});
refreshButtons();
