/**
 * Thin client over the Part 2 API. Every response is unwrapped from its
 * `{ data }` envelope here so components never deal with transport shape.
 */

const BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

export type TimelinePoint = { t: string; count: number; cumulative: number };

export type ArticleMark = { t: string; source: string };

export type TimelineSeries = {
  id: string;
  label: string;
  keywords: string[];
  sources: string[];
  start: string;
  end: string;
  displayEnd: string;
  durationHours: number;
  articleCount: number;
  sourceCount: number;
  intensity: number;
  velocity: number;
  peakAt: string;
  lane: number;
  marks: ArticleMark[];
  points: TimelinePoint[];
};

export type Timeline = {
  domain: {
    start: string;
    end: string;
    durationHours: number;
    bucketHours: number;
    bucketCount: number;
  } | null;
  buckets: string[];
  laneCount: number;
  series: TimelineSeries[];
  meta: {
    clusterCount: number;
    totalArticles: number;
    maxArticleCount: number;
    maxBucketCount: number;
    minBarHours: number;
    generatedAt: string;
  };
};

export type Article = {
  id: string;
  title: string;
  url: string;
  source: string;
  author: string | null;
  summary: string | null;
  imageUrl: string | null;
  publishedAt: string;
  publishedEstimated: boolean;
  hasFullText: boolean;
  bodyChars: number;
  similarityToCluster: number;
};

export type ClusterDetail = {
  id: string;
  label: string;
  keywords: string[];
  articleCount: number;
  sourceCount: number;
  timeRange: { start: string; end: string; durationHours: number };
  representativeHeadline: string | null;
  sources: string[];
  articles: Article[];
};

export type Meta = {
  articles: number;
  clusters: number;
  multiArticleClusters: number;
  earliestArticle: string | null;
  latestArticle: string | null;
  lastClusteredAt: string | null;
  sources: { source: string; articleCount: number }[];
};

export type Job = {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  error: string | null;
  stats: Record<string, number> | null;
  logTail: string[];
  isTerminal: boolean;
};

/**
 * The API returns structured errors; surface its message rather than a generic
 * "request failed", so the UI can tell the user what actually went wrong.
 */
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { cache: 'no-store', ...init });
  } catch {
    throw new ApiError(0, 'NETWORK', `Can't reach the API at ${BASE}. Is it running?`);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? `Request failed with ${res.status}`,
    );
  }
  return (body?.data ?? body) as T;
}

export const api = {
  timeline: (params: { minSize?: number; since?: string; bucketHours?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.minSize !== undefined) qs.set('minSize', String(params.minSize));
    if (params.since) qs.set('since', params.since);
    if (params.bucketHours) qs.set('bucketHours', String(params.bucketHours));
    return request<Timeline>(`/timeline?${qs}`);
  },
  cluster: (id: string) => request<ClusterDetail>(`/clusters/${id}`),
  meta: () => request<Meta>('/meta'),
  triggerIngest: () =>
    request<{ jobId: string; status: string; statusUrl: string; pollIntervalMs: number }>(
      '/ingest/trigger',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    ),
  jobStatus: (jobId: string) => request<Job>(`/ingest/status/${jobId}`),
};
