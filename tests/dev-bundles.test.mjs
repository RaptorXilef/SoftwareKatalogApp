import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createDevActions } from '../src/main/dev-projects/dev-actions.js';
import { createDevBundlesService } from '../src/main/dev-projects/dev-bundles-service.js';
import { isProtectedAdminChannel } from '../src/shared/auth-logic.js';
import {
  buildDevBundleDraftFromProject,
  buildExportDevBundlePayload,
  dedupeDevBundlePackages,
  evaluateDevBundleForProject,
  filterDevBundlesForProject,
  mergeDevAuditReports,
  moveDevBundlePackage,
  normalizeDevBundle,
  parseComposerAuditJson,
  parseNpmAuditJson,
  resolveImportedDevBundleId,
  validateImportDevBundlePayload,
  validateImportDevBundlesPayload,
} from '../src/shared/dev-bundles-logic.js';
import {
  buildDevAuditCommand,
  buildDevAuditFixCommand,
  buildDevBatchInstallSteps,
  parseComposerJsonDirect,
  parsePackageJsonDirect,
} from '../src/shared/dev-projects-logic.js';

const tempDirs = [];

function makeTempDir(prefix = 'sk-dev-bundles-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFakeJobFactory() {
  const jobs = [];
  const createJobFn = ({ type, title, dedupeKey, cancelable }) => {
    const controller = new AbortController();
    const record = {
      type,
      title,
      dedupeKey,
      cancelable,
      updates: [],
      finished: null,
      controller,
    };
    jobs.push(record);
    return {
      id: `job-${jobs.length}`,
      signal: controller.signal,
      update(pct, detail) {
        record.updates.push({ pct, detail });
      },
      finish(status, detail) {
        record.finished = { status, detail };
      },
    };
  };
  return { jobs, createJobFn };
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignorieren
    }
  }
});

describe('dev-bundles-logic: Normalisierung, Deduplizierung & Sortierung', () => {
  it('normalisiert Dev-Buendel auf das feste Schema und bereinigt ungueltige Pakete/Versionen', () => {
    const bundle = normalizeDevBundle(
      {
        id: 'js-quality',
        name: '  JS Quality Stack  ',
        description: 'Biome + TypeScript',
        icon: '',
        manager: 'NPM',
        packages: [
          { name: '@biomejs/biome', version: '^2.0.0', isDev: true, optional: false },
          { name: '@BIOMEJS/BIOME', version: '9.9.9', isDev: false },
          { name: 'knip', version: 'invalid version with spaces', isDev: true, optional: true },
          { name: 'bad pkg; rm -rf /', isDev: true },
          { name: 'typescript', isDev: true },
        ],
      },
      { now: 12345 }
    );

    assert.equal(bundle.id, 'js-quality');
    assert.equal(bundle.name, 'JS Quality Stack');
    assert.equal(bundle.icon, '🧺');
    assert.equal(bundle.manager, 'npm');
    assert.equal(bundle.createdAt, 12345);
    assert.equal(bundle.updatedAt, 12345);
    assert.deepEqual(bundle.packages, [
      { name: '@biomejs/biome', version: '^2.0.0', isDev: true, optional: false },
      { name: 'knip', version: '', isDev: true, optional: true },
      { name: 'typescript', version: '', isDev: true, optional: false },
    ]);
  });

  it('dedupliziert Python-Pakete PEP-503-konform und verschiebt Pakete per Index', () => {
    const deduped = dedupeDevBundlePackages(
      [
        { name: 'scikit-learn', isDev: false },
        { name: 'Scikit_Learn', isDev: true },
        { name: 'pytest', isDev: true },
      ],
      'uv'
    );
    assert.equal(deduped.length, 2);
    assert.equal(deduped[0].name, 'scikit-learn');
    assert.equal(deduped[1].name, 'pytest');

    const moved = moveDevBundlePackage(deduped, 1, 0);
    assert.deepEqual(
      moved.map((p) => p.name),
      ['pytest', 'scikit-learn']
    );
    assert.deepEqual(moveDevBundlePackage(deduped, -1, 0), deduped);
  });
});

describe('dev-bundles-logic: Export/Import-Validierung & ID-Kollisionsaufloesung', () => {
  it('validiert gueltige Einzel-, Mehrfach- und Array-Exporte und lehnt defekte Payloads ab', () => {
    const sample = normalizeDevBundle({
      id: 'php-quality',
      name: 'PHP Quality Stack',
      description: 'Static analysis & formatting',
      icon: '🐘',
      manager: 'composer',
      packages: [
        { name: 'phpstan/phpstan', version: '^2.0', isDev: true, optional: false },
        { name: 'laravel/pint', version: '', isDev: true, optional: false },
      ],
    });

    const exported = buildExportDevBundlePayload(sample);
    assert.equal(exported.format, 'software-katalog-dev-bundle');
    assert.equal(exported.version, 1);

    const singleCheck = validateImportDevBundlePayload(exported);
    assert.equal(singleCheck.valid, true);
    if (singleCheck.valid) {
      assert.equal(singleCheck.bundle.manager, 'composer');
      assert.equal(singleCheck.bundle.packages.length, 2);
    }

    const multiCheck = validateImportDevBundlesPayload({
      format: 'software-katalog-dev-bundles',
      bundles: [sample],
    });
    assert.equal(multiCheck.valid, true);
    if (multiCheck.valid) {
      assert.equal(multiCheck.bundles.length, 1);
    }

    const arrayCheck = validateImportDevBundlesPayload([sample]);
    assert.equal(arrayCheck.valid, true);

    assert.equal(
      validateImportDevBundlePayload({ format: 'wrong-format', name: 'x', manager: 'npm', packages: [] }).valid,
      false
    );
    assert.equal(validateImportDevBundlePayload({ name: 'x', manager: 'unknown-mgr', packages: [] }).valid, false);
    assert.equal(
      validateImportDevBundlePayload({
        name: 'Bad Pkg',
        manager: 'composer',
        packages: [{ name: 'invalid-without-slash', isDev: true }],
      }).valid,
      false
    );
    assert.equal(validateImportDevBundlesPayload([]).valid, false);
  });

  it('loest ID-Kollisionen beim Import deterministisch auf', () => {
    const existing = new Set(['stack-1', 'uuid-1']);
    let seq = 0;
    const nextId = () => `uuid-${++seq}`;

    assert.equal(resolveImportedDevBundleId('stack-2', existing, nextId), 'stack-2');
    assert.equal(resolveImportedDevBundleId('stack-1', existing, nextId), 'uuid-2');
    assert.equal(resolveImportedDevBundleId('', existing, nextId), 'uuid-3');
  });
});

describe('dev-bundles-logic: Projekt-Abgleich & Snapshot-Erstellung', () => {
  it('vergleicht Pakete gegen Projekt-Scan (installed, outdated, missing) inkl. Oekosystem-Abgleich', () => {
    const bundle = normalizeDevBundle({
      id: 'js-stack',
      name: 'JS Quality Stack',
      manager: 'npm',
      packages: [
        { name: '@biomejs/biome', version: '', isDev: true, optional: false },
        { name: 'typescript', version: '', isDev: true, optional: false },
        { name: 'knip', version: '6.50.0', isDev: true, optional: false },
        { name: 'husky', version: '', isDev: true, optional: false },
        { name: 'prettier', version: '', isDev: true, optional: true },
      ],
    });

    const scan = {
      managers: ['pnpm'],
      installed: [
        { manager: 'pnpm', name: '@biomejs/biome', installedVersion: '2.6.6', scope: 'dev' },
        { manager: 'pnpm', name: 'typescript', installedVersion: '7.0.0', scope: 'dev' },
        { manager: 'pnpm', name: 'knip', installedVersion: '6.48.0', scope: 'dev' },
      ],
      updates: [
        {
          manager: 'pnpm',
          name: 'typescript',
          current: '7.0.0',
          wanted: '7.0.2',
          latest: '7.0.2',
          isMajor: false,
        },
      ],
    };

    const evaluation = evaluateDevBundleForProject(bundle, scan);
    assert.equal(evaluation.summary.total, 5);
    assert.equal(evaluation.summary.installedCount, 1);
    assert.equal(evaluation.summary.outdatedCount, 2);
    assert.equal(evaluation.summary.missingCount, 2);
    assert.equal(evaluation.summary.presentCount, 3);

    const byName = new Map(evaluation.packages.map((p) => [p.name, p]));
    assert.equal(byName.get('@biomejs/biome')?.status, 'installed');
    assert.equal(byName.get('@biomejs/biome')?.defaultSelected, false);

    assert.equal(byName.get('typescript')?.status, 'outdated');
    assert.equal(byName.get('typescript')?.targetVersion, '7.0.2');
    assert.equal(byName.get('typescript')?.defaultSelected, true);

    assert.equal(byName.get('knip')?.status, 'outdated');
    assert.equal(byName.get('knip')?.targetVersion, '6.50.0');

    assert.equal(byName.get('husky')?.status, 'missing');
    assert.equal(byName.get('husky')?.defaultSelected, true);

    assert.equal(byName.get('prettier')?.status, 'missing');
    assert.equal(byName.get('prettier')?.defaultSelected, false);

    const compat = filterDevBundlesForProject(
      [bundle, normalizeDevBundle({ id: 'php', name: 'PHP', manager: 'composer', packages: [] })],
      {
        detectedManagers: ['pnpm'],
        showAllManagers: false,
      }
    );
    assert.equal(compat.length, 0);

    const compatWithNpm = filterDevBundlesForProject([bundle], {
      detectedManagers: ['yarn'],
      showAllManagers: false,
    });
    assert.equal(compatWithNpm.length, 1);

    const allShown = filterDevBundlesForProject([bundle], {
      detectedManagers: ['pnpm'],
      showAllManagers: true,
    });
    assert.equal(allShown.length, 1);
  });

  it('erstellt 1-Klick-Snapshot aus geparsten package.json und composer.json Manifesten', () => {
    const pkgDirect = parsePackageJsonDirect(
      JSON.stringify({
        dependencies: { dompurify: '^3.4.0' },
        devDependencies: { '@biomejs/biome': '^2.6.6', knip: '^6.48.0' },
      }),
      'npm'
    );
    const composerDirect = parseComposerJsonDirect(
      JSON.stringify({
        require: { 'monolog/monolog': '^3.7' },
        'require-dev': { 'phpstan/phpstan': '^2.0', 'laravel/pint': '^1.18' },
      })
    );

    const scan = {
      managers: ['npm', 'composer'],
      installed: [
        ...pkgDirect.map((p) => ({ ...p, installedVersion: p.declaredRange.replace('^', '') })),
        ...composerDirect.map((p) => ({ ...p, installedVersion: '2.0.0' })),
      ],
    };

    const npmSnap = buildDevBundleDraftFromProject({
      project: { name: 'MyApp' },
      scan,
      manager: 'npm',
      includeProd: true,
      includeDev: true,
      pinVersions: true,
    });
    assert.equal(npmSnap.manager, 'npm');
    assert.equal(npmSnap.prodCount, 1);
    assert.equal(npmSnap.devCount, 2);
    assert.deepEqual(
      npmSnap.draft.packages.map((p) => ({ name: p.name, isDev: p.isDev, version: p.version })),
      [
        { name: 'dompurify', isDev: false, version: '3.4.0' },
        { name: '@biomejs/biome', isDev: true, version: '2.6.6' },
        { name: 'knip', isDev: true, version: '6.48.0' },
      ]
    );

    const phpDevOnlySnap = buildDevBundleDraftFromProject({
      project: { name: 'MyApp' },
      scan,
      manager: 'composer',
      includeProd: false,
      includeDev: true,
      pinVersions: false,
    });
    assert.equal(phpDevOnlySnap.manager, 'composer');
    assert.equal(phpDevOnlySnap.prodCount, 0);
    assert.equal(phpDevOnlySnap.devCount, 2);
    assert.equal(phpDevOnlySnap.draft.packages[0].version, '');
  });
});

describe('dev-bundles-logic: Security Audit JSON-Parser (npm & composer)', () => {
  it('parst npm audit --json (v7+ vulnerabilities & v6/pnpm advisories)', () => {
    const npmV7Raw = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        lodash: {
          name: 'lodash',
          severity: 'high',
          isDirect: true,
          via: [{ title: 'Prototype Pollution', url: 'https://github.com/advisories/GHSA-1', range: '<4.17.21' }],
          fixAvailable: true,
        },
        minimist: {
          name: 'minimist',
          severity: 'critical',
          isDirect: false,
          via: ['mkdirp'],
          fixAvailable: { name: 'mkdirp', version: '1.0.4', isSemVerMajor: true },
          range: '<1.2.6',
        },
      },
      metadata: { vulnerabilities: { critical: 1, high: 1, moderate: 0, low: 0, total: 2 } },
    });

    const parsedV7 = parseNpmAuditJson(npmV7Raw, { manager: 'npm' });
    assert.equal(parsedV7.valid, true);
    assert.deepEqual(parsedV7.counts, { critical: 1, high: 1, moderate: 0, low: 0, total: 2 });
    assert.equal(parsedV7.vulnerabilities[0].packageName, 'minimist');
    assert.equal(parsedV7.vulnerabilities[0].fixIsMajor, true);
    assert.equal(parsedV7.vulnerabilities[1].packageName, 'lodash');

    const pnpmV6Raw = `\uFEFF{"advisories":{"101":{"module_name":"ws","severity":"moderate","title":"ReDoS in ws","url":"https://npmjs.com/advisories/101","vulnerable_versions":"<8.17.1","patched_versions":">=8.17.1","cves":["CVE-2024-37890"]}}}`;
    const parsedPnpm = parseNpmAuditJson(pnpmV6Raw, { manager: 'pnpm' });
    assert.equal(parsedPnpm.valid, true);
    assert.equal(parsedPnpm.canAutoFix, false);
    assert.deepEqual(parsedPnpm.counts, { critical: 0, high: 0, moderate: 1, low: 0, total: 1 });
    assert.equal(parsedPnpm.vulnerabilities[0].cve, 'CVE-2024-37890');
  });

  it('parst composer audit --format=json inkl. Schweregraden, Fallback und abandoned Paketen', () => {
    const composerRaw = [
      'Changed current directory to C:\\project',
      JSON.stringify({
        advisories: {
          'symfony/http-kernel': [
            {
              advisoryId: 'PKSA-001',
              packageName: 'symfony/http-kernel',
              title: 'Header injection',
              cve: 'CVE-2025-0001',
              link: 'https://symfony.com/cve-2025-0001',
              affectedVersions: '<6.4.14',
              severity: 'medium',
            },
            {
              advisoryId: 'PKSA-002',
              packageName: 'symfony/http-kernel',
              title: 'Remote code execution',
              cve: 'CVE-2025-0002',
              link: 'https://symfony.com/cve-2025-0002',
              affectedVersions: '<6.4.15',
              severity: 'critical',
            },
          ],
          'vendor/legacy': [
            {
              advisoryId: 'PKSA-003',
              packageName: 'vendor/legacy',
              title: 'Minor info leak',
              severity: 'low',
            },
          ],
        },
        abandoned: {
          'swiftmailer/swiftmailer': 'symfony/mailer',
        },
      }),
    ].join('\n');

    const parsed = parseComposerAuditJson(composerRaw);
    assert.equal(parsed.valid, true);
    assert.deepEqual(parsed.counts, { critical: 1, high: 0, moderate: 1, low: 1, total: 3 });
    assert.equal(parsed.vulnerabilities[0].severity, 'critical');
    assert.equal(parsed.vulnerabilities[1].severity, 'moderate');
    assert.equal(parsed.abandoned.length, 1);
    assert.equal(parsed.abandoned[0].replacement, 'symfony/mailer');

    const merged = mergeDevAuditReports([
      parseNpmAuditJson(JSON.stringify({ vulnerabilities: {} }), { manager: 'npm' }),
      parsed,
    ]);
    assert.deepEqual(merged.managers, ['npm', 'composer']);
    assert.deepEqual(merged.fixableManagers, ['composer']);
    assert.equal(merged.canAutoFix, true);
  });
});

describe('dev-bundles-service & dev-actions: Atomare Speicherung, Batch-Install & Audit', () => {
  it('speichert Dev-Buendel atomar in dev-bundles.json und fuehrt CRUD + Export/Import aus', async () => {
    const root = makeTempDir();
    const dataDir = path.join(root, 'data');
    const exportFile = path.join(root, 'exported-bundle.json');
    fs.mkdirSync(dataDir, { recursive: true });

    let clock = 5000;
    let seq = 0;
    const service = createDevBundlesService({
      getDataFolderFn: () => dataDir,
      nowFn: () => {
        clock += 100;
        return clock;
      },
      randomUUIDFn: () => `devb-${++seq}`,
      showSaveDialogFn: async () => ({ canceled: false, filePath: exportFile }),
      showOpenDialogFn: async () => ({ canceled: false, filePaths: [exportFile] }),
    });

    const saved = service.saveDevBundle({
      name: 'JS Quality Stack',
      description: 'Lint & format',
      icon: '⚡',
      manager: 'npm',
      packages: [
        { name: '@biomejs/biome', isDev: true },
        { name: 'knip', isDev: true },
        { name: 'zod', isDev: false },
      ],
    });
    assert.equal(saved.success, true);
    assert.equal(saved.bundle.id, 'devb-1');
    assert.ok(fs.existsSync(path.join(dataDir, 'dev-bundles.json')));

    const dup = service.duplicateDevBundle('devb-1');
    assert.equal(dup.success, true);
    assert.equal(dup.bundle.id, 'devb-2');
    assert.equal(dup.bundle.name, 'JS Quality Stack (Copy)');

    const exp = await service.exportDevBundle('devb-1');
    assert.equal(exp.success, true);
    assert.ok(fs.existsSync(exportFile));

    const imp = await service.importDevBundle();
    assert.equal(imp.success, true);
    assert.equal(imp.importedCount, 1);
    // ID devb-1 existiert bereits -> Kollision auf devb-3 aufgeloest
    assert.equal(imp.bundle.id, 'devb-3');

    const del = service.deleteDevBundle('devb-2');
    assert.equal(del.success, true);
    assert.equal(service.loadDevBundles().bundles.length, 2);
  });

  it('installiert fehlende/veraltete Dev-Buendel-Pakete gebuendelt nach prod/dev und fuehrt Audit + Fix aus', async () => {
    const root = makeTempDir();
    const dataDir = path.join(root, 'data');
    const projDir = path.join(root, 'repo');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'package.json'), JSON.stringify({ name: 'repo', dependencies: {} }), 'utf-8');

    const cliCalls = [];
    const fakeJobs = makeFakeJobFactory();
    const projectObj = { id: 'p1', name: 'Repo', path: projDir, isAvailable: true };

    const actions = createDevActions({
      getProjectFn: (id) => (id === 'p1' ? projectObj : null),
      scanProjectFn: async () => ({
        success: true,
        project: projectObj,
        managers: ['npm'],
        installed: [{ manager: 'npm', name: 'zod', installedVersion: '3.24.0', scope: 'prod' }],
        dependencies: [],
        updates: [],
      }),
      createJobFn: fakeJobs.createJobFn,
      runManagerCliFn: async (manager, args, opts) => {
        cliCalls.push({ manager, args, cwd: opts.projectPath });
        if (args[0] === 'audit' && args[1] === '--json') {
          return {
            code: 1,
            stdout: JSON.stringify({
              auditReportVersion: 2,
              vulnerabilities: {
                tar: { name: 'tar', severity: 'high', via: [{ title: 'Path traversal' }], fixAvailable: true },
              },
            }),
            stderr: '',
          };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    const service = createDevBundlesService({
      getDataFolderFn: () => dataDir,
      getProjectFn: (id) => (id === 'p1' ? projectObj : null),
      scanProjectFn: async () => ({
        success: true,
        managers: ['npm'],
        installed: [{ manager: 'npm', name: 'zod', installedVersion: '3.24.0', scope: 'prod' }],
        updates: [],
      }),
      installPackagesBatchFn: actions.devInstallPackagesBatch,
      createJobFn: fakeJobs.createJobFn,
      randomUUIDFn: () => 'bundle-1',
    });

    service.saveDevBundle({
      name: 'JS Stack',
      manager: 'npm',
      packages: [
        { name: 'zod', isDev: false },
        { name: 'axios', isDev: false },
        { name: '@biomejs/biome', isDev: true },
        { name: 'typescript', isDev: true },
      ],
    });

    const installRes = await service.installDevBundleInProject('p1', 'bundle-1');
    assert.equal(installRes.success, true);
    assert.equal(installRes.installedCount, 3);
    assert.equal(installRes.skippedCount, 1);
    assert.deepEqual(
      cliCalls.map((c) => c.args),
      [
        ['install', 'axios'],
        ['install', '-D', '@biomejs/biome', 'typescript'],
      ]
    );

    const auditRes = await actions.devAuditProject('p1');
    assert.equal(auditRes.success, true);
    if (!('counts' in auditRes) || !('canAutoFix' in auditRes)) {
      assert.fail('Expected audit report payload');
    }
    assert.equal(auditRes.counts.high, 1);
    assert.equal(auditRes.canAutoFix, true);

    const fixRes = await actions.devAuditFixProject('p1', { manager: 'npm' });
    assert.equal(fixRes.success, true);
    assert.deepEqual(cliCalls[cliCalls.length - 1].args, ['audit', 'fix']);
  });

  it('erzeugt korrekte Batch- und Audit-Kommandos und schuetzt mutierende IPC-Kanaele', () => {
    const composerBatch = buildDevBatchInstallSteps({
      manager: 'composer',
      packages: [
        { name: 'monolog/monolog', version: '^3.0', isDev: false },
        { name: 'phpstan/phpstan', isDev: true },
        { name: 'laravel/pint', isDev: true },
      ],
    });
    assert.deepEqual(composerBatch.steps, [
      ['require', 'monolog/monolog:^3.0'],
      ['require', '--dev', 'phpstan/phpstan', 'laravel/pint'],
    ]);

    assert.deepEqual(buildDevAuditCommand('composer'), {
      supported: true,
      args: ['audit', '--format=json'],
      canAutoFix: true,
    });
    assert.deepEqual(buildDevAuditFixCommand('composer', ['symfony/http-kernel', 'bad pkg']), {
      supported: true,
      args: ['update', 'symfony/http-kernel', '--with-all-dependencies'],
    });

    for (const ch of [
      'dev-bundles-save',
      'dev-bundles-delete',
      'dev-bundles-duplicate',
      'dev-bundles-import',
      'dev-bundles-install',
      'dev-projects-audit-fix',
    ]) {
      assert.equal(isProtectedAdminChannel(ch), true, `${ch} must require admin auth`);
    }
    assert.equal(isProtectedAdminChannel('dev-bundles-load'), false);
    assert.equal(isProtectedAdminChannel('dev-projects-audit'), false);
  });
});
