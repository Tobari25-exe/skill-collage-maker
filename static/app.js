'use strict';
const el = id => document.getElementById(id);
const state = { imageUrl: null, text: null, kanaInsensitive: false, signature: null, hasAlternative: false, busy: false };

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
  el('save').disabled = true;
  el('reroll').disabled = true;
}
function refreshButtons() {
  el('generate').disabled = state.busy;
  el('reroll').disabled = state.busy || !state.hasAlternative || (state.text !== el('inputText').value || state.kanaInsensitive !== el('kanaInsensitive').checked);
  el('save').disabled = state.busy || !state.imageUrl || (state.text !== el('inputText').value || state.kanaInsensitive !== el('kanaInsensitive').checked);
  document.body.classList.toggle('busy', state.busy);
}
async function generate(reroll = false) {
  if (state.busy) return;
  const text = el('inputText').value;
  const kanaInsensitive = el('kanaInsensitive').checked;
  if (!text.trim()) {
    showError('文章を入力してください。');
    return;
  }
  if (reroll && (!state.hasAlternative || state.text !== text || state.kanaInsensitive !== kanaInsensitive)) return;
  showError('');
  state.busy = true;
  refreshButtons();
  try {
    const params = { text, kana_insensitive: kanaInsensitive };
    if (reroll && state.signature) params.avoid_signature = state.signature;
    const response = await fetch('/api/compose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    if (!response.ok) {
      let error = {};
      try { error = await response.json(); } catch { /* response was not JSON */ }
      const message = response.status === 422
        ? '素材にない文字：' + (error.missing || '不明')
        : (typeof error.detail === 'string' ? error.detail : '画像を生成できませんでした。');
      throw new Error(message);
    }
    const blob = await response.blob();
    const nextUrl = URL.createObjectURL(blob);
    if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
    state.imageUrl = nextUrl;
    state.text = text;
    state.kanaInsensitive = kanaInsensitive;
    state.signature = response.headers.get('X-Mosaic-Signature');
    state.hasAlternative = response.headers.get('X-Mosaic-Has-Alternative') === 'true';
    el('preview').src = nextUrl;
    el('previewViewport').hidden = false;
  } catch (error) {
    if (!reroll) clearImage();
    showError(error.message);
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
