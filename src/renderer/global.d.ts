import type { AgentlingPreloadApi } from "../preload";

declare global {
  interface Window {
    agentling: AgentlingPreloadApi;
  }
}

export {};
