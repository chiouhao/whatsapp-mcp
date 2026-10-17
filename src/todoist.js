// Minimal Todoist REST client. Uses a personal API token kept on the droplet
// (TODOIST_API_TOKEN), separate from any Todoist connector in Claude.
const BASE = 'https://api.todoist.com/rest/v2';

function token() {
  const t = process.env.TODOIST_API_TOKEN;
  if (!t) throw new Error('TODOIST_API_TOKEN is not set');
  return t;
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      'X-Request-Id': crypto.randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Todoist ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

export async function createTask({ content, description, dueString, projectId, labels }) {
  return call('POST', '/tasks', {
    content,
    description,
    due_string: dueString,
    project_id: projectId,
    labels,
  });
}

