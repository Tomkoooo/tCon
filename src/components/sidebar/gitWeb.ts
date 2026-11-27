// Map a git remote URL to the hosting site's web pages (GitHub, GitLab, Bitbucket).
// Pure functions: unit-tested in tests/gitGraph.test.ts.

export type GitHost = "GitHub" | "GitLab" | "Bitbucket";

export interface RepoWeb {
  host: GitHost;
  /** https://<host>/<owner>/<repo>, without ".git" */
  base: string;
}

function hostKind(host: string): GitHost | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  if (h === "github.com" || h === "ssh.github.com") return "GitHub";
  if (h === "gitlab.com" || h.startsWith("gitlab.")) return "GitLab";
  if (h === "bitbucket.org") return "Bitbucket";
  return null;
}

/**
 * "git@github.com:o/r.git", "ssh://git@github.com:22/o/r", "https://user@github.com/o/r.git",
 * "git://github.com/o/r" → { host: "GitHub", base: "https://github.com/o/r" }. Unknown hosts → null.
 */
export function remoteToWeb(remote: string | null | undefined): RepoWeb | null {
  const url = (remote ?? "").trim();
  if (!url) return null;
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(url); // user@host:path (scp-like ssh)
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && scp) {
    host = scp[1];
    path = scp[2];
  } else {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(u.protocol)) return null;
    host = u.hostname;
    path = u.pathname;
  }
  const kind = hostKind(host);
  if (!kind) return null;
  const parts = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  // GitHub and Bitbucket are owner/repo; GitLab allows nested groups.
  const repoPath = kind === "GitLab" ? parts : parts.slice(0, 2);
  const webHost = kind === "GitHub" ? "github.com" : host.toLowerCase().replace(/^www\./, "");
  return { host: kind, base: `https://${webHost}/${repoPath.map(encodeURIComponent).join("/")}` };
}

/** Web page of one commit, or null when the remote isn't on a known host. */
export function commitWebUrl(remote: string | null | undefined, sha: string): string | null {
  const web = remoteToWeb(remote);
  if (!web || !/^[0-9a-f]{4,40}$/i.test(sha)) return null;
  switch (web.host) {
    case "GitHub": return `${web.base}/commit/${sha}`;
    case "GitLab": return `${web.base}/-/commit/${sha}`;
    case "Bitbucket": return `${web.base}/commits/${sha}`;
  }
}
