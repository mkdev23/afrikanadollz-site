#!/usr/bin/env node
'use strict';

/*
 * tools/remove-background.js
 *
 * Reusable ASSET-PREP tool for the wig-image pipeline -- this is a build-time/offline script run by a
 * human preparing product photos, NOT a live site feature. Nothing in tryon.html or src/functions/*
 * calls this; it never runs in response to a site visitor.
 *
 * ---- Why this isn't calling Azure AI Vision (as originally asked) ----
 * The task asked for Azure AI Vision (Image Analysis 4.0)'s "Background Removal" feature. Before
 * writing any code, that feature's current status was verified against Microsoft's own docs:
 *   - concept-background-removal.md (Microsoft Learn, current as of 2026): "This feature is now
 *     retired. On March 31, 2025, the Azure AI Image Analysis 4.0 Segment API and background removal
 *     service were retired. API calls to these services will fail."
 *   - The current GA Computer Vision REST API's operation groups (Datasets, Image Analysis, Image
 *     Composition, Image Retrieval, Model Evaluations, Models, Planogram Compliance, Product
 *     Recognition) contain NO Segment/background-removal group at all -- it only ever existed in the
 *     4.0 *preview* API versions (2022-07-31-preview .. v4.0-preview.1), which are all now retired
 *     too. There is no region or SKU that makes a retired API work.
 *   - Microsoft's own recommended replacements, straight from that doc: the open-source Florence-2
 *     model (returns an alpha map but doesn't itself edit the image) or "a third-party utility like
 *     BiRefNet".
 * Given that, no Azure Computer Vision/Vision resource was added to infra/main.bicep for this feature
 * (see that file's header comment for the full research trail) -- provisioning one would just be
 * paying for an endpoint that 404s. This tool instead uses @imgly/background-removal-node, a
 * maintained, offline/local (ONNX runtime) Node library -- the same category of "third-party utility"
 * Microsoft itself now points to for this exact gap.
 *
 * ---- What this tool does NOT do ----
 * This removes the BACKGROUND (the scene behind the subject) only, via general-purpose foreground/
 * background segmentation. It has no concept of "hair" vs. "face/neck/skin" -- a wig product photo
 * that includes a visible face/neck will still have that face/neck in the foreground layer after
 * running through this tool. Masking out the face/neck for a true hair-only alpha cutout is a
 * separate, still-manual step (touch-up in an image editor, or a second more targeted matting pass)
 * downstream of this one. This tool exists to kill the tedious, fragile part of the job (cleanly
 * separating subject from background) -- it is one stage of the asset pipeline, not the whole thing.
 *
 * ---- Usage ----
 *   cd tools && npm install        # one-time; pulls in onnxruntime-node + sharp native binaries
 *   node remove-background.js <input-image> <output.png> [--model=small|medium|large]
 *
 * `tools/` is a separate npm package on purpose (see tools/package.json) -- its dependencies are
 * heavy (~130MB unpacked, native binaries) and have no business being zipped up and shipped as part
 * of the Azure Functions app deployment unit (the root package.json), which is a completely separate
 * concern from this offline asset-prep tool.
 */

const path = require('path');
const fs = require('fs');

const VALID_MODELS = new Set(['small', 'medium', 'large']);
const EXT_TO_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/**
 * Remove the background from a single image file, writing a transparent-background PNG to
 * `outputPath`. See the file header for exactly what this does and does not do.
 * @param {string} inputPath - path to a source image (jpg/png/webp).
 * @param {string} outputPath - path to write the resulting transparent PNG.
 * @param {{model?: string, loadImgly?: Function}} [opts] - `loadImgly` is exposed purely so tests can
 *   inject a mock instead of the real (130MB, ONNX-model-downloading) package.
 * @returns {Promise<string>} the resolved outputPath, on success.
 */
async function removeBackground(inputPath, outputPath, opts = {}) {
  if (!inputPath || !outputPath) {
    throw new Error('removeBackground requires both an inputPath and an outputPath');
  }
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }
  const model = opts.model || 'medium';
  if (!VALID_MODELS.has(model)) {
    throw new Error(`Invalid --model "${model}" -- expected one of: ${[...VALID_MODELS].join(', ')}`);
  }

  // Lazily required (and injectable via opts.loadImgly) so this file can be `node --check`'d and unit
  // tested without the real, heavy dependency installed.
  const loadImgly = opts.loadImgly || (() => require('@imgly/background-removal-node'));
  const { removeBackground: imglyRemoveBackground } = loadImgly();

  // Pass a Blob with an explicit MIME type -- NOT the path string, and NOT a bare Buffer/Uint8Array.
  // Both were tried and both fail, verified live against the real package:
  //  - a path string: @imgly's `ImageSource` string variant is resolved as a file:// URI relative to
  //    process.cwd(), and a Windows absolute path like "C:\...\logo.png" gets its drive letter "C:"
  //    misparsed as a URL scheme -> "Unsupported protocol: c:".
  //  - a bare Buffer/Uint8Array: internally becomes `new Blob([bytes])` with NO type set, so its
  //    format-sniffing (which switches on `blob.type`) falls through to "Unsupported format: " (empty
  //    string) even for a perfectly valid PNG.
  // A Blob constructed with the correct `type` up front sidesteps both: it's handled directly, and its
  // `.type` is exactly what the format switch needs.
  const ext = path.extname(inputPath).toLowerCase();
  const mimeType = EXT_TO_MIME[ext];
  if (!mimeType) {
    throw new Error(`Unrecognized image extension "${ext}" -- expected one of: ${Object.keys(EXT_TO_MIME).join(', ')}`);
  }
  const imageBytes = fs.readFileSync(inputPath);
  const imageBlob = new Blob([imageBytes], { type: mimeType });
  const blob = await imglyRemoveBackground(imageBlob, {
    model,
    output: { format: 'image/png', quality: 1 },
  });
  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

function parseArgs(argv) {
  const [inputArg, outputArg, ...rest] = argv;
  const modelArg = rest.find((a) => a.startsWith('--model='));
  return {
    inputArg,
    outputArg,
    model: modelArg ? modelArg.split('=')[1] : undefined,
  };
}

async function main() {
  const { inputArg, outputArg, model } = parseArgs(process.argv.slice(2));
  if (!inputArg || !outputArg) {
    console.error('Usage: node tools/remove-background.js <input-image> <output.png> [--model=small|medium|large]');
    process.exitCode = 1;
    return;
  }

  const inputPath = path.resolve(process.cwd(), inputArg);
  const outputPath = path.resolve(process.cwd(), outputArg);

  console.log(`Removing background: ${inputPath}`);
  console.log(`              -> ${outputPath}`);
  console.log('NOTE: background removal only -- a visible face/neck in the source photo will still be');
  console.log('present in the output. Hair-only masking is a separate, still-manual step.');

  await removeBackground(inputPath, outputPath, { model });
  console.log('Done.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('remove-background failed:', (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { removeBackground, parseArgs };
