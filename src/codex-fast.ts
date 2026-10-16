import { installAdapterSpeed } from "./adapter-speed.js";
import {
  activateSpeedModes,
  inheritSpeed,
  setSpeed,
  speedOf,
} from "./speed-context.js";
export const name = "yu-codex-fast";
export const inject = ["commands"];
export function apply(ctx: any) {
  ctx.on("dispose", activateSpeedModes());
  ctx.on("dispose", installAdapterSpeed());
  ctx.on("session/created", (s: any) =>
    inheritSpeed(s.id, s.header.parentSession),
  );
  for (const mode of ["fast", "ultrafast"] as const)
    ctx.commands.register({
      name: mode,
      description: `切换当前会话 Codex ${mode} 模式`,
      async handler({ agent }: any) {
        const id = agent.session.id;
        const next = speedOf(id) === mode ? "standard" : mode;
        setSpeed(id, next);
        return {
          kind: "success",
          text: `Codex: ${next}。新建子代理将继承此设置。`,
        };
      },
    });
  ctx.commands.register({
    name: "codex-speed",
    description: "查看当前会话的 Codex 速度模式",
    handler: ({ agent }: any) => ({
      kind: "success",
      text: `Codex: ${speedOf(agent.session.id)}`,
    }),
  });
}
