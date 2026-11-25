#!/usr/bin/env node

import process from 'node:process';

const origin = process.argv[2];
if (!origin) throw new Error('A deployment origin is required');

const headers = {
  'user-agent': 'cycling-page-map-proxy-check/1',
  ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
    ? {
        'x-vercel-protection-bypass':
          process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
      }
    : {}),
};

const OPENFREEMAP_HOSTNAME = 'tiles.openfreemap.org';

const isOpenFreeMapUrl = (value) => {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' && parsed.hostname === OPENFREEMAP_HOSTNAME
    );
  } catch {
    return false;
  }
};

const fetchThroughProxy = async (resourceUrl) => {
  const target = new URL('/api/map-proxy', origin);
  target.searchParams.set('url', resourceUrl);
  const response = await fetch(target, { headers });
  const contentType = response.headers.get('content-type') ?? '';
  return { response, contentType };
};

const fetchJsonThroughProxy = async (resourceUrl, label) => {
  const { response, contentType } = await fetchThroughProxy(resourceUrl);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `map proxy returned HTTP ${response.status} (${contentType}) for ${resourceUrl}: ${body.slice(0, 180)}`
    );
  }
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(
      `map proxy returned ${contentType || 'no content type'} instead of JSON for ${label}`
    );
  }
  return { json: JSON.parse(body), response, contentType, body };
};

const styleUrls = [
  'https://tiles.openfreemap.org/styles/bright',
  'https://tiles.openfreemap.org/styles/dark',
];

let primaryStyle;
for (const styleUrl of styleUrls) {
  const { json, response, contentType, body } = await fetchJsonThroughProxy(
    styleUrl,
    styleUrl
  );
  const sourceUrls = Object.values(json?.sources ?? {}).flatMap((source) => [
    ...(typeof source?.url === 'string' ? [source.url] : []),
    ...(Array.isArray(source?.tiles)
      ? source.tiles.filter((tile) => typeof tile === 'string')
      : []),
  ]);
  if (json?.version !== 8 || !sourceUrls.some(isOpenFreeMapUrl)) {
    throw new Error(
      `map proxy returned an unexpected OpenFreeMap style document for ${styleUrl}`
    );
  }
  if (!primaryStyle) primaryStyle = json;
  process.stdout.write(
    `map proxy passed: style ${styleUrl} HTTP ${response.status}, ${contentType}, ${body.length} bytes\n`
  );
}

const vectorSourceUrl = Object.values(primaryStyle?.sources ?? {})
  .map((source) => source?.url)
  .find((url) => isOpenFreeMapUrl(url));

if (!vectorSourceUrl) {
  throw new Error('OpenFreeMap style is missing a proxied vector source URL');
}

const { json: tileJson } = await fetchJsonThroughProxy(
  vectorSourceUrl,
  'vector TileJSON'
);
const vectorTileTemplate = Array.isArray(tileJson?.tiles)
  ? tileJson.tiles.find((url) => isOpenFreeMapUrl(url) && url.includes('{z}'))
  : undefined;

if (!vectorTileTemplate) {
  throw new Error('OpenFreeMap TileJSON is missing a proxied tile template');
}

const vectorTileUrl = vectorTileTemplate
  .replace('{z}', '10')
  .replace('{x}', '857')
  .replace('{y}', '418');
const { response: vectorResponse, contentType: vectorContentType } =
  await fetchThroughProxy(vectorTileUrl);
const vectorBody = Buffer.from(await vectorResponse.arrayBuffer());
if (!vectorResponse.ok) {
  throw new Error(
    `map proxy returned HTTP ${vectorResponse.status} for the basemap vector tile ${vectorTileUrl}`
  );
}
if (vectorBody.length === 0) {
  throw new Error('map proxy returned an empty basemap vector tile');
}
process.stdout.write(
  `map proxy passed: vector tile HTTP ${vectorResponse.status}, ${vectorContentType}, ${vectorBody.length} bytes\n`
);
