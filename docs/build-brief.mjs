/**
 * Builds the partner-facing PDF brief from brief.template.html.
 *
 *   node docs/build-brief.mjs
 *
 * Renders with headless Chrome (no external dependencies). Edit CONTACT_EMAIL
 * or LOGO_PATH below, or the template itself, and re-run.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const LOGO_PATH = join(HERE, "logo.png");
const CONTACT_EMAIL = "bbsr@amitbooks.com";
const OUT_PDF = join(HERE, "Amit Book Depot - Mulltiply Item Sync Brief.pdf");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const logo = `data:image/png;base64,${readFileSync(LOGO_PATH).toString("base64")}`;
const html = readFileSync(join(HERE, "brief.template.html"), "utf8")
  .replaceAll("__LOGO__", logo)
  .replaceAll("__EMAIL__", CONTACT_EMAIL);

const tmpHtml = join(HERE, ".brief.build.html");
writeFileSync(tmpHtml, html, "utf8");

execFileSync(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--no-pdf-header-footer",
  "--virtual-time-budget=4000",
  `--print-to-pdf=${OUT_PDF}`,
  `file:///${tmpHtml.replaceAll("\\", "/")}`,
], { stdio: "inherit" });

console.log("Wrote", OUT_PDF);
