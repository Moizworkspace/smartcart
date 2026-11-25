import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const avdName = 'SmartCart_Galaxy_S23_Ultra';
const deviceName = 'Galaxy S23 Ultra';
const activity = 'com.smartcart.preview/.MainActivity';
const launchPipe = '\\\\.\\pipe\\SmartCart.AndroidPreview';
const buildScript = fileURLToPath(new URL('./android-preview/build.ps1', import.meta.url));

function androidTools() {
  const localAndroid = join(process.env.LOCALAPPDATA, 'Android');
  const sdkRoot = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(localAndroid, 'Sdk')]
    .find(root => root && existsSync(join(root, 'emulator', 'emulator.exe')) &&
      existsSync(join(root, 'platform-tools', 'adb.exe')));
  if (!sdkRoot) throw new Error('Install Android Emulator and Platform-Tools in the Android SDK.');

  const avdHome = [process.env.ANDROID_AVD_HOME, join(localAndroid, 'avd'),
    join(process.env.ANDROID_USER_HOME || join(homedir(), '.android'), 'avd')]
    .find(directory => directory && existsSync(join(directory, avdName + '.ini')));
  if (!avdHome) throw new Error(`Create an Android 14 ${deviceName} virtual device named ${avdName}.`);

  return {
    adb: join(sdkRoot, 'platform-tools', 'adb.exe'),
    emulator: join(sdkRoot, 'emulator', 'emulator.exe'),
    env: { ...process.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot, ANDROID_AVD_HOME: avdHome },
  };
}

async function acquireLaunchLock() {
  const deadline = Date.now() + 180_000;
  while (true) {
    const lock = createServer(socket => socket.end());
    try {
      await new Promise((resolve, reject) => {
        lock.once('error', reject);
        lock.listen(launchPipe, () => {
          lock.removeListener('error', reject);
          resolve();
        });
      });
      return lock;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || Date.now() >= deadline) throw error;
      await delay(1_000);
    }
  }
}

async function findEmulator(adb) {
  const { stdout } = await adb(['devices']);
  for (const [, serial] of stdout.matchAll(/^(emulator-\d+)\s+\S+/gm)) {
    const result = await adb(['-s', serial, 'emu', 'avd', 'name']).catch(() => null);
    if (result?.stdout.split(/\r?\n/, 1)[0].trim() === avdName) return serial;
  }
}

function startEmulator({ emulator, env }, logFile) {
  const log = openSync(logFile, 'a');
  try {
    const child = spawn(emulator, ['-avd', avdName, '-gpu', 'host', '-feature', '-Vulkan',
      '-cores', '4', '-no-audio', '-no-snapshot', '-no-metrics'], {
      detached: true, stdio: ['ignore', log, log], env,
    });
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}

async function waitForAndroid(adb, serial, startupError) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    serial ??= await findEmulator(adb);
    if (serial) {
      const boot = await adb(['-s', serial, 'shell', 'getprop', 'sys.boot_completed']).catch(() => null);
      if (boot?.stdout.trim() === '1') {
        const version = await adb(['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk']);
        if (version.stdout.trim() !== '34') throw new Error(avdName + ' must run Android 14 (API 34).');
        return serial;
      }
    }
    const error = startupError();
    if (error) throw error;
    await delay(2_000);
  }
  throw new Error('Timed out waiting for ' + avdName + ' to boot.');
}

export async function openSmartCartOnAndroid(port) {
  if (process.platform !== 'win32') throw new Error('The SmartCart Android preview launcher requires Windows.');

  const previewDir = join(process.env.LOCALAPPDATA, 'SmartCart', 'AndroidPreview');
  const tools = androidTools();
  const adb = (args, timeout = 10_000) => exec(tools.adb, args, { timeout, windowsHide: true });
  const logFile = join(previewDir, 'emulator.log');
  const lock = await acquireLaunchLock();
  try {
    mkdirSync(previewDir, { recursive: true });
    console.log('Building the SmartCart Android preview.');
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', buildScript], { timeout: 120_000, windowsHide: true });
    const apk = join(previewDir, 'build', 'SmartCart-preview.apk');

    let startupError;
    const running = await findEmulator(adb);
    if (!running) {
      console.log(`Starting the ${deviceName} emulator (Android 14).`);
      const emulator = startEmulator(tools, logFile);
      emulator.once('error', error => { startupError = error; });
      emulator.once('exit', code => {
        startupError = new Error('The Android emulator closed (code ' + code + '). See ' + logFile);
      });
    }

    const serial = await waitForAndroid(adb, running, () => startupError);
    const install = await adb(['-s', serial, 'install', '--no-incremental', '-r', apk], 90_000);
    if (!/^Success\s*$/m.test(install.stdout)) throw new Error(install.stdout.trim());

    if (!running) {
      // Give Android's startup services time to finish before initializing WebView.
      await adb(['-s', serial, 'shell', 'am', 'wait-for-broadcast-idle'], 15_000).catch(() => {});
    }

    const launch = await adb(['-s', serial, 'shell', 'am', 'start', '-S', '-W', '-n', activity,
      '--ei', 'smartcartPort', String(port)], 45_000);
    if (!/^Status: ok\s*$/m.test(launch.stdout)) throw new Error(launch.stdout.trim() || launch.stderr.trim());
    console.log(`SmartCart is open on the ${deviceName} emulator (${serial}).`);
  } finally {
    lock.close();
  }
}
