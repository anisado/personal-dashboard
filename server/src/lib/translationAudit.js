const ARABIC_LETTERS = /[\u0621-\u064A\u066E-\u06D3]/;
const ARABIC_DIACRITICS = /[\u064B-\u0652\u0670\u0640]/g;
const LATIN_LETTERS = /[A-Za-z]/;

const SEVERITY_WEIGHT = { high: 12, medium: 5, low: 2 };

export function normalizeDigits(text) {
  return text.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (digit) => {
    const code = digit.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

function numbersIn(text) {
  const matches = normalizeDigits(text).match(/\d+(?:[.,]\d+)*/g) || [];
  return matches.map((value) => value.replace(/[.,](?=\d{3}\b)/g, '')).sort();
}

function anchorsIn(text) {
  return [...numbersIn(text), ...placeholdersIn(text)];
}

function placeholdersIn(text) {
  const patterns = [/\{[^{}\s]+\}/g, /%[sd]/g, /<[^<>\s]+>/g, /https?:\/\/\S+/g, /\S+@\S+\.\S+/g];
  return patterns.flatMap((pattern) => text.match(pattern) || []).sort();
}

function stripDiacritics(text) {
  return normalizeDigits(text).replace(ARABIC_DIACRITICS, '').replace(/[\u0622\u0623\u0625]/g, '\u0627');
}

function tokenLength(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function multisetDiff(a, b) {
  const counts = new Map();
  for (const value of a) counts.set(value, (counts.get(value) || 0) + 1);
  for (const value of b) counts.set(value, (counts.get(value) || 0) - 1);
  const missing = [];
  const added = [];
  for (const [value, count] of counts) {
    for (let i = 0; i < count; i += 1) missing.push(value);
    for (let i = 0; i < -count; i += 1) added.push(value);
  }
  return { missing, added };
}

/**
 * Gale–Church style DP alignment: pairs source and target paragraphs allowing
 * 1-1, 1-0, 0-1, 2-1 and 1-2 groupings, scored on token-length proportionality
 * plus a bonus for shared numbers.
 */
export function alignSegments(sourceParagraphs, targetParagraphs, expectedRatio = 0.9) {
  const rows = sourceParagraphs.length;
  const cols = targetParagraphs.length;
  const cost = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(Infinity));
  const back = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(null));
  cost[0][0] = 0;

  const joinCost = (sourceSlice, targetSlice) => {
    const sourceLength = sourceSlice.reduce((sum, text) => sum + tokenLength(text), 0);
    const targetLength = targetSlice.reduce((sum, text) => sum + tokenLength(text), 0);
    if (sourceLength === 0 && targetLength === 0) return 0;
    if (sourceLength === 0 || targetLength === 0) return 8;
    const expected = sourceLength * expectedRatio;
    const deviation = Math.abs(Math.log(targetLength / Math.max(expected, 0.5)));
    const sourceAnchors = anchorsIn(sourceSlice.join(' '));
    const targetAnchors = anchorsIn(targetSlice.join(' '));
    const shared = sourceAnchors.filter((anchor) => targetAnchors.includes(anchor));
    let anchorScore = 0;
    if (shared.length > 0) anchorScore = -1.5 * Math.min(shared.length, 2);
    else if (sourceAnchors.length > 0 && targetAnchors.length > 0) anchorScore = 2;
    return deviation + anchorScore;
  };

  const moves = [
    [1, 1, 0],
    [1, 0, 4],
    [0, 1, 4],
    [2, 1, 1.2],
    [1, 2, 1.2]
  ];

  for (let i = 0; i <= rows; i += 1) {
    for (let j = 0; j <= cols; j += 1) {
      if (cost[i][j] === Infinity) continue;
      for (const [di, dj, penalty] of moves) {
        if (i + di > rows || j + dj > cols) continue;
        const sourceSlice = sourceParagraphs.slice(i, i + di);
        const targetSlice = targetParagraphs.slice(j, j + dj);
        const candidate = cost[i][j] + penalty + joinCost(sourceSlice, targetSlice);
        if (candidate < cost[i + di][j + dj]) {
          cost[i + di][j + dj] = candidate;
          back[i + di][j + dj] = [i, j];
        }
      }
    }
  }

  const pairs = [];
  let i = rows;
  let j = cols;
  while (i > 0 || j > 0) {
    const previous = back[i][j];
    if (!previous) break;
    const [pi, pj] = previous;
    pairs.push({
      source: sourceParagraphs.slice(pi, i).join(' '),
      target: targetParagraphs.slice(pj, j).join(' ')
    });
    i = pi;
    j = pj;
  }
  return pairs.reverse().map((pair, index) => ({ index: index + 1, ...pair }));
}

function checkSegment(segment, context) {
  const issues = [];
  const { source, target } = segment;
  const add = (type, severity, message, detail) => issues.push({ type, severity, message, detail });

  if (source && !target) {
    add('missing_translation', 'high', 'Arabic paragraph has no English counterpart');
    return issues;
  }
  if (!source && target) {
    add('added_content', 'high', 'English paragraph has no Arabic source (added content)');
    return issues;
  }

  if (stripDiacritics(source) === stripDiacritics(target)) {
    add('untranslated_text', 'high', 'English segment is identical to the Arabic source');
  } else if (ARABIC_LETTERS.test(target)) {
    const leftovers = target.match(/[\u0600-\u06FF\u0750-\u077F]+/g) || [];
    add('untranslated_text', 'high', 'Arabic script left inside the English translation', leftovers.join(' '));
  } else if (!LATIN_LETTERS.test(target)) {
    add('untranslated_text', 'medium', 'English segment contains no Latin letters');
  }

  const numbers = multisetDiff(numbersIn(source), numbersIn(target));
  if (numbers.missing.length || numbers.added.length) {
    add(
      'number_mismatch',
      'high',
      'Numbers differ between source and translation',
      [
        numbers.missing.length ? `missing in English: ${numbers.missing.join(', ')}` : '',
        numbers.added.length ? `not in Arabic: ${numbers.added.join(', ')}` : ''
      ]
        .filter(Boolean)
        .join(' · ')
    );
  }

  const placeholders = multisetDiff(placeholdersIn(source), placeholdersIn(target));
  if (placeholders.missing.length || placeholders.added.length) {
    add(
      'placeholder_mismatch',
      'medium',
      'URLs, emails or placeholders do not match',
      [...placeholders.missing, ...placeholders.added].join(', ')
    );
  }

  const sourceTokens = tokenLength(source);
  const targetTokens = tokenLength(target);
  if (sourceTokens >= 4 && targetTokens >= 1) {
    const ratio = targetTokens / (sourceTokens * context.expectedRatio);
    if (ratio < 0.55) {
      add('possible_omission', 'medium', 'Translation is much shorter than expected', `${targetTokens} vs ~${Math.round(sourceTokens * context.expectedRatio)} words`);
    } else if (ratio > 1.9) {
      add('possible_addition', 'low', 'Translation is much longer than expected', `${targetTokens} vs ~${Math.round(sourceTokens * context.expectedRatio)} words`);
    }
  }

  if (/[.!?،؛:]$/.test(source) && !/[.!?:;]$/.test(target)) {
    add('punctuation', 'low', 'Sentence-final punctuation missing in the translation');
  }

  for (const [open, close] of [['(', ')'], ['[', ']'], ['"', '"']]) {
    const count = (text, char) => text.split(char).length - 1;
    const sourcePairs = open === close ? Math.floor(count(source, open) / 2) : Math.min(count(source, open), count(source, close));
    const targetPairs = open === close ? Math.floor(count(target, open) / 2) : Math.min(count(target, open), count(target, close));
    if (sourcePairs !== targetPairs) {
      add('punctuation', 'low', `Unbalanced ${open}${close} between source and translation`);
      break;
    }
  }

  return issues;
}

function consistencyIssues(segments) {
  const bySource = new Map();
  const byTarget = new Map();
  const issues = [];

  for (const segment of segments) {
    if (!segment.source || !segment.target) continue;
    const sourceKey = stripDiacritics(segment.source).toLowerCase();
    const targetKey = segment.target.toLowerCase();
    if (!bySource.has(sourceKey)) bySource.set(sourceKey, new Map());
    bySource.get(sourceKey).set(targetKey, segment.index);
    if (!byTarget.has(targetKey)) byTarget.set(targetKey, new Map());
    byTarget.get(targetKey).set(sourceKey, segment.index);
  }

  for (const [, translations] of bySource) {
    if (translations.size > 1) {
      const indexes = [...translations.values()].sort((a, b) => a - b);
      issues.push({
        segmentIndex: indexes[0],
        type: 'inconsistent_terminology',
        severity: 'medium',
        message: 'Identical Arabic text translated differently',
        detail: `segments ${indexes.join(', ')}`
      });
    }
  }

  for (const [, sources] of byTarget) {
    if (sources.size > 1) {
      const indexes = [...sources.values()].sort((a, b) => a - b);
      issues.push({
        segmentIndex: indexes[0],
        type: 'duplicate_translation',
        severity: 'medium',
        message: 'Different Arabic paragraphs share the same English text',
        detail: `segments ${indexes.join(', ')}`
      });
    }
  }

  return issues;
}

export function auditTranslation(sourceParagraphs, targetParagraphs) {
  const sourceWords = sourceParagraphs.reduce((sum, text) => sum + tokenLength(text), 0);
  const targetWords = targetParagraphs.reduce((sum, text) => sum + tokenLength(text), 0);
  const expectedRatio = sourceWords > 0 ? Math.min(Math.max(targetWords / sourceWords, 0.6), 1.6) : 1;

  const parallel = sourceParagraphs.length === targetParagraphs.length;
  const segments = parallel
    ? sourceParagraphs.map((source, index) => ({ index: index + 1, source, target: targetParagraphs[index] }))
    : alignSegments(sourceParagraphs, targetParagraphs, expectedRatio);
  const context = { expectedRatio };

  const issues = [];
  for (const segment of segments) {
    for (const issue of checkSegment(segment, context)) {
      issues.push({ segmentIndex: segment.index, ...issue });
    }
  }
  issues.push(...consistencyIssues(segments));
  issues.sort((a, b) => a.segmentIndex - b.segmentIndex);

  const penalty = issues.reduce((sum, issue) => sum + SEVERITY_WEIGHT[issue.severity], 0);
  const score = Math.max(0, Math.round(100 - (100 * penalty) / Math.max(segments.length * 12, 12)));

  const bySeverity = { high: 0, medium: 0, low: 0 };
  const byType = {};
  for (const issue of issues) {
    bySeverity[issue.severity] += 1;
    byType[issue.type] = (byType[issue.type] || 0) + 1;
  }

  return {
    summary: {
      score,
      verdict: score >= 85 ? 'looks solid' : score >= 60 ? 'needs review' : 'significant problems',
      segments: segments.length,
      sourceParagraphs: sourceParagraphs.length,
      targetParagraphs: targetParagraphs.length,
      sourceWords,
      targetWords,
      expansionRatio: Number(expectedRatio.toFixed(2)),
      alignment: parallel ? 'paragraph-parallel' : 'heuristic',
      issues: issues.length,
      bySeverity,
      byType
    },
    segments: segments.map((segment) => ({
      ...segment,
      issues: issues.filter((issue) => issue.segmentIndex === segment.index)
    })),
    issues
  };
}
