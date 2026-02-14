#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import * as Sparse from "../sparse";

export async function simg2img(inputPath, outputPath) {
  const sparseImage = new Blob([readFileSync(inputPath)]);

  const sparse = await Sparse.from(sparseImage);
  if (!sparse) throw "Failed to parse sparse file";

  const chunks = [];
  for await (const [_, chunk, size] of sparse.read()) {
    if (chunk) {
      chunks.push(new Uint8Array(await chunk.arrayBuffer()));
    } else {
      chunks.push(new Uint8Array(size));
    }
  }
  writeFileSync(outputPath, Buffer.concat(chunks));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (process.argv.length < 4) {
    throw "Usage: simg2img <input_path> <output_path>";
  }
  const startTime = performance.now();
  await simg2img(process.argv[2], process.argv[3]);
  const endTime = performance.now();
  console.info(`Done in ${((endTime - startTime) / 1000).toFixed(3)}s`);
}
