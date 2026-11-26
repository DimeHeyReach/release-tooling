// In-memory stand-in for the GitHub API pieces the release automations use.
export function createFakeGitHub({ repository = 'HeyReach/demo' } = {}) {
  const state = {
    pulls: [], labels: {}, comments: {}, deletedRefs: [], autoMerge: [], nextNumber: 100, autoMergeError: null,
    statuses: [], refs: new Set(), createdRefs: [], compare: {},
  };
  const notFound = () => Object.assign(new Error('404 Not Found'), { status: 404 });

  async function request(method, path, body) {
    let m;
    const base = `/repos/${repository}`;
    if (method === 'GET' && (m = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\?state=open&head=([^&]+)&base=([^&]+)$/))) {
      const head = decodeURIComponent(m[1]).split(':')[1];
      const baseRef = decodeURIComponent(m[2]);
      return state.pulls.filter((p) => p.state === 'open' && p.head === head && p.base === baseRef)
        .map((p) => ({ number: p.number, node_id: `PR_${p.number}` }));
    }
    if (method === 'GET' && (m = path.match(/\/pulls\?state=open&base=([^&]+)$/))) {
      const baseRef = decodeURIComponent(m[1]);
      return state.pulls.filter((p) => p.state === 'open' && p.base === baseRef).map((p) => ({ number: p.number, head: { ref: p.head } }));
    }
    if (method === 'POST' && path === `${base}/pulls`) {
      const pr = { number: state.nextNumber++, state: 'open', ...body };
      state.pulls.push(pr);
      return { number: pr.number, node_id: `PR_${pr.number}` };
    }
    if (method === 'POST' && (m = path.match(/\/statuses\/([0-9a-f]+)$/))) {
      state.statuses.push({ sha: m[1], ...body });
      return {};
    }
    if (method === 'GET' && (m = path.match(/\/git\/ref\/(.+)$/))) {
      if (!state.refs.has(m[1])) throw notFound();
      return { ref: `refs/${m[1]}` };
    }
    if (method === 'POST' && path === `${base}/git/refs`) {
      state.refs.add(body.ref.replace(/^refs\//, ''));
      state.createdRefs.push(body);
      return {};
    }
    if (method === 'GET' && (m = path.match(/\/compare\/([0-9a-f]+)\.\.\.(.+)$/))) {
      return { status: state.compare[`${m[1]}...${decodeURIComponent(m[2])}`] ?? 'diverged' };
    }
    if (method === 'GET' && (m = path.match(/\/issues\?labels=([^&]+)&state=(all|open)$/))) {
      const label = decodeURIComponent(m[1]);
      const isOpen = (n) => (state.pulls.find((p) => p.number === Number(n))?.state ?? 'open') === 'open';
      return Object.entries(state.labels)
        .filter(([n, ls]) => ls.includes(label) && (m[2] === 'all' || isOpen(n)))
        .map(([n]) => ({ number: Number(n) }));
    }
    if ((m = path.match(/\/pulls\/(\d+)$/))) {
      const pr = state.pulls.find((p) => p.number === Number(m[1]));
      if (!pr) throw notFound();
      if (method === 'PATCH') { Object.assign(pr, body); return {}; }
      return {
        number: pr.number, body: pr.body ?? '', head: { ref: pr.head, sha: pr.headSha },
        labels: (state.labels[pr.number] ?? []).map((name) => ({ name })),
      };
    }
    if (method === 'POST' && path === '/graphql') {
      if (state.autoMergeError) return { errors: [{ message: state.autoMergeError }] };
      state.autoMerge.push(body.variables.id);
      return { data: {} };
    }
    if ((m = path.match(/\/issues\/(\d+)\/labels(?:\/(.+))?$/))) {
      const n = m[1];
      state.labels[n] ??= [];
      if (method === 'GET') return state.labels[n].map((name) => ({ name }));
      if (method === 'POST') { state.labels[n].push(...body.labels); return []; }
      if (method === 'DELETE') { state.labels[n] = state.labels[n].filter((l) => l !== decodeURIComponent(m[2])); return null; }
    }
    if (method === 'POST' && (m = path.match(/\/issues\/(\d+)\/comments$/))) {
      (state.comments[m[1]] ??= []).push(body.body);
      return {};
    }
    if (method === 'DELETE' && (m = path.match(/\/git\/refs\/heads\/(.+)$/))) {
      if (state.deletedRefs.includes(m[1])) throw new Error('422 Reference does not exist');
      state.deletedRefs.push(m[1]);
      return null;
    }
    throw new Error(`Fake GitHub has no route for ${method} ${path}`);
  }

  return { request, state, repository };
}
