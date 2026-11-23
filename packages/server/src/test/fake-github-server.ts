import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { FakeGitHub, type FakeDelivery } from "./fake-github.ts";

/**
 * The fake GitHub of fake-github.ts as a server, for browser tests, which start it,
 * and the API there goes to it instead of GitHub (GITHUB_URL, GITHUB_API_URL).
 *
 * Who is signed in to "GitHub" is a cookie of this server, `fake_user=<id>.<login>`, so that every
 * test can be someone of its own, and `fake_deny=1` has them say no when they are asked. Tests set
 * things up under /_fake:
 *
 * - `POST /_fake/install?user=<id>.<login>` installs the App on that account (selected
 *   repositories), and says its number; `…/uninstall` takes it off.
 * - `POST /_fake/repo?user=<id>.<login>&name=<name>` makes an empty repository there that the
 *   installation covers, and says its number. `public=1`, `archived=1` and `readOnly=1` make it
 *   that; a body `{ "<path>": "<text>" }` gives it a first commit with those files.
 * - `POST /_fake/commit?user=<id>.<login>&repo=<number>` with `{ "<path>": "<text>" | null }`
 *   changes files on its default branch as that person, as an edit on GitHub, and says the commit.
 * - `POST /_fake/unselect?repo=<number>` takes the repository out of what the installation covers,
 *   as people do on GitHub; `…/select` puts it back. `POST /_fake/archived?repo=<number>&archived=1`
 *   archives it, which makes it read-only (`archived=0` takes that back).
 * - `POST /_fake/deliveries?repo=<number>&secret=<secret>` takes out the webhook deliveries about
 *   that repository so far, signed with the secret: `[{ headers, body }]`, for posting to the API.
 *   Also those of its installation that say it was taken out or put back.
 * - `GET /_fake/key` is the App's private key, for an API that saves projects to this GitHub.
 * - `GET /_fake/files?repo=<number>` is what its default branch has, path by path.
 * - `GET /_fake/lfs?repo=<number>` is what its large file storage has: the size of each object,
 *   by oid, and whether the content is that of the oid.
 * - `GET /_fake/state` says what it has.
 */

const port = Number(process.env["PORT"] ?? "8400");
const fake = new FakeGitHub({
  callbackUrl: process.env["CALLBACK_URL"] ?? "https://editor.example.com/api/auth/github/callback",
});

const userOf = (text: string | null | undefined) => {
  const match = /^(\d+)\.([A-Za-z0-9-]+)$/.exec(text ?? "");
  return match ? { id: Number(match[1]), login: match[2]! } : undefined;
};

const cookieUser = (header: string | undefined) =>
  userOf(/(?:^|;\s*)fake_user=([^;]+)/.exec(header ?? "")?.[1]);

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url ?? "/", `http://127.0.0.1:${port}`);
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    let response: Response;
    if (url.pathname.startsWith("/_fake/")) {
      const user = userOf(url.searchParams.get("user"));
      switch (url.pathname) {
        case "/_fake/install":
          response = user
            ? Response.json({ installation: fake.install(user) })
            : new Response(null, { status: 400 });
          break;
        case "/_fake/repo": {
          const name = url.searchParams.get("name");
          if (!user || !name) {
            response = new Response(null, { status: 400 });
            break;
          }
          const files = body.length > 0 ? (JSON.parse(body.toString("utf8")) as object) : {};
          const repo = fake.addRepo(user, {
            name,
            select: true,
            private: url.searchParams.get("public") !== "1",
            files: files as Record<string, string>,
          });
          repo.archived = url.searchParams.get("archived") === "1";
          repo.readOnly = url.searchParams.get("readOnly") === "1";
          response = Response.json({ id: repo.id });
          break;
        }
        case "/_fake/commit": {
          const repo = Number(url.searchParams.get("repo"));
          if (!user || !fake.repos.has(repo)) {
            response = new Response(null, { status: 400 });
            break;
          }
          const files = JSON.parse(body.toString("utf8")) as Record<string, string | null>;
          response = Response.json({ sha: fake.commitAs(repo, user, files) });
          break;
        }
        case "/_fake/deliveries": {
          const repo = Number(url.searchParams.get("repo"));
          const secret = url.searchParams.get("secret") ?? "";
          const listed = (value: unknown) =>
            Array.isArray(value) && value.some((each) => (each as { id?: unknown }).id === repo);
          const about = (delivery: FakeDelivery) =>
            (delivery.payload["repository"] as { id?: unknown } | undefined)?.id === repo ||
            listed(delivery.payload["repositories_removed"]) ||
            listed(delivery.payload["repositories_added"]);
          const taken = fake.deliveries.filter(about);
          fake.deliveries.splice(
            0,
            fake.deliveries.length,
            ...fake.deliveries.filter((each) => !about(each)),
          );
          response = Response.json(taken.map((delivery) => FakeGitHub.signed(delivery, secret)));
          break;
        }
        case "/_fake/key":
          response = new Response(fake.privateKey);
          break;
        case "/_fake/files": {
          const repo = Number(url.searchParams.get("repo"));
          response = fake.repos.has(repo)
            ? Response.json(Object.fromEntries(fake.files(repo)))
            : new Response(null, { status: 404 });
          break;
        }
        case "/_fake/lfs": {
          const repo = fake.repos.get(Number(url.searchParams.get("repo")));
          response = repo
            ? Response.json(
                Object.fromEntries(
                  [...repo.lfs].map(([oid, data]) => [
                    oid,
                    {
                      size: data.length,
                      same: createHash("sha256").update(data).digest("hex") === oid,
                    },
                  ]),
                ),
              )
            : new Response(null, { status: 404 });
          break;
        }
        case "/_fake/unselect":
        case "/_fake/select": {
          const repo = Number(url.searchParams.get("repo"));
          if (!fake.repos.has(repo)) {
            response = new Response(null, { status: 404 });
            break;
          }
          if (url.pathname === "/_fake/select") fake.select(repo);
          else fake.unselect(repo);
          response = new Response(null, { status: 204 });
          break;
        }
        case "/_fake/archived": {
          const repo = Number(url.searchParams.get("repo"));
          if (!fake.repos.has(repo)) {
            response = new Response(null, { status: 404 });
            break;
          }
          fake.setArchived(repo, url.searchParams.get("archived") === "1");
          response = new Response(null, { status: 204 });
          break;
        }
        case "/_fake/uninstall":
          if (user) fake.uninstall(user);
          response = new Response(null, { status: user ? 204 : 400 });
          break;
        case "/_fake/state":
          response = Response.json({
            installed: [...fake.installed.keys()],
            refreshes: fake.refreshes,
          });
          break;
        default:
          response = new Response("no such thing", { status: 404 });
      }
    } else {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (typeof value === "string") headers.set(name, value);
      response = await fake.handle(
        new Request(url, {
          method: incoming.method ?? "GET",
          headers,
          ...(body.length > 0 && { body }),
        }),
        // The browser's GitHub session: whoever the cookie says.
        cookieUser(incoming.headers.cookie),
        /(?:^|;\s*)fake_deny=1(?:;|$)/.test(incoming.headers.cookie ?? ""),
      );
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500);
    outgoing.end(String(error));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake GitHub on http://127.0.0.1:${port}`);
});
