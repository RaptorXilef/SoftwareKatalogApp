import { escapeHTML, sanitizeChangelogHtml } from './sanitize.js';

function formatInline(escapedLine) {
  return escapedLine
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
}

/**
 * Wandelt typisches GitHub-/Winget-Markdown sicher in bereinigtes HTML um.
 */
export function renderMarkdownSafe(markdown) {
  if (!markdown) return '';
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    const headingMatch = trimmed.match(/^#{1,4}\s+(.+)$/);
    if (headingMatch) {
      closeList();
      out.push(`<h4>${formatInline(escapeHTML(headingMatch[1]))}</h4>`);
      continue;
    }

    const listMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (listMatch) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${formatInline(escapeHTML(listMatch[1]))}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${formatInline(escapeHTML(trimmed))}</p>`);
  }

  closeList();
  return sanitizeChangelogHtml(out.join('\n'));
}
