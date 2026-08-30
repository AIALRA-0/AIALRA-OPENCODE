import lock from "../upstream.lock.json" with { type: "json" };

const response = await fetch(
  "https://api.github.com/repos/anomalyco/opencode/releases/latest",
  {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "aialra-opencode-upstream-discovery",
      ...(process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
  },
);

if (!response.ok)
  throw new Error(`GitHub release discovery failed with ${response.status}`);
const release = await response.json();
if (
  release.draft ||
  release.prerelease ||
  typeof release.tag_name !== "string"
) {
  throw new Error("latest release response is not a stable tagged release");
}

const latest = release.tag_name;
const pinned = lock.upstream.tag;
process.stdout.write(`latest_tag=${latest}\n`);
process.stdout.write(`pinned_tag=${pinned}\n`);
process.stdout.write(`update_available=${latest !== pinned}\n`);
