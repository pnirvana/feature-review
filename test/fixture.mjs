// A sample feature: a parent directory with two service worktrees, each cloned from its
// own bare "origin", on a feature branch with committed, uncommitted and untracked changes,
// a rename and a deletion. Used by the tests and by `node test/fixture.mjs <dir> [--annotate]`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Sample',
  GIT_AUTHOR_EMAIL: 'sample@example.invalid',
  GIT_COMMITTER_NAME: 'Sample',
  GIT_COMMITTER_EMAIL: 'sample@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
function write(dir, files) {
  for (const [p, text] of Object.entries(files)) {
    const f = path.join(dir, p);
    if (text === null) fs.rmSync(f);
    else {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    }
  }
}

/** A service: base files on main (pushed to origin), then the feature's commits and working-tree edits. */
function service(top, name, { base, feature, uncommitted = {}, renames = [] }) {
  const seed = path.join(top, 'remotes', `${name}-seed`);
  fs.mkdirSync(seed, { recursive: true });
  sh(seed, 'init', '-q', '-b', 'main');
  write(seed, base);
  sh(seed, 'add', '-A');
  sh(seed, 'commit', '-q', '-m', 'base');
  const origin = path.join(top, 'remotes', `${name}.git`);
  sh(top, 'clone', '-q', '--bare', seed, origin);
  const wt = path.join(top, 'feature', name);
  sh(top, 'clone', '-q', origin, wt);
  sh(wt, 'switch', '-q', '-c', 'feature/idempotent-refunds');
  for (const [a, b] of renames) sh(wt, 'mv', a, b);
  write(wt, feature);
  sh(wt, 'add', '-A');
  sh(wt, 'commit', '-q', '-m', 'feature');
  write(wt, uncommitted);
  return wt;
}

const javaClass = (pkg, name, body) => `package ${pkg};\n\npublic class ${name} {\n${body}}\n`;

/** Build the sample under `top` (must not exist or be empty). → the feature directory. */
export function makeSample(top) {
  fs.mkdirSync(top, { recursive: true });
  service(top, 'gateway', {
    base: {
      'src/main/java/shop/gateway/RefundController.java': javaClass(
        'shop.gateway',
        'RefundController',
        '    /* Refunds\n       an order. */\n    public String refund(String orderId, long amount) {\n        if (amount <= 0) {\n            throw new IllegalArgumentException("amount");\n        }\n        return client.refund(orderId, amount);\n    }\n',
      ),
      'src/main/resources/application.yml': 'server:\n  port: 8080\nrefund:\n  timeout: 2s\n',
    },
    feature: {
      'src/main/java/shop/gateway/RefundController.java': javaClass(
        'shop.gateway',
        'RefundController',
        '    /* Refunds\n       an order, once per key. */\n    public String refund(String orderId, long amount, String idempotencyKey) {\n        return client.refund(orderId, amount, idempotencyKey);\n    }\n',
      ),
      'src/main/java/shop/gateway/RefundRequest.java': 'package shop.gateway;\n\npublic record RefundRequest(String orderId, long amount, String idempotencyKey) {}\n',
    },
    uncommitted: {
      'src/main/resources/application.yml': 'server:\n  port: 8080\nrefund:\n  timeout: 5s\n',
      'src/main/java/shop/gateway/IdempotencyKey.java': javaClass('shop.gateway', 'IdempotencyKey', '    private final String value;\n'),
    },
  });
  service(top, 'refund-service', {
    base: {
      'src/main/java/shop/refund/RefundService.java': javaClass('shop.refund', 'RefundService', '    public void refund(String orderId, long amount) {\n        ledger.book(orderId, -amount);\n    }\n'),
      'src/main/java/shop/refund/Util.java': javaClass('shop.refund', 'Util', '    static long cents(long x) { return x * 100; }\n'),
      'src/main/java/shop/refund/Legacy.java': javaClass('shop.refund', 'Legacy', '    // old refund path\n'),
      'src/test/groovy/shop/refund/RefundServiceSpec.groovy':
        "package shop.refund\n\nimport spock.lang.Specification\n\nclass RefundServiceSpec extends Specification {\n    def 'books a refund'() {\n        when:\n        service.refund('o1', 5)\n\n        then:\n        1 * ledger.book('o1', -5)\n    }\n}\n",
      'helm/values.yaml': 'replicaCount: 2\nresources:\n  limits:\n    memory: 512Mi\n',
    },
    renames: [['src/main/java/shop/refund/Util.java', 'src/main/java/shop/refund/MoneyUtil.java']],
    feature: {
      'src/main/java/shop/refund/RefundService.java': javaClass(
        'shop.refund',
        'RefundService',
        '    public void refund(String orderId, long amount, String key) {\n        if (seen.contains(key)) return;\n        ledger.book(orderId, -amount);\n        seen.add(key);\n    }\n',
      ),
      'src/main/java/shop/refund/Legacy.java': null,
      'src/test/groovy/shop/refund/RefundServiceSpec.groovy':
        "package shop.refund\n\nimport spock.lang.Specification\n\nclass RefundServiceSpec extends Specification {\n    def 'books a refund once per key'() {\n        when:\n        service.refund('o1', 5, 'k')\n        service.refund('o1', 5, 'k')\n\n        then:\n        _ * ledger.book(_, _)\n    }\n}\n",
      'helm/values.yaml': 'replicaCount: 3\nresources:\n  limits:\n    memory: 512Mi\n',
    },
  });
  return path.join(top, 'feature');
}

const RC = 'src/main/java/shop/gateway/RefundController.java';
const RS = 'src/main/java/shop/refund/RefundService.java';
const SPEC = 'src/test/groovy/shop/refund/RefundServiceSpec.groovy';

/** Annotations for a fresh sample, as an agent would write them; gateway:H1 is left ungrouped on purpose. */
export function sampleAnnotations() {
  return {
    version: 1,
    intent: 'Refunds must be **idempotent**: a retried refund with the same key is booked once.\n\n- the gateway sends an idempotency key\n- refund-service books each key once',
    written: { by: 'sample', at: '2026-11-21T16:00:00Z' },
    groups: [
      {
        id: 'refund-key',
        title: 'Refunds carry an idempotency key from the gateway to the ledger',
        why: 'Retries of a refund must not book it twice. The key travels with the request:\n\n1. `RefundRequest` gains `idempotencyKey`\n2. `RefundService.refund` skips a key it has *seen*',
        requested: 'yes',
        risk: 'high',
        risk_signals: ['money', 'public contract', 'deleted check'],
        parts: [
          { ref: { hunk: 'gateway:H3' }, role: 'interface', note: 'the request gains the key' },
          { ref: { repo: 'gateway', file: RC, lines: '4-8' }, role: 'implementation', note: 'the `amount <= 0` check is **gone**' },
          { ref: { repo: 'refund-service', file: RS, lines: '4-8' }, role: 'implementation', note: 'keys are kept in memory' },
          { ref: { hunk: 'refund-service:H5' }, role: 'test' },
        ],
      },
      {
        id: 'config',
        title: 'Longer refund timeout, one more replica',
        why: 'Not explained by the intent.',
        requested: 'unclear',
        risk: 'medium',
        parts: [
          { ref: { repo: 'gateway', file: 'src/main/resources/application.yml', lines: '4' }, role: 'config' },
          { ref: { repo: 'refund-service', file: 'helm/values.yaml', lines: '1' }, role: 'infra', note: 'the in-memory key set is per replica' },
        ],
      },
      {
        id: 'cleanup',
        title: 'Remove the legacy refund path, rename Util',
        why: 'Legacy is unused since the new path.',
        requested: 'no',
        risk: 'low',
        mechanical: 'deletes an unused class and renames another; no behaviour change',
        parts: [
          { ref: { hunk: 'refund-service:H2' }, role: 'implementation' },
          { ref: { hunk: 'refund-service:H3' }, role: 'implementation' },
        ],
      },
    ],
    tests: [
      {
        ref: { hunk: 'refund-service:H5' },
        name: 'books a refund once per key',
        behaviour: 'A refund retried with the same key is booked once.',
        group: 'refund-key',
        asserts: 'That ledger.book is called any number of times, with any arguments.',
        flags: [
          { kind: 'name-vs-assertion', note: "named 'once' but asserts _ * (any number of calls)" },
          { kind: 'loosened', refs: [{ repo: 'refund-service', file: SPEC, lines: '11', side: 'old' }] },
        ],
      },
    ],
    ghosts: [
      {
        ref: { path: '../remotes/refund-service-seed', file: RS, lines: '4-6' },
        because: [{ repo: 'refund-service', file: RS, lines: '4' }],
        why: 'Another checkout still calls refund(orderId, amount) without a key.',
        status: 'unclear',
        found_by: "grep 'refund(' in all repositories",
      },
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const top = process.argv[2];
  if (!top) {
    console.error('usage: node test/fixture.mjs <new-directory>');
    process.exit(2);
  }
  if (fs.existsSync(top) && fs.readdirSync(top).length) {
    console.error(`${top} is not empty`);
    process.exit(1);
  }
  const dir = makeSample(path.resolve(top));
  if (process.argv.includes('--annotate')) {
    fs.mkdirSync(path.join(dir, '.feature-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.feature-review', 'annotations.json'), JSON.stringify(sampleAnnotations(), null, 2) + '\n');
  }
  console.log(dir);
}
