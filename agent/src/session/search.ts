/**
 * Search over the chat's documents (text files, parsed PDFs, video transcripts) without
 * putting them in the conversation: each is cut into passages, and a question gets the
 * passages that share the most words with it, ranked by BM25. No embeddings, no index
 * kept between calls: a chat's documents are small enough to rank on every call.
 */

export type SearchDocument = { name: string; text: string };

/** Characters per passage, and how much of the one before each passage repeats. */
const PASSAGE_CHARS = 1200;
const OVERLAP_CHARS = 200;

/** BM25's usual constants: term-frequency saturation and length normalisation. */
const K1 = 1.2;
const B = 0.75;

/** Words too common to tell passages apart. */
const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have he her his i if in into is it its me my " +
    "not of on or our she so that the their them then there these they this to was we were " +
    "what when where which who why will with you your do does did can could would should " +
    "about how all any been more most other some than too very just also"
  ).split(" ")
);

/** Lowercased words and numbers in any script (vowel signs included), without stopwords. */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter(
    (w) => !STOPWORDS.has(w) && (w.length > 1 || /\p{N}/u.test(w))
  );
}

/**
 * A document cut into passages that end on whitespace, each repeating the tail of the
 * one before, so a sentence split at a boundary is still whole in one of them.
 */
export function passages(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + PASSAGE_CHARS, clean.length);
    if (end < clean.length) {
      const space = clean.lastIndexOf(" ", end);
      if (space > start + PASSAGE_CHARS / 2) end = space;
    }
    out.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    const next = clean.indexOf(" ", end - OVERLAP_CHARS);
    start = next > start && next < end ? next + 1 : end;
  }
  return out;
}

export type Passage = { name: string; part: number; parts: number; text: string };

/** Every passage of every document, numbered from 1 within its document. */
function allPassages(documents: SearchDocument[]): Passage[] {
  return documents.flatMap((d) => {
    const cut = passages(d.text);
    return cut.map((text, i) => ({ name: d.name, part: i + 1, parts: cut.length, text }));
  });
}

/** A near spelling counts for less than the word itself. */
const NEAR_WEIGHT = 0.6;

/**
 * How many letters a word may differ by and still match: none for short words, where a
 * letter changes the word, more for long ones, which captions misspell ("Reman" for
 * "Riemann").
 */
function slack(word: string): number {
  return word.length < 5 ? 0 : word.length < 7 ? 1 : 2;
}

/** Edit distance between `a` and `b`, or `max + 1` as soon as it must exceed `max`. */
export function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
      best = Math.min(best, row[j]);
    }
    if (best > max) return max + 1;
    previous = row;
  }
  return previous[b.length];
}

/** The passages' words each query word stands for: itself, and its near spellings. */
function expand(terms: string[], vocabulary: Set<string>): Map<string, number> {
  const weights = new Map<string, number>();
  for (const t of terms) {
    if (vocabulary.has(t)) weights.set(t, 1);
    const max = slack(t);
    if (max === 0) continue;
    for (const w of vocabulary) {
      if (w === t || weights.get(w) === 1) continue;
      if (Math.min(w.length, t.length) < 5) continue;
      if (distance(t, w, max) <= max) weights.set(w, Math.max(weights.get(w) ?? 0, NEAR_WEIGHT));
    }
  }
  return weights;
}

/** The `count` passages that best match `query`, best first; none when no word matches. */
export function search(documents: SearchDocument[], query: string, count: number): Passage[] {
  return keywordRanked(allPassages(documents), query).slice(0, count);
}

/** Passages holding the query's words or their near spellings, best first, by BM25. */
function keywordRanked(all: Passage[], query: string): Passage[] {
  const terms = [...new Set(words(query))];
  if (terms.length === 0) return [];
  const bags = all.map((p) => {
    const bag = new Map<string, number>();
    for (const w of words(p.text)) bag.set(w, (bag.get(w) ?? 0) + 1);
    return { length: [...bag.values()].reduce((a, b) => a + b, 0), bag };
  });
  const vocabulary = new Set(bags.flatMap((b) => [...b.bag.keys()]));
  const weights = expand(terms, vocabulary);
  if (weights.size === 0) return [];
  const average = bags.reduce((a, b) => a + b.length, 0) / Math.max(bags.length, 1);
  const idf = new Map(
    [...weights.keys()].map((t) => {
      const holding = bags.filter((b) => b.bag.has(t)).length;
      return [t, Math.log(1 + (all.length - holding + 0.5) / (holding + 0.5))];
    })
  );
  return all
    .map((p, i) => {
      const { bag, length } = bags[i];
      let score = 0;
      for (const [t, weight] of weights) {
        const tf = bag.get(t) ?? 0;
        if (!tf) continue;
        score +=
          (weight * idf.get(t)! * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / average));
      }
      return { p, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.p);
}

/** Reciprocal rank fusion's constant: how much a top rank outweighs a middling one. */
const RRF_K = 60;

/**
 * Keyword ranking and meaning ranking merged by reciprocal rank fusion: words find
 * names, numbers and codes; meaning finds paraphrases and a question asked in another
 * language than the document. `similarity` scores every passage against the query, or
 * gives null when it cannot, and then the keyword ranking stands alone.
 */
export async function searchHybrid(
  documents: SearchDocument[],
  query: string,
  count: number,
  similarity: (query: string, texts: string[]) => Promise<number[] | null>
): Promise<Passage[]> {
  const all = allPassages(documents);
  const keyword = keywordRanked(all, query);
  if (!query.trim() || all.length === 0) return [];
  const scores = await similarity(
    query,
    all.map((p) => p.text)
  );
  if (!scores) return keyword.slice(0, count);
  const meaning = all
    .map((p, i) => ({ p, score: scores[i] }))
    .sort((a, b) => b.score - a.score)
    .map((s) => s.p);
  const fused = new Map<Passage, number>();
  for (const ranking of [keyword, meaning]) {
    ranking.forEach((p, rank) => fused.set(p, (fused.get(p) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  return [...fused]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([p]) => p);
}

/** How many parts each document has, for telling the model what it can read. */
export function partCounts(documents: SearchDocument[]): { name: string; parts: number }[] {
  return documents.map((d) => ({ name: d.name, parts: passages(d.text).length }));
}

/** One passage of one document by its number, for reading a document start to end. */
export function passageOf(document: SearchDocument, part: number): Passage | null {
  const cut = passages(document.text);
  if (part < 1 || part > cut.length) return null;
  return { name: document.name, part, parts: cut.length, text: cut[part - 1] };
}
