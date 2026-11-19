import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCoverage, criticalTests } from '../scripts/assert-ci-coverage.mjs';

const files = ['a.test.mjs', 'b.test.mjs'];
const valid = '# xats-test-files: ' + JSON.stringify(files) + '\n' + criticalTests.map((name, i) => `ok ${i + 1} - ${name}`).join('\n') + '\n# fail 0\n';

test('coverage gate accepts complete non-skipped critical coverage', () => {
  assert.deepEqual(assertCoverage(valid, { files }), { fileCount: 2, skips: [] });
});

test('coverage gate rejects a truncated file list, missing critical tests, or a failure summary', () => {
  assert.throws(() => assertCoverage(valid.replace(JSON.stringify(files), '["a.test.mjs"]'), { files }), /truncated/);
  assert.throws(() => assertCoverage(valid.replace(`ok 1 - ${criticalTests[0]}`, ''), { files }), /Critical test/);
  assert.throws(() => assertCoverage(valid.replace('# fail 0', '# fail 1'), { files }), /zero failures/);
  assert.throws(() => assertCoverage(valid + '# fail 1\n', { files }), /zero failures/);
});

test('coverage gate never accepts skipped critical tests or unknown skips', () => {
  assert.throws(() => assertCoverage(valid.replace(criticalTests[0] + '\n', criticalTests[0] + ' # SKIP missing dependencies\n'), { files }), /Critical test/);
  assert.throws(() => assertCoverage(valid + 'ok 99 - new test # SKIP dependency absent\n', { files }), /Unexpected skipped/);
});

test('only explicit platform and namespace capability skips are allowed', () => {
  const osOnly = 'custom supervisor rejection happens before daemon or earlier agent files change';
  const namespace = 'routed invite E2E: isolated peer subnets pair and federate through a router namespace';
  assert.deepEqual(assertCoverage(valid + `ok 99 - ${namespace} # SKIP capability absent\n`, { files }).skips, [namespace]);
  assert.deepEqual(assertCoverage(valid + `ok 99 - ${osOnly} # SKIP Linux only\n`, { files, platform: 'win32' }).skips, [osOnly]);
  assert.throws(() => assertCoverage(valid + `ok 99 - ${osOnly} # SKIP Linux only\n`, { files, platform: 'linux' }), /Unexpected skipped/);
});
