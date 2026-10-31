import { NextRequest, NextResponse } from 'next/server';

type SerperOrganicResult = {
  title?: unknown;
  link?: unknown;
  snippet?: unknown;
  displayedLink?: unknown;
  position?: unknown;
};

export async function POST(request: NextRequest) {
  const apiKey = process.env.ICHAT_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'ICHAT_API_KEY is not configured' },
      { status: 503 },
    );
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
  }
  const query = (payload as Record<string, unknown>).query;
  const requestedCount = (payload as Record<string, unknown>).num ?? 5;
  if (typeof query !== 'string' || !query.trim() || query.length > 500) {
    return NextResponse.json(
      { error: 'query must be a non-empty string of at most 500 characters' },
      { status: 400 },
    );
  }
  if (
    typeof requestedCount !== 'number'
    || !Number.isInteger(requestedCount)
    || requestedCount < 1
    || requestedCount > 10
  ) {
    return NextResponse.json({ error: 'num must be an integer within [1, 10]' }, { status: 400 });
  }
  try {
    const response = await fetch('http://ichat.woa.com/api/serper/search', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query.trim(),
        num: requestedCount,
      }),
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    });
    const body = await response.json();
    if (!response.ok) {
      return NextResponse.json(
        { error: 'iChat search failed', status: response.status },
        { status: 502 },
      );
    }
    const rawResults = Array.isArray(body.organic) ? body.organic : [];
    const results = rawResults.slice(0, requestedCount).flatMap(
      (item: SerperOrganicResult) => {
        if (typeof item.title !== 'string' || typeof item.link !== 'string') {
          return [];
        }
        return [{
          title: item.title,
          url: item.link,
          snippet: typeof item.snippet === 'string' ? item.snippet : '',
          source: typeof item.displayedLink === 'string' ? item.displayedLink : '',
          position: typeof item.position === 'number' ? item.position : null,
        }];
      },
    );
    return NextResponse.json({
      query: query.trim(),
      results,
      credits: typeof body.credits === 'number' ? body.credits : null,
      usage: body.usage && typeof body.usage === 'object' ? body.usage : null,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'iChat search request failed',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
