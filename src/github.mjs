// Minimal GitHub REST client: only what the release workflows need.
// `fetchImpl` is swappable so tests never touch the network.

export function createGitHub({ token, repository, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  async function request(method, path, body) {
    const res = await fetchImpl(`${apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${path} failed: ${res.status} ${await res.text()}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  async function paginate(path) {
    const all = [];
    for (let page = 1; ; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const items = await request('GET', `${path}${sep}per_page=100&page=${page}`);
      all.push(...items);
      if (items.length < 100) return all;
    }
  }

  return {
    request,
    paginate,

    /** PRs merged into `base`, as { number, head }. */
    async mergedPullsInto(base) {
      const pulls = await paginate(`/repos/${repository}/pulls?state=closed&base=${encodeURIComponent(base)}`);
      return pulls.filter((p) => p.merged_at).map((p) => ({ number: p.number, head: p.head.ref }));
    },
  };
}
