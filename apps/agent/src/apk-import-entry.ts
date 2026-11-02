import { importFromJob } from './apk-import.js';
importFromJob(process.argv[2] ?? '')
  .then((receipt) => console.log(JSON.stringify(receipt)))
  .catch(() => {
    console.error('APK_IMPORT_FAILED');
    process.exitCode = 1;
  });
