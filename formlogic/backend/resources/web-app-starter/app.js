import { api } from 'softn:api';

const form = document.getElementById('add-item');
const title = document.getElementById('title');
const submit = form.querySelector('button');
const items = document.getElementById('items');
const status = document.getElementById('status');
// In the editor, try the interface with temporary rows until the app has a connected backend.
let previewItems;

async function loadItems() {
  let rows = previewItems;
  if (!rows) {
    try {
      const response = await api.fetch('/api/items');
      if (!response.ok) throw new Error('Could not load your items.');
      rows = (await response.json()).items;
    } catch (error) {
      if (error.message !== 'This app has no connected backend.') throw error;
      previewItems = [];
      rows = previewItems;
    }
  }
  items.replaceChildren(...rows.map(item => {
    const row = document.createElement('li');
    row.textContent = item.title;
    return row;
  }));
  status.textContent = previewItems ? 'Preview items stay in this session.' : rows.length ? '' : 'Add your first item above.';
}

async function saveItem() {
  const value = title.value.trim();
  if (!value || submit.disabled) return;
  submit.disabled = true;
  try {
    if (previewItems) {
      previewItems.push({ title: value });
    } else {
      const response = await api.fetch('/api/items', { method: 'POST', body: { title: value } });
      if (!response.ok) throw new Error('Could not save the item.');
    }
    title.value = '';
    await loadItems();
    if (!previewItems) status.textContent = 'Item saved.';
  } catch (error) {
    status.textContent = error.message || 'Could not reach the database.';
  } finally {
    submit.disabled = false;
    title.focus();
  }
}

submit.addEventListener('click', saveItem);
title.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveItem();
  }
});

loadItems()
  .catch(() => { status.textContent = 'Could not load your items. Refresh to try again.'; })
  .finally(() => { submit.disabled = false; });
