// Mocked-dependency unit test for tools/remove-background.js. The real @imgly/background-removal-node
// is a ~130MB native package that downloads ONNX models on first use, so this test injects a fake
// `loadImgly` (see that file's opts.loadImgly) instead of installing/calling the real thing -- same
// spirit as lib/email.js/lib/sms.js being tested against a mocked ACS SDK client, not a live resource.
//
// Run with: node test/remove-background.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { removeBackground, parseArgs } = require('../tools/remove-background');

async function run() {
  let passed = 0;
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afd-rembg-test-'));
  const inputPath = path.join(tmpDir, 'input.png');
  fs.writeFileSync(inputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // fake PNG bytes, content is irrelevant -- mocked

  await test('parseArgs reads positional args and --model=', () => {
    const parsed = parseArgs(['in.jpg', 'out.png', '--model=small']);
    assert.strictEqual(parsed.inputArg, 'in.jpg');
    assert.strictEqual(parsed.outputArg, 'out.png');
    assert.strictEqual(parsed.model, 'small');
  });

  await test('parseArgs leaves model undefined when not passed', () => {
    const parsed = parseArgs(['in.jpg', 'out.png']);
    assert.strictEqual(parsed.model, undefined);
  });

  await test('removeBackground() rejects a missing input file', async () => {
    await assert.rejects(
      () => removeBackground(path.join(tmpDir, 'does-not-exist.png'), path.join(tmpDir, 'out.png')),
      /Input file not found/
    );
  });

  await test('removeBackground() rejects an invalid --model value', async () => {
    await assert.rejects(
      () => removeBackground(inputPath, path.join(tmpDir, 'out.png'), { model: 'xl' }),
      /Invalid --model/
    );
  });

  await test('removeBackground() calls the (mocked) imgly library and writes the returned bytes to outputPath', async () => {
    const outputPath = path.join(tmpDir, 'nested', 'out.png');
    const fakePngBytes = Buffer.from('fake-transparent-png-bytes');
    let calledWith = null;

    const loadImgly = () => ({
      removeBackground: async (imageBlob, options) => {
        calledWith = { imageBlob, options };
        return {
          arrayBuffer: async () =>
            fakePngBytes.buffer.slice(fakePngBytes.byteOffset, fakePngBytes.byteOffset + fakePngBytes.byteLength),
        };
      },
    });

    const result = await removeBackground(inputPath, outputPath, { model: 'small', loadImgly });

    assert.strictEqual(result, outputPath);
    assert.ok(calledWith, 'the mocked imgly removeBackground() was never called');
    // A Blob with an explicit MIME type is passed -- not a path string, and not a bare Buffer -- see
    // remove-background.js's comment on why both of those fail against the real package.
    assert.ok(calledWith.imageBlob instanceof Blob, 'expected a Blob, not a path string or bare Buffer');
    assert.strictEqual(calledWith.imageBlob.type, 'image/png');
    const sentBytes = Buffer.from(await calledWith.imageBlob.arrayBuffer());
    assert.ok(sentBytes.equals(fs.readFileSync(inputPath)), 'bytes passed to imgly did not match the input file');
    assert.strictEqual(calledWith.options.model, 'small');
    assert.strictEqual(calledWith.options.output.format, 'image/png');
    assert.ok(fs.existsSync(outputPath), 'output file was not written');
    assert.ok(Buffer.from(fs.readFileSync(outputPath)).equals(fakePngBytes), 'output file bytes did not match the mocked blob');
  });

  await test('removeBackground() defaults to the "medium" model when none is given', async () => {
    let usedModel = null;
    const loadImgly = () => ({
      removeBackground: async (_imgPath, options) => {
        usedModel = options.model;
        return { arrayBuffer: async () => new ArrayBuffer(0) };
      },
    });
    await removeBackground(inputPath, path.join(tmpDir, 'out2.png'), { loadImgly });
    assert.strictEqual(usedModel, 'medium');
  });

  await test('removeBackground() rejects an unrecognized file extension before ever calling imgly', async () => {
    const badInput = path.join(tmpDir, 'input.gif');
    fs.writeFileSync(badInput, Buffer.from([0x47, 0x49, 0x46]));
    const loadImgly = () => ({ removeBackground: async () => { throw new Error('should not be called'); } });
    await assert.rejects(
      () => removeBackground(badInput, path.join(tmpDir, 'out3.png'), { loadImgly }),
      /Unrecognized image extension/
    );
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
