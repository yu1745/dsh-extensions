// The two wrappers shipped in this bundle register their exact parent function.
// Unknown wrappers make remote snapshot capture fail closed; normal turns still
// use the complete Cordis adapter chain. Weak keys do not retain retired fibers.
const key = Symbol.for('@yu1745/dsh-extensions/trusted-adapter-wrappers');
const parents = globalThis[key] ??= new WeakMap();
export function registerAdapterWrapper(wrapper, parent) {
  if (typeof wrapper !== 'function' || typeof parent !== 'function' || wrapper === parent) throw new Error('Invalid adapter wrapper');
  parents.set(wrapper, parent);
}
export function nativeAdapterMethod(method) {
  const seen = new Set();
  while (typeof method === 'function' && parents.has(method)) {
    if (seen.has(method)) throw new Error('Circular adapter wrapper chain');
    seen.add(method); method = parents.get(method);
  }
  return method;
}
