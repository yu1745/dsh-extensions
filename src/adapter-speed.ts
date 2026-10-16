import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { codexServiceOptions } from "./speed-context.js";
let users = 0;
let restore: (() => void) | undefined;
/** Supply model-hidden options at the pi-ai seam without rebuilding DSH profiles. */
export function snapshotWithSpeed(snapshot: any, options: any) {
  const extra = codexServiceOptions(options);
  if (!Object.keys(extra).length) return snapshot;
  const models = new Proxy(snapshot.models, {
    get(target, key) {
      if (key === "streamSimple")
        return (model: any, context: any, streamOptions: any) =>
          target.streamSimple(model, context, { ...streamOptions, ...extra });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...snapshot, models };
}
export function installAdapterSpeed() {
  if (users++ === 0) {
    const prototype: any = PiAiAdapter.prototype;
    const original = prototype.streamWithSnapshot;
    if (typeof original !== "function") {
      users--;
      throw new Error(
        "This DSH version cannot accept Codex service-tier options",
      );
    }
    const wrapped = function (this: any, options: any, snapshot: any) {
      return original.call(this, options, snapshotWithSpeed(snapshot, options));
    };
    prototype.streamWithSnapshot = wrapped;
    restore = () => {
      if (prototype.streamWithSnapshot === wrapped)
        prototype.streamWithSnapshot = original;
    };
  }
  return () => {
    if (--users === 0) {
      restore?.();
      restore = undefined;
    }
  };
}
