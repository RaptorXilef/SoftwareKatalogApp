import { showToast } from '../components/toast.js';
import { getItemById, state } from '../state.js';

export function closeModal() {
  const overlay = document.getElementById('modalOverlay');
  if (overlay) overlay.hidden = true;
  state.currentModalId = null;
  state.isEditModalOpen = false;
}

export function openDetailModal(id) {
  const item = getItemById(id);
  if (!item) return;
  showToast(`Detail-Ansicht für "${item.name}" folgt in Etappe 4.`, { type: 'info' });
}

export function openEditModal(id) {
  const item = getItemById(id);
  if (!item) return;
  showToast(`4-Tab-Bearbeiten-Modus für "${item.name}" folgt in Etappe 4.`, { type: 'info' });
}

export function openSettingsModal() {
  showToast('Neues Einstellungs-Modal folgt in Etappe 4.', { type: 'info' });
}
