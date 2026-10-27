import { bootCheck } from './boot-check.js';
bootCheck(process.env.ANDROID_HOME ?? '/opt/apk-platform/android').then(
  () => console.log('BOOT_OK'),
  () => {
    console.error('ANDROID_NOT_READY');
    process.exitCode = 1;
  },
);
