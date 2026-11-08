// Test-only: keep the installer's work folder out of the real home on macOS.
// installerWorkDir() (installer/lib/platform.mjs) honours IRIS_INSTALLER_WORK_DIR on macOS,
// so a test that starts the server without `workDir` would otherwise append server.log to
// ~/Library/Application Support/IRIS-Installer. Windows ignores the variable (its tests are unchanged).
// Imported first by the test files that start servers; not a test file itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.IRIS_INSTALLER_WORK_DIR) {
  process.env.IRIS_INSTALLER_WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-test-work-'));
}
