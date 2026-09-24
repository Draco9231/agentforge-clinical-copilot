import type { Env } from './types';

// Hybrid retrieval over the guideline corpus (W2 PRD Stage 2): sparse (D1 FTS5 / BM25) plus
// dense (bge-base-en-v1.5 embeddings, cosine) candidates, fused by reciprocal rank fusion, then
// reranked by a cross-encoder (bge-reranker-base on Workers AI). Only the top reranked chunks
// reach the answer model. Each stage is a small pure function where it can be, so the eval gate
// can pin the behaviour without a network.

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const RERANK_MODEL = '@cf/baai/bge-reranker-base';

// Measured live (2026-09-24, 4 queries against the 14-chunk corpus): the reranker returns
// sigmoid-scaled relevance in [0,1]. On-topic top hits scored 0.30-0.98, weak secondary matches
// ~0.04-0.06, and an off-topic query ("capital of France") scored ~0.00004 on every chunk. A
// floor of 0.1 separates relevant from noise, so an unrelated question yields *no* guideline
// evidence instead of the three least-bad chunks dressed up as support.
export const MIN_RERANK_SCORE = 0.1;

export function filterByScore<T extends { rerankScore: number }>(items: T[], min = MIN_RERANK_SCORE): T[] {
	return items.filter((i) => i.rerankScore >= min);
}

export interface EvidenceItem {
	chunkId: string;
	source: string;
	section: string;
	text: string;
	rerankScore: number;
	sparseRank: number | null;
	denseRank: number | null;
}

export interface RetrievalResult {
	evidence: EvidenceItem[];
	note: string;
	stats: { sparseHits: number; denseHits: number; candidates: number; reranked: boolean; topScore: number | null };
}

const STOPWORDS = new Set(
	'a an and are as at be but by can do does for from has have he her his how i in is it its me my of on or our she should so that the their them then there these they this to was we were what when which who why will with would you your'.split(' '),
);

// FTS5 treats punctuation and bare words as syntax; a raw question string will throw or match
// nothing. Reduce it to alphanumeric tokens joined with OR (BM25 still ranks multi-term hits
// higher), dropping stopwords that would only add noise.
export function buildFtsQuery(text: string): string {
	const tokens = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
	return [...new Set(tokens)].slice(0, 24).join(' OR ');
}

export function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Reciprocal rank fusion: each list contributes 1/(k+rank); robust to the two retrievers
// producing scores on incomparable scales (BM25 vs cosine), which is exactly why it is used here
// instead of a weighted score sum.
export function reciprocalRankFusion(lists: string[][], k = 60): { id: string; score: number }[] {
	const scores = new Map<string, number>();
	for (const list of lists) list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
	return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((x, y) => y.score - x.score);
}

interface ChunkRow {
	id: string;
	source: string;
	section: string;
	text: string;
	embedding: string | null;
}

async function embed(env: Env, texts: string[]): Promise<number[][]> {
	const out = (await env.AI.run(EMBED_MODEL, { text: texts, pooling: 'cls' })) as { data?: number[][] };
	if (!out.data || out.data.length !== texts.length) throw new Error('embedding model returned an unexpected shape');
	return out.data;
}

// Embeddings are computed lazily on first use and cached in D1 (the corpus is seeded with NULL
// embeddings), so reseeding never requires a separate embedding job. 'cls' pooling is used for
// both chunks and queries — embeddings from different pooling methods are not comparable.
async function ensureEmbeddings(env: Env, rows: ChunkRow[]): Promise<Map<string, number[]>> {
	const vectors = new Map<string, number[]>();
	const missing = rows.filter((r) => !r.embedding);
	for (const r of rows) if (r.embedding) vectors.set(r.id, JSON.parse(r.embedding));
	if (missing.length) {
		const fresh = await embed(env, missing.map((r) => `${r.section}. ${r.text}`));
		await env.DB.batch(missing.map((r, i) => env.DB.prepare('UPDATE guideline_chunks SET embedding = ? WHERE id = ?').bind(JSON.stringify(fresh[i]), r.id)));
		missing.forEach((r, i) => vectors.set(r.id, fresh[i]));
	}
	return vectors;
}

export async function retrieveGuidelineEvidence(env: Env, query: string, opts: { topK?: number; candidates?: number } = {}): Promise<RetrievalResult> {
	const topK = opts.topK ?? 3;
	const candidateLimit = opts.candidates ?? 8;

	const all = (await env.DB.prepare('SELECT id, source, section, text, embedding FROM guideline_chunks').all<ChunkRow>()).results ?? [];
	if (all.length === 0) {
		return { evidence: [], note: 'guideline corpus is empty', stats: { sparseHits: 0, denseHits: 0, candidates: 0, reranked: false, topScore: null } };
	}
	const byId = new Map(all.map((r) => [r.id, r]));

	// Sparse.
	const ftsQuery = buildFtsQuery(query);
	let sparse: string[] = [];
	if (ftsQuery) {
		const rows = await env.DB.prepare('SELECT id FROM guideline_fts WHERE guideline_fts MATCH ? ORDER BY bm25(guideline_fts) LIMIT ?')
			.bind(ftsQuery, candidateLimit)
			.all<{ id: string }>();
		sparse = (rows.results ?? []).map((r) => r.id);
	}

	// Dense.
	const vectors = await ensureEmbeddings(env, all);
	const [queryVec] = await embed(env, [query]);
	const dense = all
		.map((r) => ({ id: r.id, sim: cosine(queryVec, vectors.get(r.id) ?? []) }))
		.sort((a, b) => b.sim - a.sim)
		.slice(0, candidateLimit)
		.map((r) => r.id);

	// Fuse, then rerank the fused candidates with the cross-encoder.
	const fused = reciprocalRankFusion([sparse, dense]).slice(0, candidateLimit);
	const candidates = fused.map((f) => byId.get(f.id)!).filter(Boolean);

	const rerank = (await env.AI.run(RERANK_MODEL, {
		query,
		contexts: candidates.map((c) => ({ text: `${c.section}. ${c.text}` })),
		top_k: topK,
	} as any)) as { response?: { id?: number; score?: number }[] };

	const ranked = (rerank.response ?? [])
		.filter((r) => typeof r.id === 'number' && typeof r.score === 'number')
		.sort((a, b) => (b.score as number) - (a.score as number))
		.slice(0, topK);

	const scored: EvidenceItem[] = ranked.map((r) => {
		const c = candidates[r.id as number];
		return {
			chunkId: c.id,
			source: c.source,
			section: c.section,
			text: c.text,
			rerankScore: r.score as number,
			sparseRank: sparse.includes(c.id) ? sparse.indexOf(c.id) + 1 : null,
			denseRank: dense.includes(c.id) ? dense.indexOf(c.id) + 1 : null,
		};
	});
	const evidence = filterByScore(scored);

	return {
		evidence,
		note: evidence.length ? 'ok' : scored.length ? 'no chunk cleared the relevance floor' : 'reranker returned no results',
		stats: { sparseHits: sparse.length, denseHits: dense.length, candidates: candidates.length, reranked: true, topScore: evidence[0]?.rerankScore ?? null },
	};
}
