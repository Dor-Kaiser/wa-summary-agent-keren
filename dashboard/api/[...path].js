const routes = {
  status: { method: 'GET' },
  messages: { method: 'GET' },
  diagnostics: { method: 'GET' },
  events: { method: 'GET' },
  sync: { method: 'POST' },
  summary: { method: 'POST' }
};

export default async function handler(req, res) {
  const requestedPath = req.query.path;
  const endpoint = Array.isArray(requestedPath) ? requestedPath.join('/') : requestedPath;
  const route = routes[endpoint];
  if (!route || req.method !== route.method) {
    return res.status(404).json({ error: 'Not found' });
  }

  const workerUrl = process.env.WORKER_URL;
  const workerToken = process.env.WORKER_API_TOKEN;
  if (!workerUrl || !workerToken) {
    return res.status(503).json({ error: 'Worker connection is not configured' });
  }

  try {
    const upstream = await fetch(`${workerUrl.replace(/\/+$/, '')}/api/${endpoint}`, {
      method: route.method,
      headers: { Authorization: `Bearer ${workerToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(290_000)
    });
    const responseBody = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(responseBody);
  } catch (error) {
    console.error('Worker request failed:', error.message);
    return res.status(502).json({ error: 'Could not reach the WhatsApp worker' });
  }
};
