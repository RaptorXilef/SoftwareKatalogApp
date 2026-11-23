import { getCatalogItemById } from '../state.js';
import { toMediaUrl } from '../utils/sanitize.js';

let mediaList = [];
let currentIdx = 0;

function updateView() {
  const img = document.getElementById('lightboxImg');
  const vid = document.getElementById('lightboxVid');
  const leftBtn = document.getElementById('lightboxBtnLeft');
  const rightBtn = document.getElementById('lightboxBtnRight');

  const path = mediaList[currentIdx];
  const url = toMediaUrl(path);
  const isVid = /\.(mp4|webm|ogg|mov|avi)$/i.test(path);

  if (isVid) {
    img.hidden = true;
    vid.hidden = false;
    vid.src = url;
  } else {
    vid.pause();
    vid.src = '';
    vid.hidden = true;
    img.hidden = false;
    img.src = url;
  }

  const showArrows = mediaList.length > 1;
  leftBtn.hidden = !showArrows;
  rightBtn.hidden = !showArrows;
}

export function openLightbox(itemId, index = 0) {
  const item = getCatalogItemById(itemId);
  if (!item?.screenshots?.length) return;
  mediaList = item.screenshots;
  currentIdx = Math.max(0, Math.min(index, mediaList.length - 1));
  updateView();
  document.getElementById('lightboxOverlay').hidden = false;
}

export function closeLightbox() {
  const overlay = document.getElementById('lightboxOverlay');
  const vid = document.getElementById('lightboxVid');
  if (vid) {
    vid.pause();
    vid.src = '';
  }
  if (overlay) overlay.hidden = true;
}

export function isLightboxOpen() {
  const overlay = document.getElementById('lightboxOverlay');
  return Boolean(overlay && !overlay.hidden);
}

export function nextLightbox() {
  if (mediaList.length <= 1) return;
  currentIdx = (currentIdx + 1) % mediaList.length;
  updateView();
}

export function prevLightbox() {
  if (mediaList.length <= 1) return;
  currentIdx = (currentIdx - 1 + mediaList.length) % mediaList.length;
  updateView();
}

export function initLightbox() {
  const overlay = document.getElementById('lightboxOverlay');
  document.getElementById('lightboxBtnClose')?.addEventListener('click', closeLightbox);
  document.getElementById('lightboxBtnLeft')?.addEventListener('click', (e) => {
    e.stopPropagation();
    prevLightbox();
  });
  document.getElementById('lightboxBtnRight')?.addEventListener('click', (e) => {
    e.stopPropagation();
    nextLightbox();
  });
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) closeLightbox();
  });
}
