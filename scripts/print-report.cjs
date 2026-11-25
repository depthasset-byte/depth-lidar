// 자동 검증 보고서(report.json) 요약 출력.
const r = require(require('node:path').resolve(process.argv[2]));
console.log(`passed ${r.passed} / ${r.total}  error: ${r.error}`);
for (const c of r.checks) console.log(c.pass ? 'OK  ' : 'FAIL', c.name, '-', c.detail);
for (const l of r.logs) if (!l.startsWith('[info]')) console.log(l);
process.exitCode = r.error || r.passed !== r.total ? 1 : 0;
