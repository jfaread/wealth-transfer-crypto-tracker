import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {alertApiOrigin,applySiteCsp} from '../scripts/build-site.mjs';

test('only the dedicated backend origin can be added to the site policy',()=>{
 assert.equal(alertApiOrigin({version:1,apiBase:null}),null);
 assert.equal(alertApiOrigin({version:1,apiBase:'https://crypto-watch-alerts.example.workers.dev'}),'https://crypto-watch-alerts.example.workers.dev');
 for(const value of ['http://crypto-watch-alerts.example.workers.dev','https://evil.test','https://crypto-watch-alerts.example.workers.dev/extra','https://crypto-watch-alerts.example.workers.dev/?key=x','https://user@crypto-watch-alerts.example.workers.dev','https://crypto-watch-alerts.example.workers.dev:1234','https://crypto-watch-alerts.example.workers.dev/#x'])assert.throws(()=>alertApiOrigin({version:1,apiBase:value}));
});

test('build regenerates inline hashes and admits only required local PWA assets',()=>{
 const code='window.example = 1;';
 const html='<meta http-equiv="Content-Security-Policy" content="old"><script type="application/json">{}</script><script>'+code+'</script><script src="assets/alerts.js"></script>';
 const output=applySiteCsp(html,{version:1,apiBase:null});
 assert(output.includes("'sha256-"+createHash('sha256').update(code).digest('base64')+"'"));
 assert.equal((output.match(/sha256-/g)||[]).length,1);
 assert(output.includes("worker-src 'self'; manifest-src 'self'"));
 assert(!output.includes('workers.dev'));
 assert(!output.includes("script-src 'unsafe-inline'"));
 const active=applySiteCsp(html,{version:1,apiBase:'https://crypto-watch-alerts.example.workers.dev'});
 assert(active.includes('https://crypto-watch-alerts.example.workers.dev;'));
});
