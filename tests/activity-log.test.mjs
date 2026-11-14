/**
 * Activity log tests: broadcast, persistence, rolling cap and clearing.
 *
 *   node tests/activity-log.test.mjs
 */
const storage = {};
const sent = [];

globalThis.chrome = {
  runtime: {
    sendMessage(message) {
      sent.push(message);
      return Promise.resolve();
    },
  },
  storage: {
    local: {
      async get(keys) {
        const out = {};
        for (const key of keys) if (key in storage) out[key] = storage[key];
        return out;
      },
      async set(values) {
        Object.assign(storage, values);
      },
      async remove(keys) {
        for (const key of keys) delete storage[key];
      },
    },
  },
};

const { logActivity, getActivityLog, getActivityLogClearedAt, clearActivityLog, redactIdentifier } = await import(
  '../background/activityLog.js'
);

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

check(
  'redact: jid phone digits masked',
  redactIdentifier('false_49171234567@c.us_ABC123') === 'false_#11@c.us_ABC#3',
  redactIdentifier('false_49171234567@c.us_ABC123')
);
check('redact: empty becomes unknown', redactIdentifier('') === 'unknown');
check(
  'redact: output bounded',
  redactIdentifier('x'.repeat(200)).length <= 65,
  String(redactIdentifier('x'.repeat(200)).length)
);

logActivity('info', 'Upload started.');
logActivity('error', 'Dropbox upload failed.');
logActivity('nonsense', 'Level normalized.');
await new Promise((resolve) => setTimeout(resolve, 30));

let log = await getActivityLog();
check('log: entries persisted', log.length === 3, String(log.length));
check('log: first entry', log[0].message === 'Upload started.' && log[0].level === 'info');
check('log: error level preserved', log[1].level === 'error', log[1].level);
check('log: unknown level becomes info', log[2].level === 'info', log[2].level);
check(
  'log: entries broadcast live',
  sent.filter((message) => message.type === 'ACTIVITY_LOG').length === 3,
  String(sent.length)
);

for (let i = 0; i < 205; i++) logActivity('info', `entry ${i}`);
await new Promise((resolve) => setTimeout(resolve, 120));
log = await getActivityLog();
check('log: rolling cap', log.length === 200, String(log.length));
check('log: oldest entries dropped', log[0].message === 'entry 5', log[0].message);
check('log: newest entry kept', log[199].message === 'entry 204', log[199].message);

await clearActivityLog();
log = await getActivityLog();
const clearedAt = await getActivityLogClearedAt();
check('log: cleared', log.length === 0, String(log.length));
check('log: storage removed', storage.activityLog === undefined, JSON.stringify(storage.activityLog));
check('log: clear timestamp stored', clearedAt > 0, String(clearedAt));

console.log(failures === 0 ? '\nALL ACTIVITY LOG CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
