/**
 * tfidf.ts
 *
 * TF-IDF similarity engine for the note system.
 * Builds a TF-IDF index from note metadata and computes cosine similarity
 * to find related notes. Supports CJK (Korean/Chinese/Japanese) tokenization.
 */

// ───────────────────────── Types ─────────────────────────

/**
 * TF-IDF index built from a collection of notes.
 */
export interface TfIdfIndex {
  /** TF-IDF vectors per document path */
  vectors: Record<string, Record<string, number>>;
  /** IDF values per term */
  idf: Record<string, number>;
  /** Document count */
  docCount: number;
}

/**
 * A single similar note result with its similarity score.
 */
export interface SimilarNote {
  path: string;
  score: number; // 0~1
}

// ───────────────────────── CJK Detection ─────────────────────────

/**
 * Regex matching CJK Unified Ideographs, CJK symbols, Hiragana, Katakana,
 * and Korean Hangul syllables.
 */
const CJK_REGEX = /[\u3000-\u9FFF\uAC00-\uD7AF]/;

/**
 * Regex to extract runs of non-CJK word characters.
 */
const WORD_RUN_REGEX = /[a-z0-9_]+/g;

// ───────────────────────── Tokenizer ─────────────────────────

/**
 * Tokenize text for TF-IDF indexing.
 *
 * - Converts to lowercase
 * - Removes punctuation (except within words)
 * - Splits CJK characters individually (each character becomes a token)
 * - Splits non-CJK text on whitespace
 * - Filters tokens shorter than 2 characters (CJK single chars are kept)
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  // Split the text into segments: CJK runs and non-CJK runs
  // We process character-by-character to handle mixed content
  let nonCjkBuffer = '';

  const flushNonCjk = () => {
    if (nonCjkBuffer.length > 0) {
      // Extract word tokens from the non-CJK buffer
      const words = nonCjkBuffer.match(WORD_RUN_REGEX);
      if (words) {
        for (const w of words) {
          if (w.length >= 2) {
            tokens.push(w);
          }
        }
      }
      nonCjkBuffer = '';
    }
  };

  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (CJK_REGEX.test(ch)) {
      flushNonCjk();
      // Each CJK character is its own token
      tokens.push(ch);
    } else {
      nonCjkBuffer += ch;
    }
  }
  flushNonCjk();

  return tokens;
}

// ───────────────────────── TF-IDF Index Builder ─────────────────────────

interface NoteInput {
  path: string;
  title: string;
  excerpt: string;
  tags: string[];
}

/**
 * Build a TF-IDF index from an array of notes.
 *
 * For each note, title text is weighted 2x (included twice) to boost
 * title term importance. Tags are joined and included as regular text.
 *
 * TF is normalized by document length. IDF = log(N / df).
 * The resulting vectors are sparse Records keyed by term.
 */
export function buildTfIdfIndex(notes: NoteInput[]): TfIdfIndex {
  const N = notes.length;
  if (N === 0) {
    return { vectors: {}, idf: {}, docCount: 0 };
  }

  // Step 1: Tokenize all documents and compute term frequencies
  const docTokens: Record<string, string[]> = {};
  const df: Record<string, number> = {}; // document frequency per term

  for (const note of notes) {
    // Combine title (2x weight), excerpt, and tags
    const combined = [
      note.title,
      note.title, // 2x weight for title
      note.excerpt,
      note.tags.join(' '),
    ].join(' ');

    const tokens = tokenize(combined);
    docTokens[note.path] = tokens;

    // Count unique terms in this document for DF
    const seen = new Set<string>();
    for (const token of tokens) {
      if (!seen.has(token)) {
        seen.add(token);
        df[token] = (df[token] || 0) + 1;
      }
    }
  }

  // Step 2: Compute IDF for each term
  const idf: Record<string, number> = {};
  for (const term in df) {
    idf[term] = Math.log(N / df[term]);
  }

  // Step 3: Compute TF-IDF vectors
  const vectors: Record<string, Record<string, number>> = {};

  for (const note of notes) {
    const tokens = docTokens[note.path];
    const docLen = tokens.length;
    if (docLen === 0) {
      vectors[note.path] = {};
      continue;
    }

    // Compute raw term frequency
    const tf: Record<string, number> = {};
    for (const token of tokens) {
      tf[token] = (tf[token] || 0) + 1;
    }

    // Normalize TF by document length and multiply by IDF
    const vec: Record<string, number> = {};
    for (const term in tf) {
      const normalizedTf = tf[term] / docLen;
      const tfidf = normalizedTf * (idf[term] || 0);
      if (tfidf > 0) {
        vec[term] = tfidf;
      }
    }

    vectors[note.path] = vec;
  }

  return { vectors, idf, docCount: N };
}

// ───────────────────────── Cosine Similarity ─────────────────────────

/**
 * Compute cosine similarity between two sparse vectors.
 * Returns a value between 0 and 1 (vectors are non-negative due to TF-IDF).
 */
export function cosineSimilarity(
  a: Record<string, number>,
  b: Record<string, number>,
): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  // Iterate over the smaller vector for efficiency
  const [smaller, larger] = Object.keys(a).length <= Object.keys(b).length
    ? [a, b]
    : [b, a];

  for (const term in smaller) {
    if (term in larger) {
      dotProduct += smaller[term] * larger[term];
    }
  }

  // Compute norms
  for (const term in a) {
    normA += a[term] * a[term];
  }
  for (const term in b) {
    normB += b[term] * b[term];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dotProduct / denom;
}

// ───────────────────────── Find Similar Notes ─────────────────────────

/**
 * Find the top N most similar notes to the note at the given path.
 *
 * Compares the given note's TF-IDF vector against all other notes using
 * cosine similarity. Returns results sorted by descending score,
 * excluding the note itself and any scores below 0.01.
 *
 * @param index - The TF-IDF index built from all notes
 * @param path - The path of the note to find similar notes for
 * @param topN - Maximum number of results to return (default 8)
 */
export function findSimilarNotes(
  index: TfIdfIndex,
  path: string,
  topN: number = 8,
): SimilarNote[] {
  const sourceVec = index.vectors[path];
  if (!sourceVec || Object.keys(sourceVec).length === 0) {
    return [];
  }

  const results: SimilarNote[] = [];

  for (const otherPath in index.vectors) {
    if (otherPath === path) continue;

    const score = cosineSimilarity(sourceVec, index.vectors[otherPath]);
    if (score >= 0.01) {
      results.push({ path: otherPath, score });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, topN);
}
