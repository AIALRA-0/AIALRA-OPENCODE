import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const verifyOnly = process.argv.includes("--verify");
const directoryArgument = process.argv.find(
  (argument) =>
    argument !== "--verify" &&
    argument !== process.argv[0] &&
    argument !== process.argv[1],
);
const directory = resolve(directoryArgument ?? "apps/web/dist");
const indexPath = resolve(directory, "index.html");
let html = await readFile(indexPath, "utf8");

const assetPattern =
  /<(script|link)\b([^>]*?)(?:src|href)="(\/assets\/[^"]+)"([^>]*)>/gu;
const matches = [...html.matchAll(assetPattern)];
if (!matches.length)
  throw new Error("the built index does not reference any local assets");

for (const match of matches) {
  const [element, tag, before, assetUrl, after] = match;
  const assetPath = resolve(directory, assetUrl.slice(1));
  const digest = createHash("sha384")
    .update(await readFile(assetPath))
    .digest("base64");
  const expected = `sha384-${digest}`;
  const integrity = element.match(/\bintegrity="([^"]+)"/u)?.[1];
  if (verifyOnly) {
    if (integrity !== expected || !/\bcrossorigin="anonymous"/u.test(element)) {
      throw new Error(`SRI verification failed for ${assetUrl}`);
    }
    continue;
  }
  const attributes = `${before} ${after}`
    .replace(/\s+integrity="[^"]*"/gu, "")
    .replace(/\s+crossorigin(?:="[^"]*")?/gu, "")
    .trim();
  const locator = tag === "script" ? `src="${assetUrl}"` : `href="${assetUrl}"`;
  const replacement = `<${tag} ${attributes} ${locator} integrity="${expected}" crossorigin="anonymous">`;
  html = html.replace(element, replacement);
}

if (!verifyOnly) await writeFile(indexPath, html, "utf8");
console.log(
  `${verifyOnly ? "Verified" : "Added"} SRI for ${matches.length} assets`,
);
