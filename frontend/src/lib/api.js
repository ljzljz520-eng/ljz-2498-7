export async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.groupId ? { 'x-group-id': options.groupId } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw body;
  return body;
}
