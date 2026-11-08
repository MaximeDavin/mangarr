// A fake qBittorrent Web API v2, enough for the client: login, categories, torrent list and add.

export interface FakeTorrent {
  hash: string;
  name: string;
  category: string;
  state: string;
  progress: number;
  amount_left: number;
  save_path?: string;
  eta?: number;
  dlspeed?: number;
}

export interface FakeFile {
  name: string;
  size: number;
  progress: number;
  priority: number;
}

export interface AddedTorrent {
  category: string;
  magnet?: string;
  torrent?: Uint8Array;
}

export function fakeQBittorrent({
  url = "http://qbittorrent:8080",
  username = "admin",
  password = "secret",
  /** qBittorrent 5 names the cookie after the port. */
  cookieName = "QBT_SID_8080",
  /** Whitelisted subnet: no login needed and no cookie given. */
  bypassAuth = false,
  /** qBittorrent 5.3 answers a successful login with 204 and no body. */
  emptyLogin = false,
} = {}) {
  const state = {
    sessions: new Set<string>(),
    categories: new Set<string>(),
    torrents: [] as FakeTorrent[],
    /** Info-hash → the torrent's files. */
    files: new Map<string, FakeFile[]>(),
    /** When set, every API call (not the login) fails with this status. */
    failWith: undefined as number | undefined,
    added: [] as AddedTorrent[],
    logins: 0,
    requests: [] as Request[],
    /** What `torrents/add` answers next. */
    addAnswer: "Ok.",
  };

  const authed = (request: Request) => {
    if (bypassAuth) return true;
    const cookies = request.headers.get("cookie") ?? "";
    return [...state.sessions].some((sid) => cookies.includes(`${cookieName}=${sid}`));
  };

  async function handle(request: Request): Promise<Response> {
    state.requests.push(request);
    const { pathname, searchParams } = new URL(request.url);
    const path = pathname.replace(/^\/api\/v2\//, "");

    if (path === "auth/login") {
      state.logins++;
      const form = new URLSearchParams(await request.text());
      if (form.get("username") !== username || form.get("password") !== password) return new Response("Fails.");
      if (bypassAuth) return new Response("Ok.");
      const sid = crypto.randomUUID();
      state.sessions.add(sid);
      const headers = { "set-cookie": `${cookieName}=${sid}; HttpOnly; SameSite=Strict; path=/` };
      return emptyLogin ? new Response(null, { status: 204, headers }) : new Response("Ok.", { headers });
    }
    if (!authed(request)) return new Response("Forbidden", { status: 403 });
    if (state.failWith) return new Response("Internal Server Error", { status: state.failWith });

    switch (path) {
      case "torrents/files":
        return Response.json(state.files.get(searchParams.get("hash") ?? "") ?? []);
      case "app/version":
        return new Response("v5.1.2");
      case "torrents/categories":
        return Response.json(Object.fromEntries([...state.categories].map((name) => [name, { name, savePath: "" }])));
      case "torrents/createCategory": {
        const name = new URLSearchParams(await request.text()).get("category") ?? "";
        if (state.categories.has(name)) return new Response("", { status: 409 });
        state.categories.add(name);
        return new Response("");
      }
      case "torrents/info": {
        const hashes = searchParams.get("hashes")?.split("|");
        const category = searchParams.get("category");
        return Response.json(
          state.torrents
            .filter((t) => (!hashes || hashes.includes(t.hash)) && (category === null || t.category === category))
            .map((t) => ({ save_path: "/data/torrents", eta: 8_640_000, dlspeed: 0, ...t })),
        );
      }
      case "torrents/add": {
        const form = await request.formData();
        const category = String(form.get("category") ?? "");
        const file = form.get("torrents");
        const magnet = form.get("urls");
        state.added.push({
          category,
          magnet: typeof magnet === "string" ? magnet : undefined,
          torrent: file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : undefined,
        });
        return new Response(state.addAnswer);
      }
      default:
        return new Response("Not Found", { status: 404 });
    }
  }

  return {
    url,
    username,
    password,
    state,
    handles: (request: Request) => request.url.startsWith(`${url}/`),
    fetch: handle,
    /** Every session expires, as when qBittorrent restarts. */
    expireSessions: () => state.sessions.clear(),
  };
}
