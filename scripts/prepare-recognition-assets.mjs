import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "recognition-data");
await rm(path.join(root, "public", "ocr"), { recursive: true, force: true });

const copies = [
  ["node_modules/tesseract.js/LICENSE.md", "LICENSE-APACHE-2.0.txt"],
  [
    "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
    "eng.traineddata.gz",
  ],
  [
    "node_modules/@tesseract.js-data/fra/4.0.0_best_int/fra.traineddata.gz",
    "fra.traineddata.gz",
  ],
];

for (const [source, destination] of copies) {
  const destinationPath = path.join(output, destination);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await copyFile(path.join(root, source), destinationPath);
}

const packages = [
  "tesseract.js",
  "tesseract.js-core",
  "@tesseract.js-data/eng",
  "@tesseract.js-data/fra",
];
const notices = [];
for (const packageName of packages) {
  const manifest = JSON.parse(
    await readFile(
      path.join(root, "node_modules", packageName, "package.json"),
      "utf8",
    ),
  );
  const author =
    typeof manifest.author === "string"
      ? manifest.author
      : typeof manifest.author?.name === "string"
        ? manifest.author.name
        : "authors listed by the package";
  notices.push(
    `${manifest.name}@${manifest.version}: ${manifest.license ?? "licence not declared"}; ${author}`,
  );
}
const mitText = `
MIT License (language-data packages listed above)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
await writeFile(
  path.join(output, "THIRD_PARTY_NOTICES.txt"),
  `CardScope server recognition assets\n${notices.join("\n")}\n${mitText}`,
  "utf8",
);
