// People screenshot and share scan reports. Commands in transcripts can carry API keys.
const SECRET = new RegExp(
  [
    '\\b(sk|pk|rk)[-_](live_|test_|proj-|ant-)?[A-Za-z0-9_-]{12,}',
    '\\bgh[pousr]_[A-Za-z0-9]{20,}',
    '\\bxox[abprs]-[A-Za-z0-9-]{10,}',
    '\\bAKIA[0-9A-Z]{16}',
    '\\bAIza[0-9A-Za-z_-]{30,}',
    '\\beyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]+\\.?[A-Za-z0-9_-]*',
    '(Bearer|token|Basic)\\s+[A-Za-z0-9._~+/=-]{16,}',
    '\\b\\w*(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH)\\w*=\\S+',
    '[a-f0-9]{32,}',
  ].join('|'),
  'gi',
);
export const redact = (s) => String(s).replace(SECRET, '[redacted]');
