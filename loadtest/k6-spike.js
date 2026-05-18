import http from 'k6/http';
import { check, sleep } from 'k6';

// Usage:
//   k6 run -e BASE_URL="http://YOUR_ALB_DNS" -e SHORT_CODE="abc123" loadtest/k6-spike.js
//
// Notes:
// - We hit /<short_code> which is served by the Python service and proxies to the Go redirect.
// - redirects: 0 avoids following the external long URL.

const BASE_URL = __ENV.BASE_URL;
const SHORT_CODE = __ENV.SHORT_CODE;

export const options = {
  stages: [
    { duration: '1m', target: 20 },
    { duration: '2m', target: 120 }, // spike
    { duration: '2m', target: 20 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
};

export default function () {
  if (!BASE_URL || !SHORT_CODE) {
    throw new Error('Missing BASE_URL or SHORT_CODE. Use -e BASE_URL=... -e SHORT_CODE=...');
  }

  const url = `${BASE_URL.replace(/\/$/, '')}/${SHORT_CODE}`;
  const res = http.get(url, { redirects: 0, timeout: '10s' });

  check(res, {
    'status is redirect': (r) => [301, 302, 307, 308].includes(r.status),
    'has Location header': (r) => !!r.headers.Location,
  });

  sleep(1);
}
