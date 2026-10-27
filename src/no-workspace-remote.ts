import { z } from "zod";
import { createTypertRemoteInfo } from "@deepseek-ai/dsh-typert-protocol";

export const noWorkspaceRemoteInfo = createTypertRemoteInfo({
  package: "@yu1745/dsh-extensions/no-workspace",
  methods: {
    "yuNoWorkspace/base": {
      service: "yuNoWorkspace",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "@yu1745/dsh-extensions#NoWorkspaceBase",
        create: () => z.object({ directory: z.string() }),
      },
    },
    "yuNoWorkspace/create": {
      service: "yuNoWorkspace",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "@yu1745/dsh-extensions#NoWorkspaceResult",
        create: () => z.object({ workspaceId: z.string() }),
      },
    },
  },
});
