const unauthorized = () => new Response('Authentication required', {
  status: 401,
  headers: { 'WWW-Authenticate': 'Basic realm="WhatsApp Summary Dashboard", charset="UTF-8"' }
});

export const config = {
  matcher: ['/((?!_vercel).*)']
};

export default function middleware(request) {
  const username = process.env.DASHBOARD_USERNAME;
  const password = process.env.DASHBOARD_PASSWORD;
  if (!username || !password) {
    return new Response('Dashboard authentication is not configured', { status: 503 });
  }

  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Basic ')) return unauthorized();

  const url = new URL(request.url);
  if (request.method === 'POST' && ['/api/sync', '/api/summary'].includes(url.pathname) &&
      request.headers.get('origin') !== url.origin) {
    return new Response('Invalid request origin', { status: 403 });
  }

  try {
    const decoded = atob(authorization.slice(6));
    const separator = decoded.indexOf(':');
    if (separator < 0 || decoded.slice(0, separator) !== username || decoded.slice(separator + 1) !== password) {
      return unauthorized();
    }
  } catch {
    return unauthorized();
  }

  return;
}
