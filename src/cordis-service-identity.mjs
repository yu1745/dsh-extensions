import { symbols } from '@deepseek-ai/cordis';

// Cordis creates fresh traceable proxies for service reads and service-valued
// method results. Compare their original implementations, not caller wrappers.
// Never compare names/markers: distinct preset revisions must stay distinct.
export function serviceIdentity(value) {
  const seen = new Set();
  while (value != null) {
    const original = value[symbols.original];
    if (original == null || original === value) break;
    if (seen.has(value)) throw new Error('Cyclic Cordis service identity');
    seen.add(value);
    value = original;
  }
  return value;
}

export function sameService(left, right) {
  return serviceIdentity(left) === serviceIdentity(right);
}
