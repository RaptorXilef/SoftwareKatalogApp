function getEditDistance(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const v0 = Array.from({ length: b.length + 1 }, (_, i) => i);
  const v1 = new Array(b.length + 1);
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }
  return v1[b.length];
}

function stripHtml(html) {
  if (!html) return '';
  return String(html).replace(/<[^>]*>/g, ' ');
}

function splitWords(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9äöüß+#]+/)
    .filter(Boolean);
}

function scoreFieldWords(queryWord, fieldWords, rawText, { exact, prefix, substring, fuzzy = 0 }) {
  if (!rawText) return 0;

  let best = 0;
  for (const w of fieldWords) {
    if (w === queryWord) return exact;
    if (w.startsWith(queryWord) && queryWord.length >= 2) {
      best = Math.max(best, prefix);
    }
  }

  if (best === 0 && rawText.includes(queryWord)) {
    best = Math.max(best, substring);
  }

  if (best === 0 && fuzzy > 0 && queryWord.length >= 4) {
    const maxDist = queryWord.length <= 5 ? 1 : 2;
    for (const w of fieldWords) {
      if (w.length < 3 || Math.abs(w.length - queryWord.length) > maxDist) continue;
      if (getEditDistance(queryWord, w) <= maxDist) {
        best = Math.max(best, fuzzy);
        break;
      }
    }
  }

  return best;
}

/**
 * Bewertet ein Katalog-Element gegen die Suchanfrage.
 * Rückgabe: { matched: boolean, score: number, isCoreMatch: boolean }
 */
export function scoreCatalogItem(item, rawQuery) {
  const queryWords = String(rawQuery || '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (queryWords.length === 0) {
    return { matched: true, score: 0, isCoreMatch: true };
  }

  const nameRaw = String(item.name || '').toLowerCase();
  const nameWords = splitWords(nameRaw);

  const searchNamesRaw = (item.searchNames || []).join(' ').toLowerCase();
  const searchNameWords = splitWords(searchNamesRaw);

  const tagsList = [
    ...(item.mainCategory ? [item.mainCategory] : []),
    ...(item.subCategories || []),
    ...(item.tags || []),
  ];
  const uniqueTags = [...new Set(tagsList.map((t) => String(t).toLowerCase().trim()).filter(Boolean))];
  const tagsRaw = uniqueTags.join(' ');
  const tagWords = splitWords(tagsRaw);

  const formatsNorm = (item.formats || [])
    .map((f) => String(f).toLowerCase().replace(/^\./, '').trim())
    .filter(Boolean);

  const descRaw = stripHtml(item.description).toLowerCase();
  const descWords = splitWords(descRaw);

  let totalScore = 0;
  let coreHits = 0;

  for (const qWord of queryWords) {
    const cleanQ = qWord.replace(/^\./, '');

    // 1. Programmname & alternative Suchnamen (höchste Gewichtung)
    const nameScore = Math.max(
      scoreFieldWords(qWord, nameWords, nameRaw, { exact: 100, prefix: 80, substring: 65, fuzzy: 35 }),
      scoreFieldWords(qWord, searchNameWords, searchNamesRaw, { exact: 75, prefix: 55, substring: 40, fuzzy: 20 })
    );

    // 2. Kategorie & Tags
    let tagScore = scoreFieldWords(qWord, tagWords, tagsRaw, { exact: 45, prefix: 32, substring: 25, fuzzy: 15 });
    if (uniqueTags.includes(qWord)) tagScore = Math.max(tagScore, 50);

    // 3. Dateiformate (z. B. "mkv" oder ".mkv", kein Fuzzy)
    let formatScore = 0;
    if (cleanQ && formatsNorm.includes(cleanQ)) formatScore = 35;
    else if (cleanQ && formatsNorm.some((f) => f.includes(cleanQ))) formatScore = 20;

    const coreWordScore = nameScore + tagScore + formatScore;

    // 4. Beschreibung (bewusst niedrig gewichtet, KEIN Fuzzy-Matching!)
    const descScore = scoreFieldWords(qWord, descWords, descRaw, {
      exact: 10,
      prefix: 6,
      substring: 4,
      fuzzy: 0,
    });

    if (coreWordScore === 0 && descScore === 0) {
      return { matched: false, score: 0, isCoreMatch: false };
    }

    if (coreWordScore > 0) coreHits++;
    totalScore += coreWordScore + descScore;
  }

  // Bonus, wenn der exakte Suchbegriff direkt im Namen vorkommt
  const fullQuery = queryWords.join(' ');
  if (nameRaw === fullQuery) totalScore += 120;
  else if (nameRaw.includes(fullQuery)) totalScore += 45;

  const isCoreMatch = coreHits === queryWords.length;
  if (isCoreMatch) totalScore += 50;

  return { matched: true, score: totalScore, isCoreMatch };
}
