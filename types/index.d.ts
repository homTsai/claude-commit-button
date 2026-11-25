export type Pending = { message: string }

declare module 'claude-code' {
  interface PluginState {
    'commit-button': { pending: Pending | null; isBusy: boolean }
  }
}
